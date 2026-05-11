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
mtoc CLI (`mtoc serve --passkey <key>`). It exposes two endpoints, both
authenticated via `Authorization: Bearer <passkey>`:

- `GET /health` — `{status, activeExecutions, cc}`. Used by the IDE's
  connection-status icon.
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

Sending source rather than C is deliberate: the only C that ever reaches
`cc` is what mtoc itself emits, so the server's effective attack surface
is the constrained subset of C that mtoc generates, not arbitrary C the
client could craft.

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
`{status, connection, lines}`, exposes `run(c)`, `stop()`, and a
`checkConnection()` that re-pings `/health`. `ConsolePanel` renders the
`lines` array color-coded by channel.

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
