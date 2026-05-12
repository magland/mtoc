import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";
import { buildCcArgs } from "../src/build.js";

/**
 * Tests for the `threads` build option (parallel-loops codegen).
 *
 * The option controls three coordinated outputs:
 *   1. Whether `#pragma omp parallel for` lines are emitted above the
 *      flat-iter and broadcast elementwise loops.
 *   2. Whether `#include <omp.h>` is added to the output.
 *   3. Whether `omp_set_num_threads(N)` is called at main's startup
 *      (only when threads is a concrete number `>= 2`; `"auto"` skips
 *      the call so OpenMP picks the count itself).
 * Plus a build-flag side effect: `buildCcArgs` adds `-fopenmp` to the
 * compile argv iff the threads option is non-serial.
 *
 * The default (threads omitted or set to `1`) is "pure serial": no
 * pragmas, no `<omp.h>`, no `omp_set_num_threads` call, no `-fopenmp`
 * on the link — emitted C is bit-identical to today's serial output.
 */

describe("threads build option", () => {
  describe("default / threads=1 (serial)", () => {
    const SRC = "a = ones(3, 4);\nb = a + 1;\ndisp(b);\n";

    it("emits no `#pragma omp` lines by default", () => {
      const c = translate(SRC);
      expect(c).not.toMatch(/#pragma\s+omp/);
    });

    it("emits no `<omp.h>` include by default", () => {
      const c = translate(SRC);
      expect(c).not.toContain("<omp.h>");
    });

    it("emits no `omp_set_num_threads` call by default", () => {
      const c = translate(SRC);
      expect(c).not.toContain("omp_set_num_threads");
    });

    it("threads=1 is byte-identical to omitting the option", () => {
      // The "no-op default" promise: explicit 1 and omitted produce
      // exactly the same C. This is the property that lets us roll
      // the feature in without disturbing any existing test snapshot.
      const omitted = translate(SRC);
      const explicit = translate(SRC, { threads: 1 });
      expect(explicit).toBe(omitted);
    });

    it("buildCcArgs omits -fopenmp when threads is unset or 1", () => {
      const noOpt = buildCcArgs("in.c", "out.exe");
      const explicit1 = buildCcArgs("in.c", "out.exe", { threads: 1 });
      expect(noOpt).not.toContain("-fopenmp");
      expect(explicit1).not.toContain("-fopenmp");
    });
  });

  describe("threads as a concrete number (>= 2)", () => {
    const SRC = "a = ones(3, 4);\nb = a + 1;\ndisp(b);\n";

    it("emits `<omp.h>` once", () => {
      const c = translate(SRC, { threads: 4 });
      expect(c).toContain("#include <omp.h>");
      // No accidental duplication.
      expect(c.match(/#include <omp\.h>/g)?.length).toBe(1);
    });

    it("emits a startup `omp_set_num_threads(N)` call in main()", () => {
      const c = translate(SRC, { threads: 8 });
      // The call should be inside main(), not the runtime-helper block.
      const mainStart = c.indexOf("int main(");
      expect(mainStart).toBeGreaterThan(-1);
      const mainBody = c.slice(mainStart);
      expect(mainBody).toMatch(/omp_set_num_threads\(8\);/);
    });

    it("emits `#pragma omp parallel for if(_mtoc_n > 1024)` on flat-iter loops", () => {
      const c = translate(SRC, { threads: 4 });
      // The pragma should appear immediately above the elementwise
      // for-loop. Pinning the runtime size-guard threshold to 1024
      // — small loops stay serial so OpenMP fork overhead doesn't
      // dominate.
      expect(c).toMatch(
        /#pragma omp parallel for if\(_mtoc_n > 1024\)\s*\n\s*for \(long _mtoc_i = 0;/
      );
    });

    it("emits the pragma on the broadcast outer loop only", () => {
      // Mixed-shape operands route through the broadcast emitter. The
      // pragma should sit above the outermost loop (axis = outNdim-1
      // = `_mtoc_k1` for a 2-D broadcast) with the if-clause sized
      // against the total element count.
      const c = translate(
        "r = [1 2 3 4];\ncol = [10; 20; 30];\nb = r + col;\ndisp(b);\n",
        { threads: 4 }
      );
      // One outer pragma; no pragma above the inner loop.
      expect(c).toMatch(
        /#pragma omp parallel for if\(_mtoc_d0 \* _mtoc_d1 > 1024\)\s*\n\s*for \(long _mtoc_k1 = 0;/
      );
      // Only ONE parallel-for pragma per emitted broadcast — the
      // inner loop must remain serial (each thread walks its own
      // outer-axis slab; nesting would over-subscribe).
      const pragmaCount = (c.match(/#pragma omp parallel for/g) ?? []).length;
      expect(pragmaCount).toBe(1);
    });

    it("buildCcArgs adds -fopenmp when threads is a number >= 2", () => {
      const args = buildCcArgs("in.c", "out.exe", { threads: 4 });
      expect(args).toContain("-fopenmp");
    });
  });

  describe('threads="auto"', () => {
    const SRC = "a = ones(3, 4);\nb = a + 1;\ndisp(b);\n";

    it("emits `<omp.h>` and pragmas, but no `omp_set_num_threads` call", () => {
      // `"auto"` is the "let OpenMP decide" mode: the binary is
      // parallel-capable, but the runtime picks the thread count
      // (typically from OMP_NUM_THREADS or core count). Pinning the
      // count with `omp_set_num_threads` would override that — so
      // skip the call.
      const c = translate(SRC, { threads: "auto" });
      expect(c).toContain("#include <omp.h>");
      expect(c).toMatch(/#pragma omp parallel for/);
      expect(c).not.toContain("omp_set_num_threads");
    });

    it("buildCcArgs adds -fopenmp for auto", () => {
      const args = buildCcArgs("in.c", "out.exe", { threads: "auto" });
      expect(args).toContain("-fopenmp");
    });
  });

  describe("interaction with other options", () => {
    it("inline-temps + threads produces a parallel inlined loop", () => {
      // The inlining pass runs first (IR-to-IR); the parallel-loop
      // pragma is emitted by the same elementwise loop that contains
      // the inlined expression. Net result: one parallel loop
      // computes the full chain.
      const c = translate(
        "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n",
        {
          threads: 4,
          enableTempInlining: true,
        }
      );
      // One pragma (the chain fused into a single loop).
      const pragmaCount = (c.match(/#pragma omp parallel for/g) ?? []).length;
      expect(pragmaCount).toBe(1);
      // And the body computes the full chain in place — no `b` read
      // survives.
      expect(c).toMatch(
        /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 2\.0;/
      );
    });
  });
});
