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
      /** Imaginary literal — the complex number `0 + value*i`. Produced
       *  by lowering when the AST exposes either a bare `ImagUnit` (i.e.
       *  the implicit `1i`) or a `Binary(Mul, NumLit, ImagUnit)` (i.e.
       *  `<NumLit>i` such as `2.5i`). The real-coefficient case folds
       *  here so codegen never has to recognize the binary form, and
       *  `arithResult(Add, real, complex)` cleanly produces the
       *  complex sum for `3 + 4i`. `ty` is always a complex scalar. */
      kind: "ImagLit";
      value: number;
      ty: MType;
      span: Span;
    }
  | {
      /** Double-quoted string literal `"..."`. `value` is the decoded
       *  string contents (quotes stripped, doubled-quote escapes
       *  collapsed). Codegen lowers this to
       *  `mtoc_string_from_literal("...", N)` — a non-owning handle
       *  pointing at the C string constant in `.rodata` (cheap; no
       *  allocation). The owned-flag mtoc_string_t convention means
       *  passing literals through builtins like `disp` doesn't need
       *  freeing. `ty` is always `STRING`. */
      kind: "StringLit";
      value: string;
      ty: MType;
      span: Span;
    }
  | {
      /** Single-quoted char literal `'...'`. `value` is the decoded
       *  content (quotes stripped, doubled-quote `''` collapsed).
       *  Codegen maps this to:
       *    - a C `char` literal (e.g. `'a'`) for 1×1 scalar chars, or
       *    - `mtoc_char_tensor_from_literal("abc", N)` for 1×N arrays,
       *      which is a non-owning handle pointing at the string
       *      constant in `.rodata`.
       *  `ty` is a `NumericType` with `elem: "char"`. Scalar chars have
       *  rows=one, cols=one; arrays have rows=one, cols=notOne. */
      kind: "CharLit";
      value: string;
      ty: MType;
      span: Span;
    }
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
      /** `error(s)` — raises a runtime error with the given string
       *  message. Statement-only (numbl's `error` never returns).
       *  Codegen emits `mtoc_error_string(<arg>);` which prints
       *  to stderr and aborts. Lowering accepts a `StringLit` or
       *  string `Var` as the argument; nested string expressions
       *  must be assigned to a name first. */
      kind: "Error";
      arg: IRExpr;
      span: Span;
    }
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
   *  C identifier — one entry per emitted C variable. A single MATLAB
   *  name may produce multiple entries when the lowerer splits an
   *  incompatible reassignment (see `Lowerer.recordAssignment`). */
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
   *  the top of main(). Keyed by C identifier — see the same field on
   *  `IRFunction` for why a single MATLAB name can map to several
   *  entries. */
  assignedVars: Map<string, VarBinding>;
  /** User-function specializations, in lowering order. Emitted before
   *  `main()` in the C output. */
  functions: IRFunction[];
  stmts: IRStmt[];
}
