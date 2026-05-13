/**
 * Render an IR statement (or expression) back to numbl-style source
 * text. Used by the codegen to emit a `/* ... *\/` comment above each
 * emitted statement so a reader of the generated C can see the numbl
 * shape that produced each block.
 *
 * This is best-effort and stays simple — single-line, no whitespace
 * preservation, parens only where needed for precedence. The output
 * is purely informational; it never feeds back into compilation.
 */

import type { IRExpr, IRStmt, IndexSliceArg } from "../lowering/ir.js";
import { BinaryOperation, UnaryOperation } from "../parser/index.js";
import { precedence } from "./emitFormat.js";

const BIN_OP_NUMBL: Partial<Record<BinaryOperation, string>> = {
  Add: "+",
  Sub: "-",
  Mul: "*",
  Div: "/",
  ElemMul: ".*",
  ElemDiv: "./",
  LeftDiv: "\\",
  ElemLeftDiv: ".\\",
  Pow: "^",
  ElemPow: ".^",
  Equal: "==",
  NotEqual: "~=",
  Less: "<",
  LessEqual: "<=",
  Greater: ">",
  GreaterEqual: ">=",
  AndAnd: "&&",
  OrOr: "||",
  BitAnd: "&",
  BitOr: "|",
};

const UN_OP_NUMBL: Partial<Record<UnaryOperation, string>> = {
  Plus: "+",
  Minus: "-",
  Not: "~",
};

function numLit(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

function quoteString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteChar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderExpr(e: IRExpr, parentPrec = 0): string {
  switch (e.kind) {
    case "NumLit":
      return numLit(e.value);
    case "ImagLit":
      return e.value === 1 ? "1i" : `${numLit(e.value)}i`;
    case "StringLit":
      return quoteString(e.value);
    case "CharLit":
      return quoteChar(e.value);
    case "Var":
      return e.name;
    case "EndRef":
      return "end";
    case "TensorLit": {
      const rows = e.elements.map(row =>
        row.map(c => renderExpr(c, 0)).join(", ")
      );
      return `[${rows.join("; ")}]`;
    }
    case "Binary": {
      const op = BIN_OP_NUMBL[e.op] ?? e.op;
      const p = precedence(e.op);
      const inner = `${renderExpr(e.left, p)} ${op} ${renderExpr(e.right, p)}`;
      return p < parentPrec ? `(${inner})` : inner;
    }
    case "Unary": {
      const op = UN_OP_NUMBL[e.op];
      const p = precedence(e.op);
      if (op === undefined) {
        // Transpose / NonConjugateTranspose: postfix.
        const suffix = e.op === "Transpose" ? "'" : ".'";
        const inner = `${renderExpr(e.operand, p)}${suffix}`;
        return p < parentPrec ? `(${inner})` : inner;
      }
      const inner = `${op}${renderExpr(e.operand, p)}`;
      return p < parentPrec ? `(${inner})` : inner;
    }
    case "Call": {
      const args = e.args.map(a => renderExpr(a, 0)).join(", ");
      return `${e.name}(${args})`;
    }
    case "IndexLoad": {
      const args = e.indices.map(i => renderExpr(i, 0)).join(", ");
      return `${e.base.name}(${args})`;
    }
    case "IndexSlice":
      return `${e.base.name}(${e.index.map(renderSliceArg).join(", ")})`;
    case "MakeRange": {
      const start = renderExpr(e.start, 0);
      const end = renderExpr(e.end, 0);
      if (e.step.kind === "NumLit" && e.step.value === 1) {
        return `${start}:${end}`;
      }
      return `${start}:${renderExpr(e.step, 0)}:${end}`;
    }
    case "MemberLoad":
      return `${renderExpr(e.base, 0)}.${e.field}`;
    case "StructLit": {
      const pairs = e.fields
        .map(f => `'${f.name}', ${renderExpr(f.value, 0)}`)
        .join(", ");
      return `struct(${pairs})`;
    }
    case "HandleLit": {
      if (e.ty.kind !== "Handle") return "@?";
      const t = e.ty.target;
      if (t.kind === "userFunc" || t.kind === "builtin") return `@${t.name}`;
      return "@(...)";
    }
    case "HandleCaptureLoad":
      return `${renderExpr(e.base, 0)}.${e.captureName}`;
    case "CellLit": {
      const els = e.elements.map(el => renderExpr(el, 0)).join(", ");
      return `{${els}}`;
    }
    case "CellIndexLoad":
      return `${renderExpr(e.base, 0)}{${renderExpr(e.index, 0)}}`;
  }
}

function renderSliceArg(arg: IndexSliceArg): string {
  if (arg.kind === "Colon") return ":";
  if (arg.kind === "Scalar") return renderExpr(arg.expr, 0);
  const start = renderExpr(arg.start, 0);
  const end = renderExpr(arg.end, 0);
  if (arg.step.kind === "NumLit" && arg.step.value === 1) {
    return `${start}:${end}`;
  }
  return `${start}:${renderExpr(arg.step, 0)}:${end}`;
}

/** Render an IR statement as numbl-style source. Returns null for
 *  trivial kinds (`break`, `continue`) where the C output is already
 *  identical to the numbl form. */
export function renderStmt(s: IRStmt): string | null {
  switch (s.kind) {
    case "Assign":
      return `${s.name} = ${renderExpr(s.rhs, 0)}`;
    case "ExprStmt":
      return renderExpr(s.expr, 0);
    case "IndexStore": {
      const idx = s.indices.map(i => renderExpr(i, 0)).join(", ");
      return `${s.base.name}(${idx}) = ${renderExpr(s.rhs, 0)}`;
    }
    case "IndexSliceStore":
      return `${s.base.name}(${s.index.map(renderSliceArg).join(", ")}) = ${renderExpr(s.rhs, 0)}`;
    case "MemberStore":
      return `${s.base.name}.${s.fieldPath.join(".")} = ${renderExpr(s.rhs, 0)}`;
    case "CellIndexStore":
      return `${s.base.name}{${renderExpr(s.index, 0)}} = ${renderExpr(s.rhs, 0)}`;
    case "Disp":
      return `disp(${renderExpr(s.arg, 0)})`;
    case "Error":
      return `error(${renderExpr(s.arg, 0)})`;
    case "Assert":
      return s.msg === null
        ? `assert(${renderExpr(s.cond, 0)})`
        : `assert(${renderExpr(s.cond, 0)}, ${renderExpr(s.msg, 0)})`;
    case "Fprintf": {
      const parts = [
        renderExpr(s.fmt, 0),
        ...s.args.map(a => renderExpr(a, 0)),
      ];
      return `fprintf(${parts.join(", ")})`;
    }
    case "If":
      return `if ${renderExpr(s.cond, 0)}`;
    case "While":
      return `while ${renderExpr(s.cond, 0)}`;
    case "For": {
      const start = renderExpr(s.start, 0);
      const end = renderExpr(s.end, 0);
      const range =
        s.step.kind === "NumLit" && s.step.value === 1
          ? `${start}:${end}`
          : `${start}:${renderExpr(s.step, 0)}:${end}`;
      return `for ${s.var} = ${range}`;
    }
    case "Break":
    case "Continue":
      return null;
    case "ReturnFromFunction":
      return "return";
    case "MultiAssignCall": {
      const args = s.args.map(a => renderExpr(a, 0)).join(", ");
      if (s.outputs.length === 0) return `${s.name}(${args})`;
      const lhs = s.outputs
        .map(o => (o.binding === null ? "~" : o.binding.name))
        .join(", ");
      return `[${lhs}] = ${s.name}(${args})`;
    }
  }
}

/** Sanitize a rendered string so it can sit inside a `/* ... *\/` C
 *  comment without prematurely terminating it. The numbl lexer can't
 *  produce `*\/` as a token, but a string literal could carry it. */
export function sanitizeForBlockComment(s: string): string {
  return s.replace(/\*\//g, "* /");
}
