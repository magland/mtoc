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

export class MtocDatabase extends Dexie {
  projects!: EntityTable<Project, "name">;
  files!: EntityTable<ProjectFile, "id">;
  fileContents!: EntityTable<FileContent, "id">;

  constructor() {
    super("mtoc-db");

    this.version(1).stores({
      projects: "name, lastOpenedAt",
      files: "id, projectName, [projectName+path]",
      fileContents: "id",
    });
  }
}

export const db = new MtocDatabase();
