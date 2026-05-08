/**
 * Typed intermediate representation (IR).
 *
 * Mirrors the subset of the AST that mtoc supports today. Every IRExpr
 * carries the inferred MType so codegen can dispatch on type without
 * rerunning inference.
 */

import type { Span, BinaryOperation, UnaryOperation } from "../parser/index.js";
import type { BuiltinSig } from "../workspace/builtins.js";
import type { MType } from "./types.js";

export type IRExpr =
  | { kind: "NumLit"; value: number; ty: MType; span: Span }
  | {
      kind: "Var";
      /** MATLAB name (for diagnostics and assignedVars lookups). */
      name: string;
      /** C identifier the codegen emits for this variable. Computed
       *  once during lowering (see `cNameFor`) so emit.ts never has to
       *  re-mangle. */
      cName: string;
      ty: MType;
      span: Span;
    }
  | {
      /** Tensor literal `[a b c; d e f]`. Elements are stored in
       *  row-major nested arrays mirroring the source syntax; codegen
       *  re-orders to column-major when writing to memory. Every
       *  element must lower to a real scalar (no nested tensors yet). */
      kind: "TensorLit";
      elements: IRExpr[][];
      ty: MType;
      span: Span;
    }
  | {
      kind: "Binary";
      op: BinaryOperation;
      left: IRExpr;
      right: IRExpr;
      ty: MType;
      span: Span;
    }
  | {
      kind: "Unary";
      op: UnaryOperation;
      operand: IRExpr;
      ty: MType;
      span: Span;
    }
  | {
      /** Function call — covers builtins (libm scalar math and mtoc
       *  runtime helpers) and user-defined scalar functions. The `callee`
       *  variant tells codegen which header / runtime snippet to pull
       *  in (libm needs `<math.h>`, runtime helpers self-activate, user
       *  funcs need no extra activation). */
      kind: "Call";
      /** MATLAB name (for diagnostics). */
      name: string;
      callee: CallTarget;
      args: IRExpr[];
      ty: MType;
      span: Span;
    };

/** Discriminator on a `Call`'s C-side target. Codegen consumes this
 *  directly — builtin calls hold a reference to the typed
 *  `BuiltinSig` (whose `emit` closure activates any runtime helper
 *  it needs and renders the C expression); user-function calls hold
 *  the mangled specialization name. */
export type CallTarget =
  | { kind: "builtin"; sig: BuiltinSig }
  | { kind: "userFunc"; mangled: string };

export type IRStmt =
  | {
      /** `<name> = <rhs>`. The RHS may be:
       *    - a scalar expression (codegen emits `<cName> = <expr>;`),
       *    - a `TensorLit` (codegen writes literal values into the
       *      slots of `<cName>.real[idx]` directly),
       *    - any other multi-element expression (codegen emits a
       *      per-element loop over `numel(rhs.ty)` slots, evaluating
       *      the body once per slot with multi-element `Var`s reading
       *      `<varCName>.real[<iter>]`).
       *  All three paths use the same `Assign` node — codegen
       *  dispatches on `rhs.kind` and `rhs.ty`'s shape. */
      kind: "Assign";
      /** numbl target name (for diagnostics and assignedVars lookup). */
      name: string;
      /** Pre-mangled C identifier of the target. */
      cName: string;
      rhs: IRExpr;
      ty: MType;
      span: Span;
    }
  | { kind: "ExprStmt"; expr: IRExpr; span: Span }
  | { kind: "Disp"; arg: IRExpr; span: Span }
  | {
      kind: "If";
      cond: IRExpr;
      thenBody: IRStmt[];
      elseifs: Array<{ cond: IRExpr; body: IRStmt[] }>;
      elseBody: IRStmt[] | null;
      span: Span;
    }
  | {
      kind: "For";
      /** MATLAB loop-variable name (for diagnostics). */
      var: string;
      /** C identifier for the loop variable's storage. */
      cVar: string;
      start: IRExpr;
      step: IRExpr;
      end: IRExpr;
      body: IRStmt[];
      span: Span;
    }
  | {
      kind: "While";
      cond: IRExpr;
      body: IRStmt[];
      span: Span;
    }
  | { kind: "Break"; span: Span }
  | { kind: "Continue"; span: Span }
  /** MATLAB `return` inside a function — emitted by lowering only when
   *  inside a function scope. Codegen turns it into `return <outputCName>;`. */
  | { kind: "ReturnFromFunction"; outputCName: string; span: Span };

/** A predeclared variable: its inferred type plus the C identifier the
 *  codegen will emit. Computed once during lowering so emit.ts never
 *  has to re-mangle. */
export interface VarBinding {
  ty: MType;
  cName: string;
}

/** A single specialization of a user-defined function, ready for codegen. */
export interface IRFunction {
  /** Mangled C identifier (e.g. "sq__d"). */
  mangledName: string;
  /** MATLAB-source name (for diagnostics). */
  matlabName: string;
  params: { name: string; cName: string; ty: MType }[];
  /** MATLAB name of the output variable (for diagnostics). */
  outputVar: string;
  /** C identifier of the output variable. Codegen emits
   *  `return <outputCName>;` at the bottom of the function body. */
  outputCName: string;
  returnTy: MType;
  /** Locals declared inside the body (excluding params). Keyed by
   *  MATLAB name; each entry carries the C identifier the codegen
   *  emits for that variable's storage. */
  assignedVars: Map<string, VarBinding>;
  body: IRStmt[];
  span: Span;
  /** 1-based line range of the original `function … end` block. Codegen
   *  uses this in the header comment so generated C points back to the
   *  source. */
  sourceLocation: { file: string; startLine: number; endLine: number };
}

export interface IRProgram {
  /** Variables assigned anywhere in the program (with their inferred
   *  type and C identifier). Codegen uses this to predeclare them at
   *  the top of main(). */
  assignedVars: Map<string, VarBinding>;
  /** User-function specializations, in lowering order. Emitted before
   *  `main()` in the C output. */
  functions: IRFunction[];
  stmts: IRStmt[];
}
