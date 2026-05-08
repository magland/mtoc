/**
 * Lowering pass — AST (from parser) → typed IR.
 *
 * Walks the AST, infers types, and rejects any construct outside the
 * currently supported subset by raising `UnsupportedConstruct`.
 *
 * Supported subset:
 *   - script body of plain assignments to scalar `double` variables
 *   - arithmetic / comparison / logical ops
 *   - if / elseif / else, while, for-with-range, break, continue
 *   - disp(expr), scalar math builtins (sqrt, abs, sin, …)
 *   - user-defined scalar functions with one output, specialized lazily
 *     on the (shape, elem) of the call-site argument types
 */

import { createHash } from "node:crypto";

import type {
  AbstractSyntaxTree,
  Expr,
  Span,
  Stmt,
  BinaryOperation as BinOp,
  UnaryOperation as UnOp,
} from "../parser/index.js";
import { offsetToLine } from "../parser/sourceLoc.js";
import { Workspace, type FunctionStmt } from "../workspace/workspace.js";
import { argShapeOf, getScalarBuiltin } from "../workspace/builtins.js";
import { getConstant } from "../workspace/constants.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr, IRFunction, IRProgram, IRStmt } from "./ir.js";
import {
  arithResult,
  canonicalizeType,
  isMultiElement,
  isScalar,
  isScalarReal,
  isTensor,
  isVector,
  joinSign,
  matrixDouble,
  MType,
  scalarDouble,
  SCALAR_DOUBLE,
  signFromValue,
  signIsNonneg,
  signIsPositive,
  signNegate,
  type Sign,
  typeToString,
  unify,
} from "./types.js";

const SUPPORTED_BIN_OPS: ReadonlySet<BinOp> = new Set([
  "Add",
  "Sub",
  "Mul",
  "Div",
  "Pow",
  "ElemMul",
  "ElemDiv",
  "ElemPow",
  "Equal",
  "NotEqual",
  "Less",
  "LessEqual",
  "Greater",
  "GreaterEqual",
  "AndAnd",
  "OrOr",
] as BinOp[]);

const COMPARISON_BIN_OPS: ReadonlySet<BinOp> = new Set([
  "Equal",
  "NotEqual",
  "Less",
  "LessEqual",
  "Greater",
  "GreaterEqual",
  "AndAnd",
  "OrOr",
] as BinOp[]);

const SUPPORTED_UN_OPS: ReadonlySet<UnOp> = new Set([
  "Plus",
  "Minus",
  "Not",
] as UnOp[]);

/** Map a parser BinaryOperation onto the abstract arith kind used by the
 *  type system's `arithResultScalar`. Returns null for non-arithmetic ops. */
function arithKindForOp(op: BinOp): "Add" | "Sub" | "Mul" | "Div" | null {
  switch (op) {
    case "Add":
      return "Add";
    case "Sub":
      return "Sub";
    case "Mul":
    case "ElemMul":
      return "Mul";
    case "Div":
    case "ElemDiv":
      return "Div";
    default:
      return null;
  }
}

/**
 * Build the C identifier for a specialization.
 *
 * Hashes the full canonicalized argument-type tuple (every field of
 * every type, including sign). Two calls with identical type tuples
 * produce the same hash and so land on the same specialization; any
 * difference — sign, shape, complex, future fields — produces a
 * different specialization with its own emitted C function.
 *
 * Body-level deduplication (collapsing two specializations whose
 * generated C is byte-identical) is a separate pass we'll add later;
 * for now each unique type tuple emits its own function.
 */
function mangleSpecName(matlabName: string, argTypes: MType[]): string {
  const canonical = JSON.stringify(argTypes.map(canonicalizeType));
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${matlabName}__${hash}`;
}

/** Module-level shared state: the function-specialization cache + ordered
 *  list, plus a stack of names currently being lowered (for cycle/recursion
 *  detection). Threaded into every `Lowerer` so script-scope and
 *  function-scope lowerers share specializations. */
interface SharedSpecState {
  workspace: Workspace;
  /** name → IRFunction. Names are mangled (see `mangleSpecName`). */
  cache: Map<string, IRFunction>;
  /** Specializations in the order they were first registered. */
  order: IRFunction[];
  /** Mangled names currently being lowered, used to reject recursion. */
  inFlight: Set<string>;
}

class Lowerer {
  /** Type lookup for in-scope identifiers. Includes params (function
   *  scope) and assigned vars (any scope). */
  private env = new Map<string, MType>();
  /** Vars assigned inside the current scope. EXCLUDES params — they are
   *  declared via the C function signature, not predeclared. */
  private assignedVars = new Map<string, MType>();
  /** Names of params for the current scope (function scope only). */
  private params: ReadonlySet<string>;
  /** Output variable for the current function scope, or null at script
   *  scope. Used to lower MATLAB `return` into `return <outputVar>;`. */
  private outputVar: string | null;

  constructor(
    private shared: SharedSpecState,
    paramBindings: Array<{ name: string; ty: MType }> = [],
    outputVar: string | null = null
  ) {
    this.params = new Set(paramBindings.map(p => p.name));
    for (const p of paramBindings) {
      this.env.set(p.name, p.ty);
    }
    this.outputVar = outputVar;
  }

  // ── Statements ────────────────────────────────────────────────────────

  lowerStmts(stmts: Stmt[]): IRStmt[] {
    const out: IRStmt[] = [];
    for (const s of stmts) {
      const lowered = this.lowerStmt(s);
      if (lowered) out.push(lowered);
    }
    return out;
  }

  getAssignedVars(): Map<string, MType> {
    return this.assignedVars;
  }

  envLookup(name: string): MType | undefined {
    return this.env.get(name);
  }

  private recordAssignment(name: string, ty: MType, span: Span): void {
    // env tracks the LATEST type at the current program point — sequential
    // assignment replaces, it does not unify with prior types.
    this.env.set(name, ty);
    // assignedVars is the union of every type the variable has held in
    // this scope. Codegen uses it to predeclare a single C variable that
    // can hold all observed types. When the union returns Unknown, the
    // two assignments can't share one C storage location — flag it at
    // the offending line.
    if (!this.params.has(name)) {
      const prev = this.assignedVars.get(name);
      const merged = prev ? unify(prev, ty) : ty;
      if (prev && merged.kind === "Unknown") {
        throw new TypeError(
          `'${name}' was previously ${typeToString(prev)} and is now being ` +
            `reassigned to ${typeToString(ty)}; mtoc cannot represent both in ` +
            `one C variable. Use a different name for the new value.`,
          span
        );
      }
      this.assignedVars.set(name, merged);
    }
  }

  /**
   * Merge the post-arm envs of a control-flow construct into a single
   * env representing the program point after the construct.
   *
   * For each variable that appears in ANY arm's env, we unify its type
   * across every arm. If an arm doesn't have the variable, that arm
   * fell through without assigning it — the runtime sees the predeclared
   * default (0.0 in our codegen), which has sign `zero`. So we unify
   * with `scalarDouble("zero")` for those arms.
   *
   * Used for if/elseif/else and as the "ran-once-or-never" merge for
   * while/for loops. Single-pass: doesn't iterate to fixpoint, so loops
   * whose body's sign-flow oscillates may keep a sound but imprecise
   * post-loop type. (Sufficient for the scalar lattice we have today.)
   */
  private mergeBranchEnvs(
    envs: ReadonlyArray<ReadonlyMap<string, MType>>,
    span: Span,
    construct: string
  ): Map<string, MType> {
    const ZERO = scalarDouble("zero");
    const result = new Map<string, MType>();
    const allKeys = new Set<string>();
    for (const e of envs) for (const k of e.keys()) allKeys.add(k);

    for (const k of allKeys) {
      let unified: MType | undefined;
      for (const e of envs) {
        const t = e.get(k) ?? ZERO;
        unified = unified ? unify(unified, t) : t;
      }
      if (unified?.kind === "Unknown") {
        // Different arms of the construct gave incompatible types for
        // this var. Report the distinct concrete types so the user can
        // see what conflicted.
        const distinct = [
          ...new Set(
            envs
              .map(e => e.get(k))
              .filter((t): t is MType => t !== undefined && t.kind !== "Unknown")
              .map(typeToString)
          ),
        ];
        throw new TypeError(
          `'${k}' is assigned incompatible types across the arms of this ` +
            `${construct}: ${distinct.join(" vs ")}.`,
          span
        );
      }
      if (unified) result.set(k, unified);
    }
    return result;
  }

  private lowerStmt(s: Stmt): IRStmt | null {
    switch (s.type) {
      case "Function":
        // Function declarations are pulled out of the script body before
        // statement-level lowering runs (see `lower()` below). Reaching
        // one here means it was nested somewhere we don't yet handle.
        throw new UnsupportedConstruct(
          `nested or non-top-level function definitions are not yet supported`,
          s.span
        );

      case "Assign": {
        const rhs = this.lowerExpr(s.expr);
        this.recordAssignment(s.name, rhs.ty, s.span);
        return {
          kind: "Assign",
          name: s.name,
          rhs,
          ty: rhs.ty,
          span: s.span,
        };
      }

      case "ExprStmt": {
        // Special-case `disp(arg)` at statement level so codegen can emit
        // a direct call to the runtime helper instead of a value-bearing
        // call.
        if (
          s.expr.type === "FuncCall" &&
          s.expr.name === "disp" &&
          s.expr.args.length === 1
        ) {
          const arg = this.lowerExpr(s.expr.args[0]);
          return { kind: "Disp", arg, span: s.span };
        }
        const expr = this.lowerExpr(s.expr);
        return { kind: "ExprStmt", expr, span: s.span };
      }

      case "If": {
        const cond = this.lowerExpr(s.cond);
        this.requireScalarReal(cond.ty, "if condition", s.span);

        const envBefore = new Map(this.env);

        // Then-arm: starts fresh from envBefore.
        this.env = new Map(envBefore);
        const thenBody = this.lowerStmts(s.thenBody);
        const envThen = new Map(this.env);

        // Each elseif arm: starts fresh from envBefore. The condition is
        // lowered inside the arm so any (future) refinement gets the
        // correct visibility scope.
        const elseifs: Array<{ cond: IRExpr; body: IRStmt[] }> = [];
        const envElseifs: Map<string, MType>[] = [];
        for (const b of s.elseifBlocks) {
          this.env = new Map(envBefore);
          const ec = this.lowerExpr(b.cond);
          this.requireScalarReal(ec.ty, "elseif condition", b.cond.span);
          const body = this.lowerStmts(b.body);
          elseifs.push({ cond: ec, body });
          envElseifs.push(new Map(this.env));
        }

        // Else-arm: starts from envBefore. Without an explicit `else`,
        // the "no arm ran" path's env is just envBefore.
        let elseBody: IRStmt[] | null = null;
        let envElse: Map<string, MType>;
        if (s.elseBody) {
          this.env = new Map(envBefore);
          elseBody = this.lowerStmts(s.elseBody);
          envElse = new Map(this.env);
        } else {
          envElse = envBefore;
        }

        this.env = this.mergeBranchEnvs(
          [envThen, ...envElseifs, envElse],
          s.span,
          "if"
        );

        return {
          kind: "If",
          cond,
          thenBody,
          elseifs,
          elseBody,
          span: s.span,
        };
      }

      case "While": {
        const envBefore = new Map(this.env);
        const cond = this.lowerExpr(s.cond);
        this.requireScalarReal(cond.ty, "while condition", s.span);
        const body = this.lowerStmts(s.body);
        // After the loop: either the body never ran (envBefore), or it
        // ran one+ times (current env). Single-pass merge — see
        // mergeBranchEnvs for the soundness note on oscillating loops.
        this.env = this.mergeBranchEnvs(
          [envBefore, new Map(this.env)],
          s.span,
          "while"
        );
        return { kind: "While", cond, body, span: s.span };
      }

      case "Break":
        return { kind: "Break", span: s.span };

      case "Continue":
        return { kind: "Continue", span: s.span };

      case "Return": {
        if (this.outputVar === null) {
          throw new UnsupportedConstruct(
            `'return' at script scope is not supported (only inside functions)`,
            s.span
          );
        }
        return {
          kind: "ReturnFromFunction",
          outputVar: this.outputVar,
          span: s.span,
        };
      }

      case "For": {
        if (s.expr.type !== "Range") {
          throw new UnsupportedConstruct(
            `for-loop iterables other than ranges are not yet supported`,
            s.span
          );
        }
        const start = this.lowerExpr(s.expr.start);
        const end = this.lowerExpr(s.expr.end);
        this.requireScalarReal(start.ty, "for-loop start", s.expr.start.span);
        this.requireScalarReal(end.ty, "for-loop end", s.expr.end.span);
        let step: IRExpr;
        if (s.expr.step) {
          step = this.lowerExpr(s.expr.step);
          this.requireScalarReal(step.ty, "for-loop step", s.expr.step.span);
          if (step.kind !== "NumLit") {
            throw new UnsupportedConstruct(
              `for-loop step must be a numeric literal (got expression)`,
              s.expr.step.span
            );
          }
          if (step.value === 0) {
            throw new UnsupportedConstruct(
              `for-loop step must be non-zero`,
              s.expr.step.span
            );
          }
        } else {
          step = {
            kind: "NumLit",
            value: 1,
            ty: SCALAR_DOUBLE,
            span: s.expr.span,
          };
        }
        // Refine the loop variable's sign when start + step have the
        // same direction. `for k = 1:n` ⇒ k positive; `for k = 0:n` ⇒
        // k nonneg; symmetric for negative-stride loops. Anything that
        // could cross zero falls back to unknown.
        const startSign = isTensor(start.ty) ? start.ty.sign : "unknown";
        let loopVarSign:
          | "positive"
          | "nonnegative"
          | "negative"
          | "nonpositive"
          | "unknown" = "unknown";
        if (step.value > 0) {
          if (signIsPositive(startSign)) loopVarSign = "positive";
          else if (signIsNonneg(startSign)) loopVarSign = "nonnegative";
        } else if (step.value < 0) {
          if (startSign === "negative") loopVarSign = "negative";
          else if (startSign === "nonpositive" || startSign === "zero") {
            loopVarSign = "nonpositive";
          }
        }
        // Snapshot before introducing the loop variable; after the
        // loop, the merge widens the loop var's type with `zero` so
        // the post-loop sign reflects "loop may not have run".
        const envBefore = new Map(this.env);
        this.recordAssignment(
          s.varName,
          scalarDouble(loopVarSign),
          s.span
        );
        const body = this.lowerStmts(s.body);
        this.env = this.mergeBranchEnvs(
          [envBefore, new Map(this.env)],
          s.span,
          "for"
        );
        return {
          kind: "For",
          var: s.varName,
          start,
          step,
          end,
          body,
          span: s.span,
        };
      }

      default:
        throw new UnsupportedConstruct(
          `unsupported statement: ${s.type}`,
          "span" in s ? s.span : null
        );
    }
  }

  private requireScalarReal(ty: MType, role: string, span: Span): void {
    if (!isScalarReal(ty)) {
      throw new UnsupportedConstruct(
        `${role} must be a real scalar (got ${typeToString(ty)})`,
        span
      );
    }
  }

  // ── Expressions ───────────────────────────────────────────────────────

  private lowerExpr(e: Expr): IRExpr {
    switch (e.type) {
      case "Number": {
        const n = Number(e.value);
        if (Number.isNaN(n)) {
          throw new UnsupportedConstruct(
            `cannot parse numeric literal '${e.value}'`,
            e.span
          );
        }
        return {
          kind: "NumLit",
          value: n,
          ty: scalarDouble(signFromValue(n)),
          span: e.span,
        };
      }

      case "Ident": {
        const ty = this.env.get(e.name);
        if (ty) {
          return { kind: "Var", name: e.name, ty, span: e.span };
        }
        const k = getConstant(e.name);
        if (k) {
          return {
            kind: "NumLit",
            value: k.value,
            ty: scalarDouble(k.sign),
            span: e.span,
          };
        }
        throw new TypeError(
          `use of undefined variable '${e.name}'`,
          e.span
        );
      }

      case "Binary": {
        if (!SUPPORTED_BIN_OPS.has(e.op)) {
          throw new UnsupportedConstruct(
            `binary operator ${e.op} is not yet supported`,
            e.span
          );
        }
        const left = this.lowerExpr(e.left);
        const right = this.lowerExpr(e.right);
        if (!isTensor(left.ty) || !isTensor(right.ty)) {
          throw new UnsupportedConstruct(
            `binary ${e.op} on ${typeToString(left.ty)} and ${typeToString(
              right.ty
            )} is not yet supported`,
            e.span
          );
        }

        // Comparisons/logical ops require scalar real operands today —
        // elementwise comparison on tensors needs its own codegen path.
        if (COMPARISON_BIN_OPS.has(e.op)) {
          if (!isScalarReal(left.ty) || !isScalarReal(right.ty)) {
            throw new UnsupportedConstruct(
              `comparison/logical ${e.op} on tensors is not yet supported`,
              e.span
            );
          }
          return {
            kind: "Binary",
            op: e.op,
            left,
            right,
            ty: scalarDouble("nonnegative"),
            span: e.span,
          };
        }

        // Arithmetic ops. Reject the matrix-only variants on
        // tensor⊙tensor (we don't have matrix multiply / divide /
        // power yet); the elementwise variants `.* ./ .^` are fine.
        const arithOp = arithKindForOp(e.op);
        if (!arithOp && e.op !== "Pow" && e.op !== "ElemPow") {
          throw new UnsupportedConstruct(
            `unsupported arith operator ${e.op}`,
            e.span
          );
        }
        const leftScalar = isScalar(left.ty);
        const rightScalar = isScalar(right.ty);
        const matrixOnly = e.op === "Mul" || e.op === "Div" || e.op === "Pow";
        if (!leftScalar && !rightScalar && matrixOnly) {
          throw new UnsupportedConstruct(
            `binary ${e.op} on two tensors is not yet supported ` +
              `(matrix multiply / divide / power need a separate ` +
              `codegen path; use .* ./ .^ for elementwise instead)`,
            e.span
          );
        }
        // Pow is currently scalar-only end-to-end (codegen emits pow()
        // inline). Reject any tensor operand for Pow/ElemPow until we
        // add tensor pow.
        if (e.op === "Pow" || e.op === "ElemPow") {
          if (!leftScalar || !rightScalar) {
            throw new UnsupportedConstruct(
              `binary ${e.op} on tensors is not yet supported`,
              e.span
            );
          }
        }

        let ty: MType;
        if (arithOp) {
          ty = arithResult(arithOp, left.ty, right.ty);
        } else {
          // Pow / ElemPow on two scalars — result is a scalar real.
          ty = scalarDouble("unknown");
        }
        // Structural square detection: `x*x` (same variable) is nonneg
        // regardless of x's sign. Applies for scalars and tensors.
        if (
          (e.op === "Mul" || e.op === "ElemMul") &&
          left.kind === "Var" &&
          right.kind === "Var" &&
          left.name === right.name &&
          isTensor(ty)
        ) {
          ty = { ...ty, sign: "nonnegative" };
        }
        if (ty.kind === "Unknown") {
          throw new UnsupportedConstruct(
            `binary ${e.op} on ${typeToString(left.ty)} and ${typeToString(
              right.ty
            )} produces an incompatible result type`,
            e.span
          );
        }
        return { kind: "Binary", op: e.op, left, right, ty, span: e.span };
      }

      case "Unary": {
        if (!SUPPORTED_UN_OPS.has(e.op)) {
          throw new UnsupportedConstruct(
            `unary operator ${e.op} is not yet supported`,
            e.span
          );
        }
        const operand = this.lowerExpr(e.operand);
        if (!isTensor(operand.ty) || operand.ty.isComplex) {
          throw new UnsupportedConstruct(
            `unary ${e.op} on ${typeToString(operand.ty)} is not yet supported`,
            e.span
          );
        }
        if (operand.kind === "NumLit") {
          if (e.op === "Plus") {
            return { ...operand, span: e.span };
          }
          if (e.op === "Minus") {
            const v = -operand.value;
            return {
              ...operand,
              value: v,
              ty: scalarDouble(signFromValue(v)),
              span: e.span,
            };
          }
          if (e.op === "Not") {
            return {
              kind: "NumLit",
              value: operand.value !== 0 ? 0 : 1,
              ty: scalarDouble("nonnegative"),
              span: e.span,
            };
          }
        }
        let ty: MType = operand.ty;
        if (isTensor(operand.ty)) {
          if (e.op === "Minus") {
            ty = { ...operand.ty, sign: signNegate(operand.ty.sign) };
          } else if (e.op === "Not") {
            ty = scalarDouble("nonnegative");
          }
        }
        return { kind: "Unary", op: e.op, operand, ty, span: e.span };
      }

      case "Tensor": {
        return this.lowerTensorLiteral(e);
      }

      case "FuncCall": {
        const target = this.shared.workspace.resolve(e.name);
        if (!target) {
          throw new UnsupportedConstruct(
            `unresolved function or builtin '${e.name}'`,
            e.span
          );
        }
        if (e.name === "disp") {
          throw new UnsupportedConstruct(
            `'disp' as a value-producing call is not supported`,
            e.span
          );
        }
        if (target.kind === "userFunction") {
          return this.lowerUserCall(e.name, e.args, e.span);
        }
        return this.lowerBuiltinCall(e.name, e.args, e.span);
      }

      default:
        throw new UnsupportedConstruct(
          `unsupported expression: ${e.type}`,
          "span" in e ? e.span : null
        );
    }
  }

  private lowerTensorLiteral(
    e: Extract<Expr, { type: "Tensor" }>
  ): IRExpr {
    if (e.rows.length === 0) {
      throw new UnsupportedConstruct(
        `empty tensor literal '[]' is not yet supported`,
        e.span
      );
    }
    const numRows = e.rows.length;
    const numCols = e.rows[0].length;
    if (numCols === 0) {
      throw new UnsupportedConstruct(
        `tensor literal with zero-length row is not yet supported`,
        e.span
      );
    }
    const elements: IRExpr[][] = [];
    const elementSigns: Sign[] = [];
    for (let r = 0; r < numRows; r++) {
      const row = e.rows[r];
      if (row.length !== numCols) {
        throw new TypeError(
          `tensor literal has rows of different lengths ` +
            `(row 1 has ${numCols}, row ${r + 1} has ${row.length})`,
          e.span
        );
      }
      const loweredRow: IRExpr[] = [];
      for (const cell of row) {
        const ir = this.lowerExpr(cell);
        if (!isScalarReal(ir.ty)) {
          throw new UnsupportedConstruct(
            `tensor literal elements must be real scalars today ` +
              `(got ${typeToString(ir.ty)}); nested tensors and ` +
              `concatenation are not yet supported`,
            cell.span
          );
        }
        loweredRow.push(ir);
        if (isTensor(ir.ty)) elementSigns.push(ir.ty.sign);
      }
      elements.push(loweredRow);
    }
    // Sign of the literal: the join of every element's sign.
    let sign: Sign = elementSigns[0];
    for (let i = 1; i < elementSigns.length; i++) {
      sign = joinSign(sign, elementSigns[i]);
    }
    const ty = matrixDouble(numRows, numCols, sign);
    return { kind: "TensorLit", elements, ty, span: e.span };
  }

  private lowerBuiltinCall(name: string, argExprs: Expr[], span: Span): IRExpr {
    const builtin = getScalarBuiltin(name);
    if (!builtin) {
      throw new UnsupportedConstruct(
        `builtin '${name}' is not yet supported`,
        span
      );
    }
    if (argExprs.length !== builtin.arity) {
      throw new UnsupportedConstruct(
        `${name} expects ${builtin.arity} argument(s), got ${argExprs.length}`,
        span
      );
    }
    const args = argExprs.map(a => this.lowerExpr(a));
    // Per-arg shape validation: scalar / vector / tensor. The default
    // is scalar (matches every legacy builtin entry).
    for (let i = 0; i < args.length; i++) {
      const shape = argShapeOf(builtin, i);
      const argTy = args[i].ty;
      const argLabel = builtin.arity === 1 ? "x" : `arg ${i + 1}`;
      if (shape === "scalar") {
        if (!isScalarReal(argTy)) {
          throw new UnsupportedConstruct(
            `${name} ${argLabel} must be a real scalar ` +
              `(got ${typeToString(argTy)})`,
            args[i].span
          );
        }
      } else if (shape === "vector") {
        if (!isVector(argTy)) {
          throw new UnsupportedConstruct(
            `${name} ${argLabel} must be a vector ` +
              `(got ${typeToString(argTy)})`,
            args[i].span
          );
        }
      } else if (shape === "tensor") {
        if (!isMultiElement(argTy)) {
          throw new UnsupportedConstruct(
            `${name} ${argLabel} must be a non-scalar tensor ` +
              `(got ${typeToString(argTy)})`,
            args[i].span
          );
        }
      }
    }
    // Sign-domain validation — applies in any shape.
    for (let i = 0; i < args.length; i++) {
      const dom = builtin.argDomains[i];
      if (!dom) continue;
      const argTy = args[i].ty;
      const argSign = isTensor(argTy) ? argTy.sign : "unknown";
      const ok =
        dom === "nonnegative"
          ? signIsNonneg(argSign)
          : signIsPositive(argSign);
      if (!ok) {
        const argLabel = builtin.arity === 1 ? "x" : `arg ${i + 1}`;
        throw new TypeError(
          `${name} requires ${argLabel} to be statically ${dom} ` +
            `(got sign='${argSign}'). ` +
            `Use abs(...) or restructure the expression.`,
          span
        );
      }
    }
    let resultSign: Sign;
    if (builtin.resultSign === "preserve") {
      const argTy = args[0].ty;
      resultSign = isTensor(argTy) ? argTy.sign : "unknown";
    } else {
      resultSign = builtin.resultSign;
    }
    return {
      kind: "Call",
      name,
      cFunc: builtin.cFunc,
      args,
      ty: scalarDouble(resultSign),
      span,
    };
  }

  private lowerUserCall(name: string, argExprs: Expr[], span: Span): IRExpr {
    const fnAst = this.shared.workspace.localFunctions.get(name);
    if (!fnAst) {
      throw new UnsupportedConstruct(
        `internal: workspace claimed '${name}' is a user function but no AST is registered`,
        span
      );
    }
    if (fnAst.outputs.length !== 1) {
      throw new UnsupportedConstruct(
        `function '${name}' must have exactly one output (got ${fnAst.outputs.length})`,
        span
      );
    }
    if (argExprs.length !== fnAst.params.length) {
      throw new TypeError(
        `function '${name}' expects ${fnAst.params.length} argument(s), got ${argExprs.length}`,
        span
      );
    }
    const args = argExprs.map(a => this.lowerExpr(a));
    for (const a of args) {
      if (!isScalarReal(a.ty)) {
        throw new UnsupportedConstruct(
          `function '${name}' currently only accepts real-scalar arguments ` +
            `(got ${typeToString(a.ty)})`,
          a.span
        );
      }
    }
    const argTypes = args.map(a => a.ty);
    const mangledName = mangleSpecName(name, argTypes);

    let spec = this.shared.cache.get(mangledName);
    if (!spec) {
      if (this.shared.inFlight.has(mangledName)) {
        throw new UnsupportedConstruct(
          `recursive call to '${name}' is not yet supported`,
          span
        );
      }
      spec = this.specialize(name, fnAst, argTypes, mangledName);
    }
    return {
      kind: "Call",
      name,
      cFunc: mangledName,
      args,
      ty: spec.returnTy,
      span,
    };
  }

  /** Lower a function body for a specific argument type signature.
   *  Each unique type tuple gets its own specialization (and its own
   *  emitted C function), so the body sees params bound to the actual
   *  call-site type — including sign. Sign-sensitive ops like
   *  `sqrt(x)` then resolve at the call site that introduced the
   *  type. */
  private specialize(
    matlabName: string,
    fnAst: FunctionStmt,
    argTypes: MType[],
    mangledName: string
  ): IRFunction {
    this.shared.inFlight.add(mangledName);
    try {
      const paramBindings = fnAst.params.map((p, i) => ({
        name: p,
        ty: argTypes[i],
      }));
      const inner = new Lowerer(
        this.shared,
        paramBindings,
        fnAst.outputs[0]
      );
      const body = inner.lowerStmts(fnAst.body);
      const outputName = fnAst.outputs[0];
      const returnTy = inner.envLookup(outputName);
      if (!returnTy) {
        throw new TypeError(
          `function '${matlabName}' did not assign its output variable '${outputName}' on any path`,
          fnAst.span
        );
      }
      if (!isScalarReal(returnTy)) {
        throw new UnsupportedConstruct(
          `function '${matlabName}' must return a real scalar ` +
            `(got ${typeToString(returnTy)})`,
          fnAst.span
        );
      }
      const file = fnAst.span.file;
      const source = this.shared.workspace.files.get(file)?.source ?? "";
      const sourceLocation = {
        file,
        startLine: offsetToLine(source, fnAst.span.start),
        endLine: offsetToLine(source, fnAst.span.end),
      };
      const spec: IRFunction = {
        mangledName,
        matlabName,
        params: paramBindings,
        outputVar: outputName,
        returnTy,
        assignedVars: inner.getAssignedVars(),
        body,
        span: fnAst.span,
        sourceLocation,
      };
      this.shared.cache.set(mangledName, spec);
      this.shared.order.push(spec);
      return spec;
    } finally {
      this.shared.inFlight.delete(mangledName);
    }
  }
}

export function lower(
  ast: AbstractSyntaxTree,
  workspace: Workspace
): IRProgram {
  // Pull function definitions out of the top-level script body. They
  // become entries in the workspace's local-function table; the
  // remaining stmts are the script body.
  const scriptBody: Stmt[] = [];
  for (const s of ast.body) {
    if (s.type === "Function") {
      workspace.registerLocalFunction(s);
    } else {
      scriptBody.push(s);
    }
  }

  const shared: SharedSpecState = {
    workspace,
    cache: new Map(),
    order: [],
    inFlight: new Set(),
  };
  const top = new Lowerer(shared);
  const stmts = top.lowerStmts(scriptBody);
  return {
    assignedVars: top.getAssignedVars(),
    functions: shared.order,
    stmts,
  };
}
