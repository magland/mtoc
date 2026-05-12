import Dexie, { type EntityTable } from "dexie";

export interface Project {
  name: string;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export interface ProjectFile {
  id: string;
  projectName: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileContent {
  id: string;
  data: Uint8Array;
}

/** A cached WebAssembly build (the .wasm bytes plus Emscripten's glue),
 *  keyed by SHA-256 of `(translated C source, build options)`. The
 *  `storedAt` index lets the cleanup sweep find expired entries with a
 *  range query rather than scanning the whole table. */
export interface WasmCacheEntry {
  key: string;
  wasm: Uint8Array;
  glue: string;
  simd: boolean;
  fastMath: boolean;
  optLevel: "O0" | "O2" | "O3";
  storedAt: number;
}

export class MtocDatabase extends Dexie {
  projects!: EntityTable<Project, "name">;
  files!: EntityTable<ProjectFile, "id">;
  fileContents!: EntityTable<FileContent, "id">;
  wasmCache!: EntityTable<WasmCacheEntry, "key">;

  constructor() {
    super("mtoc-db");

    this.version(1).stores({
      projects: "name, lastOpenedAt",
      files: "id, projectName, [projectName+path]",
      fileContents: "id",
    });

    // v2 adds wasmCache. Existing v1 databases auto-upgrade in place —
    // Dexie creates the new table without touching the others. Rolling
    // a v3 later that just changes wasmCache's indexes is safe; bigger
    // shape changes need an explicit upgrade callback.
    this.version(2).stores({
      projects: "name, lastOpenedAt",
      files: "id, projectName, [projectName+path]",
      fileContents: "id",
      wasmCache: "key, storedAt",
    });
  }
}

export const db = new MtocDatabase();
