# Web IDE

A browser-based editor for numbl projects that renders the generated C source
live in a side-by-side pane. Built on Vite + React + MUI + Monaco. The browser
can't shell out to a compiler, so to actually execute the generated C the IDE
streams it to a small local server (`mtoc serve`) which compiles and runs it.

## Routes

- `/` — project list. Create / rename / delete projects backed by IndexedDB.
- `/project/:projectName` — IDE workspace.
- `/share` — read-and-edit-in-place workspace populated from a URL hash.

## Layout

The IDE is `Splitter` (a small flexbox primitive) nested three times:

```
[FileBrowser sidebar] | ┌──────────────────────┬─────────────────────┐
                       │ Monaco editor (numbl) │                     │
                       ├──────────────────────┤  Read-only Monaco   │
                       │ ConsolePanel         │  (C) + error banner │
                       └──────────────────────┴─────────────────────┘
```

- Left: file list with add / rename / delete. One file is "active" at a time.
- Middle-top: editable Monaco instance, language `numbl`. Tokens come from
  `src/monaco/numblLanguage.ts`, whose builtin list is derived from
  `allBuiltinNames()` in `src/workspace/builtins.ts` so it stays in sync.
- Middle-bottom: console panel — color-coded stdout/stderr from the local
  execution server. Empty until the user clicks Run.
- Right: read-only Monaco showing the C produced by translating the active
  file. A red banner appears above when translation fails.

A small toolbar above the splitters carries the Run/Stop button and a
connection-status icon (click it to open the execution-settings dialog).

## Translation lifecycle

`src/hooks/useTranslation.ts`:

1. Debounces edits by 300 ms.
2. Calls `translateProject(files, activeName)` from `src/translate.ts` —
   the same entry point the CLI uses.
3. Maps the returned `TranslateError` (if any) into a Monaco marker on the
   active editor model via `monaco.editor.setModelMarkers`. Offsets are
   converted to `{line, column}` by `offsetToLineCol` in
   `src/parser/sourceLoc.ts`.
4. The right-pane banner additionally checks "unresolved function" errors
   against the other files in the project — if a definition is found there,
   the banner suggests switching to that file (multi-file translation isn't
   wired yet; see "Multi-file caveat" below).

## Persistence

`src/db/schema.ts` (Dexie / IndexedDB, database name `mtoc-db`) with three
tables: `projects`, `files`, `fileContents`. The split keeps file metadata
small and content blobs separately addressable. `useProjectFiles` in
`src/hooks/` is the single API: file metadata in React state, content lazily
loaded into a ref-cache, edits debounced 500 ms per-file before hitting the
DB. Pending writes are flushed on `visibilitychange → hidden`, `pagehide`,
and hook unmount so a reload inside the debounce window doesn't lose typed
content.

`localStorage` key `mtoc_active_file_<projectName>` remembers which file was
last open per project. (Distinct from numbl's `numbl_active_file_*` to avoid
collisions when both apps are served from the same origin.)

## Sharing

`src/utils/shareUrl.ts` mirrors numbl's format: a `{files, activeFileName}`
JSON, deflated by pako, base64url-encoded into the URL hash. The hash supports
multi-file projects. `ShareIDEPage` decodes on mount; subsequent edits update
the hash via `history.replaceState`. The URL has a 64 KB cap (`urlSizeTooLarge`
flag surfaces a warning beyond that).

## Multi-file caveat

mtoc's lowerer only resolves functions defined in the active file's AST. The
IDE supports multi-file projects so you can keep helpers separate, but each
translation only sees the active file. When the user calls a helper defined
elsewhere, `translateProject` returns an `UnsupportedConstruct` ("unresolved
function or builtin 'foo'"). `CSourcePanel` scans other files for a matching
`function foo(...)` definition and adds a hint to the banner pointing at the
right file.

## Local execution server

`server/execution-service.ts` is a tiny Node HTTP server, started from the
mtoc CLI (`mtoc serve --passkey <key>`). It exposes three endpoints, all
authenticated via `Authorization: Bearer <passkey>`:

- `GET /health` — `{status, activeExecutions, cc, emcc}`. Used by the IDE's
  connection-status icon. `emcc` is the first line of `emcc --version` when
  Emscripten is available on the server (probed on every health check), or
  `null` when it isn't — the IDE greys out the wasm-mode toggle in the
  latter case.
- `POST /run` — body `{files: SourceFile[], activeName: string}`. The
  server runs the same `translateProject` the IDE uses, writes the
  resulting C to a `mkdtemp` directory, invokes `cc -o a.out out.c -lm`
  (override the compiler via `CC`), then executes the binary. Streams
  the result as SSE events:
  - `{type: "translate_error", kind, message, fileName?}` — present iff
    translation failed; the server then sends a `done` with phase
    `translate` and ends.
  - `{type: "compile_error", text}` — present iff compilation failed.
  - `{type: "stdout", text}` — chunked stdout.
  - `{type: "stderr", text}` — chunked stderr.
  - `{type: "done", phase: "translate"|"compile"|"run", exitCode, signal?}`
    — terminal event; the SSE stream closes immediately after.
- `POST /build-wasm` — body `{files, activeName, optLevel?, simd?,
fastMath?, enableTempInlining?}`. The server translates with the same
  pipeline, then shells out to `emcc` (override via `MTOC_EMCC`) to
  produce a WebAssembly module. Returns a single JSON reply:
  - success: `{ok: true, wasm: <base64>, glue: <text>, meta: {...}}` —
    `wasm` is the raw `.wasm` bytes, `glue` is Emscripten's ES-module
    glue (a `.mjs` blob).
  - translate failure: `{ok: false, phase: "translate", error: {kind,
message, fileName?}}`.
  - compile failure: `{ok: false, phase: "compile", stderr}`.

  Builds are cached on disk in `$TMPDIR/mtoc-wasm-cache/` keyed by
  SHA-256 of `(cSource, options)`. Cold emcc builds take a few seconds;
  warm cache hits are <50 ms. `MTOC_BUILD_TIMEOUT_MS` (default 60 s)
  caps a single cold build.

Sending source rather than C is deliberate: the only C that ever reaches
`cc` or `emcc` is what mtoc itself emits, so the server's effective attack
surface is the constrained subset of C that mtoc generates, not arbitrary
C the client could craft.

Defaults bind to `127.0.0.1` and use port `3002`. Override via flags
(`--host`, `--port`) or env (`MTOC_SERVE_HOST`, `MTOC_SERVE_PORT`). Per-run
timeout (`MTOC_TIMEOUT_MS`, default 30 s) and concurrency cap
(`MTOC_MAX_CONCURRENT`, default 3) are also env-tunable. Aborting the request
client-side (the Stop button) closes the SSE stream, which the server
detects and uses to SIGTERM the child process.

The passkey is generated in the browser by `src/utils/remoteExecution.ts` and
stored in `localStorage` (so it sticks around until the user clears the
browser's site data or hits "Regenerate passkey"). The settings dialog shows
the user the full `mtoc serve --passkey …` command to paste into a terminal.
`regeneratePasskey` cycles it; the server has to be restarted with the new
key for the IDE to reconnect.

`src/hooks/useRemoteExecution.ts` is the React-side state machine: holds
`{status, connection, health, lines}`, exposes `run(files, name, mode,
opts)`, `stop()`, and a `checkConnection()` that re-pings `/health`.
`ConsolePanel` renders the `lines` array color-coded by channel. The
`mode` argument switches between the native SSE path
(`utils/remoteExecution.ts`) and the WASM build-then-run path
(`utils/wasmExecution.ts`); both produce the same `RunEvent` stream so
the console UI is mode-agnostic.

## WASM execution mode

In wasm mode the server only compiles — execution happens in the browser.
The flow is:

1. Browser POSTs to `/build-wasm`. Server translates → `emcc` → returns
   `{wasm, glue}`.
2. Browser turns the glue into a Blob URL and dynamically imports it,
   getting Emscripten's `createMtocModule` factory.
3. Browser calls the factory with `{wasmBinary, print, printErr,
noExitRuntime: false, onExit, onAbort}`. `print` / `printErr` route
   into the same `ConsoleLine[]` the SSE path feeds. `_main` runs at
   instantiation time (Emscripten's `-sINVOKE_RUN=1` default) and the
   factory resolves once it exits.

The toolbar `native | wasm` toggle is persisted in `localStorage`
(`mtoc_execution_mode`). The wasm-mode-only knobs `optLevel` and `simd`
are persisted under `mtoc_wasm_opt_level` / `mtoc_wasm_simd`. The native
trio (`enableTempInlining`, `fastMath`, `threads`) is shared between
modes but in wasm mode `threads` is forced to 1 — see "Threads" below.

### Threads / OpenMP

Threads are NOT yet supported on the wasm path. mtoc's parallel-loop
codegen uses OpenMP (`#pragma omp parallel for`, `#include <omp.h>`,
`omp_set_num_threads`), and the current bundled `emsdk` does not ship
`omp.h` or a libomp port that emcc can link against. The wasm build
path forces `threads = 1` at translation time so no `<omp.h>` include
is emitted, and the IDE hides the threads dropdown in wasm mode to
match. The native path still supports threads as before.

When the upstream `emsdk` ships a libomp port, the plan is to:

1. Drop the `threads = 1` override at translate time for the wasm path.
2. Pass `-pthread -fopenmp -sPTHREAD_POOL_SIZE=<N>` to `emcc` in
   `buildEmccArgs`.
3. Add the COOP/COEP headers to Vite's dev/preview server so the page
   has `crossOriginIsolated === true` (required for `SharedArrayBuffer`,
   which Emscripten threads need). On GitHub Pages, ship
   `coi-serviceworker` to add the headers via a service-worker shim,
   since Pages can't set response headers directly.
4. Bundle the Emscripten `.worker.js` companion file alongside the
   `.wasm` + `.mjs` in the `/build-wasm` response.

### SIMD

`-msimd128` is supported and exposed as the wasm-mode "simd" toggle. It
lets emcc lower hot loops to WebAssembly SIMD128 opcodes. Stdout is
expected to match the non-SIMD native build byte-for-byte for the
operations mtoc emits; if SIMD ever causes a divergence, that's a libc
or compiler bug worth filing upstream.

### Cross-runner

`scripts/run_test_scripts.ts` accepts `--target wasm` to run every `.m`
script through the wasm path instead of the native path. The wasm cross-
runner translates, compiles with `emcc`, and instantiates the resulting
module in the Node process via the same ES-module factory the browser
uses (Node 18+'s `WebAssembly` and `Blob` are sufficient). Stdout is
compared against numbl byte-for-byte, same oracle as the native runner.

Run it as `MTOC_EMCC=/path/to/emcc npx tsx scripts/run_test_scripts.ts
--target wasm` (or just `--target wasm` if `emcc` is already on PATH).
Note that complex-pow edge cases like `(-1)^0.5` differ between glibc
and emscripten's wasm-libc by 1 ULP and currently cause one expected
mismatch (`test_scripts/complex/negative_base_power.m`); the native
runner is byte-clean.

## Translator runtime in the browser

`src/codegen/runtime.ts` originally read `runtime/*.h` via `fs.readFileSync`
at module load — a hard blocker for browser bundling. The fix is the
`scripts/build_runtime_snippets.ts` codegen step, which emits
`src/codegen/runtime/snippets.gen.ts` (committed) as a `Record<string, string>`
of inlined header bodies. `runtime.ts` now imports from there.

`scripts/build_runtime_snippets.ts --check` (`npm run build:snippets:check`)
fails CI if the generated file drifts from the `.h` sources.

The other Node-only import (`node:crypto` in `src/lowering/lowerFuncCall.ts`,
used solely for an 8-hex specialization-mangle suffix) was replaced with an
FNV-1a 32-bit hash inlined in the same module — same entropy, no Node
dependency.

## Build configuration

Three TypeScript projects, joined by `tsconfig.json` references:

- `tsconfig.cli.json` — translator, CLI, scripts (Node types, ES2022 lib).
- `tsconfig.app.json` — web app (DOM lib, JSX, bundler resolution).
- `tsconfig.node.json` — Vite config files.

`vite.config.ts` opts in to ES-format workers and dedupes Monaco
(`worker.format = "es"`, `resolve.dedupe = ["monaco-editor"]`) — both are
needed in practice for production builds.
