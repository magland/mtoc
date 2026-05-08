# Builtins

The builtin registry is the typed-signature DSL in `src/workspace/builtins.ts`.
Each entry is a `BuiltinSig` value that owns its own type rule and its own
codegen.

## Anatomy

```
BuiltinSig {
  name        // numbl name, e.g. "sqrt"
  category    // "expr" | "stmt"
  params      // ParamConstraint[] — one per arg
  result      // (argTys: MType[]) => MType
  emit        // (argStrs: string[], state) => string  (the C call)
}
```

A `ParamConstraint` carries `shape` (`scalar` / `vector` / `tensor` / `any`),
`domain` (`nonnegative` / `positive` / `null`), and `elem` (currently
`"double"` or `null`). The lowerer reads `params[i].shape`/`.domain` to validate
each argument; on violation it raises a `TypeError` or `UnsupportedConstruct`
with a span pointing at that argument.

`result` and `emit` are first-class closures — there is no magic-string
indirection. A reduction like `sum` whose result sign tracks its argument's
sign is just `result: ([t]) => scalarDouble(isTensor(t) ? t.sign : "unknown")`.
Codegen for any builtin is whatever `emit` returns.

## Factories

A few factory helpers in `builtins.ts` keep entries terse for the common
patterns:

- **`libm(name, arity, cName, resultSign, domains)`** — scalar libm function
  call (`sqrt`, `cos`, `pow`, …). Activates `<math.h>`.
- **`runtime(name, arity, helperName, resultSign, domains)`** — call to a
  runtime helper (`mtoc_mod`, `mtoc_sign`, …). Activates the helper snippet
  via the runtime registry.
- **`reduceVector(name, helperName, signFromArg)`** — vector → scalar reduction
  (`sum`). Sign computed from the arg.
- **`reduceTensor(name, helperName, resultSign, domains)`** — tensor → scalar
  introspection (`length`, `numel`).

Most new builtins fit one of these. Adding a new factory is appropriate when
several entries share a non-trivial closure shape.

## Categories

- **`expr` builtins** lower to `IRExpr.Call` and end up in the value position
  of an expression. The vast majority.
- **`stmt` builtins** are accepted at statement position only. Today only
  `disp` is in this group. Lowering routes `ExprStmt(disp(x))` into
  `IRStmt.Disp` directly; the registry entry exists so `Workspace.resolve`
  has a single lookup path.

## Codegen interaction

Every `IRExpr.Call` carries a `callee: CallTarget` discriminator
(`libm` / `runtime` / `userFunc`). The factory closure decides which variant
to set when the call lowers. Codegen reads `callee.kind` and emits the C
identifier directly — no map lookup.

The `emit` closure receives a small `BuiltinEmitState` view onto the codegen
state: a boxed `needMath` flag and a `useRuntime(name)` activator. A factory
that wraps a libm name flips `needMath = true` and emits
`` `${cName}(${args.join(", ")})` ``; a runtime-helper factory additionally
calls `useRuntime("mtoc_mod")` (or whichever helper).

## Adding one

The common path:

1. If the C side is a libm function, add a factory call:
   `libm("acosh", 1, "acosh", "unknown", ["positive"])`.
2. If the C side is a new runtime helper:
   - Drop a `.h` file under `src/codegen/runtime/` (see `runtime.md`).
   - Add it to the runtime registry with any dependencies it needs.
   - Add a `runtime("foo", 1, "mtoc_foo", …)` registry entry here.
3. If the type rule is exotic (e.g. result type depends on the arg shape),
   write the entry by hand with a custom `result` and `emit`. Document the
   rule in a code comment near the entry.

That's it — the registry is the single source of truth for builtin behavior.
The lowerer and codegen consume it generically.

## Caveats

- The shape constraint `"any"` exists but is rarely used. Today only `disp`
  uses it (its dispatch on scalar-vs-tensor lives in the `IRStmt.Disp` codegen,
  not in the `emit` closure).
- A future "tensor-returning" builtin (matrix `sum`, `min(tensor)` returning
  scalar of arg's elem, etc.) doesn't need a DSL change — its `result` returns
  a multi-element `TensorType` and its `emit` is responsible for materializing
  the result. Today no such builtin exists; the path is open when one does.
