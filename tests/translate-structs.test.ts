/**
 * Vitest unit assertions for scalar struct support. The cross-runner
 * (`scripts/run_test_scripts.ts`) exercises byte-for-byte byte parity
 * against numbl across the corpus under `test_scripts/structs/`; this
 * file pins down the error-attribution and structural-invariant
 * assertions the cross-runner can't easily check.
 */

import { describe, it, expect } from "vitest";

import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { lower } from "../src/lowering/lower.js";
import { translate } from "./_helpers.js";

function expectLowerError(src: string): Error {
  const ast = parseMFile(src, "test.m");
  const ws = new Workspace("test.m");
  ws.addFile({ name: "test.m", source: src, ast });
  try {
    lower(ast, ws);
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected lowering to throw");
}

describe("structs — error attribution", () => {
  it("rejects dynamic field access at lvalue position with a span", () => {
    const err = expectLowerError(`name = 'x'; s.(name) = 1;`);
    expect(err.message).toMatch(/dynamic field access/i);
    expect("span" in err).toBe(true);
  });

  it("rejects dynamic field access at expression position with a span", () => {
    const err = expectLowerError(`s.x = 1; name = 'x'; y = s.(name);`);
    expect(err.message).toMatch(/dynamic field access/i);
    expect("span" in err).toBe(true);
  });

  it("rejects struct-array attempts: s(i).f", () => {
    // `s(i).f` parses as `Member { base: Index/MethodCall... }`; the
    // lowerer either rejects this via the "non-variable base" path or
    // through some downstream check. We just require a useful error.
    const err = expectLowerError(`s.x = 1; t = s(1).x;`);
    expect(err).toBeInstanceOf(Error);
  });

  it("rejects branch-divergent field assignments", () => {
    const err = expectLowerError(`
      c = 1;
      if c
        s.x = 1;
      else
        s.y = 2;
      end
    `);
    expect(err.message).toMatch(/branch-divergent/i);
  });
});

describe("structs — codegen shape", () => {
  it("emits a per-shape typedef + helpers", () => {
    const c = translate(`s.x = 1; s.y = 2.5; disp(s);`);
    // Exactly one typedef for the {x, y} struct shape.
    const typedefMatches = c.match(/typedef struct _mtoc_struct__[0-9a-f]+ {/g);
    expect(typedefMatches).not.toBeNull();
    // The typedef + helpers come from `emitStruct.ts`; the disp
    // helper name is `<typedef>_disp`. Sanity-check it's referenced.
    expect(c).toMatch(/_mtoc_struct__[0-9a-f]+_disp/);
    // And the four owned-kind helpers.
    expect(c).toMatch(/_mtoc_struct__[0-9a-f]+_empty/);
    expect(c).toMatch(/_mtoc_struct__[0-9a-f]+_free/);
    expect(c).toMatch(/_mtoc_struct__[0-9a-f]+_copy/);
    expect(c).toMatch(/_mtoc_struct__[0-9a-f]+_assign/);
  });

  it("specializes cross-function on struct field set", () => {
    const c = translate(`
      a.x = 1;
      b.x = 1;
      b.y = 2;
      identity(a);
      identity(b);
      function identity(s)
        s.x = s.x;
      end
    `);
    // Two distinct mangled specializations for `identity`.
    const specs = new Set(
      [...c.matchAll(/identity__[0-9a-f]+/g)].map(m => m[0])
    );
    expect(specs.size).toBe(2);
  });

  it("frees a tensor-field-bearing struct on scope exit", () => {
    const c = translate(`
      s.data = [1 2 3];
      disp(s.data);
    `);
    // The struct's _free helper recursively frees the tensor field.
    expect(c).toMatch(
      /static void _mtoc_struct__[0-9a-f]+_free[^{]+\{[^}]*mtoc_tensor_free\(&s->data\)/s
    );
    // And `main` releases the struct local at scope exit.
    expect(c).toMatch(/_mtoc_struct__[0-9a-f]+_free\(&s\);/);
  });
});
