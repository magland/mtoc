/**
 * Typed intermediate representation (IR).
 *
 * Mirrors the subset of the AST that mtoc supports today. Every IRExpr
 * carries the inferred MType so codegen can dispatch on type without
 * rerunning inference.
 */

import type { Span, BinaryOperation, UnaryOperation } from "../parser/index.js";
import type { MType } from "./types.js";

export type IRExpr =
  | { kind: "NumLit"; value: number; ty: MType; span: Span }
  | { kind: "Var"; name: string; ty: MType; span: Span }
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
      /** Function call — covers both builtins (cFunc is a libm or runtime
       *  helper name) and user-defined scalar functions (cFunc is the
       *  mangled specialization name). */
      kind: "Call";
      /** MATLAB name (for diagnostics). */
      name: string;
      /** C identifier the codegen emits. */
      cFunc: string;
      args: IRExpr[];
      ty: MType;
      span: Span;
    };

export type IRStmt =
  | {
      kind: "Assign";
      name: string;
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
      var: string;
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
   *  inside a function scope. Codegen turns it into `return <output>;`. */
  | { kind: "ReturnFromFunction"; outputVar: string; span: Span };

/** A single specialization of a user-defined function, ready for codegen. */
export interface IRFunction {
  /** Mangled C identifier (e.g. "sq__d"). */
  mangledName: string;
  /** MATLAB-source name (for diagnostics). */
  matlabName: string;
  params: { name: string; ty: MType }[];
  /** Name of the output variable. Codegen emits `return <outputVar>;`. */
  outputVar: string;
  returnTy: MType;
  /** Locals declared inside the body (excluding params). */
  assignedVars: Map<string, MType>;
  body: IRStmt[];
  span: Span;
  /** 1-based line range of the original `function … end` block. Codegen
   *  uses this in the header comment so generated C points back to the
   *  source. */
  sourceLocation: { file: string; startLine: number; endLine: number };
}

export interface IRProgram {
  /** Variables assigned anywhere in the program (with their inferred type).
   *  Codegen uses this to predeclare them at the top of main(). */
  assignedVars: Map<string, MType>;
  /** User-function specializations, in lowering order. Emitted before
   *  `main()` in the C output. */
  functions: IRFunction[];
  stmts: IRStmt[];
}
