import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useReducer,
  useRef,
} from "react";
import {
  getProjectFiles,
  saveFileData,
  createFile,
  deleteFile,
  renameFile as renameFileInDb,
  getFileContent,
} from "../db/operations";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");
const SAVE_DEBOUNCE_MS = 500;

/** Metadata-only file reference (no content loaded). */
export interface WorkspaceFile {
  id: string;
  name: string;
}

export function fileText(data: Uint8Array): string {
  return textDecoder.decode(data);
}

type FilesAction =
  | { type: "SET_FILES"; files: WorkspaceFile[] }
  | { type: "ADD_FILE"; file: WorkspaceFile }
  | { type: "DELETE_FILE"; fileId: string }
  | { type: "RENAME_FILE"; fileId: string; newName: string };

function filesReducer(
  state: WorkspaceFile[],
  action: FilesAction
): WorkspaceFile[] {
  switch (action.type) {
    case "SET_FILES":
      return action.files;
    case "ADD_FILE":
      return [...state, action.file];
    case "DELETE_FILE":
      return state.filter(f => f.id !== action.fileId);
    case "RENAME_FILE":
      return state.map(f =>
        f.id === action.fileId ? { ...f, name: action.newName } : f
      );
    default:
      return state;
  }
}

export interface UseProjectFilesResult {
  files: WorkspaceFile[];
  activeFileId: string;
  loading: boolean;
  setActiveFileId: (id: string) => void;
  updateFileContent: (content: string) => void;
  addFile: () => Promise<string>;
  deleteFile: (fileId: string) => void;
  renameFile: (fileId: string, newName: string) => void;
  loadFileContent: (fileId: string) => Promise<Uint8Array>;
  contentCache: React.RefObject<Map<string, Uint8Array>>;
}

interface PendingSave {
  data: Uint8Array;
  timeoutId: ReturnType<typeof setTimeout>;
}

function generateUniqueName(files: WorkspaceFile[]): string {
  const existing = new Set(files.map(f => f.name));
  for (let i = 1; ; i++) {
    const name = `untitled${i === 1 ? "" : i}.m`;
    if (!existing.has(name)) return name;
  }
}

function getStoredActiveFileId(projectName: string): string {
  try {
    return localStorage.getItem(`mtoc_active_file_${projectName}`) || "";
  } catch {
    return "";
  }
}

function storeActiveFileId(projectName: string, fileId: string): void {
  try {
    localStorage.setItem(`mtoc_active_file_${projectName}`, fileId);
  } catch {
    /* ignore */
  }
}

export function useProjectFiles(projectName: string): UseProjectFilesResult {
  const [files, dispatch] = useReducer(filesReducer, []);
  const [activeFileId, setActiveFileIdRaw] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const contentCacheRef = useRef(new Map<string, Uint8Array>());
  const pendingSavesRef = useRef(new Map<string, PendingSave>());

  const setActiveFileId = useCallback(
    (id: string) => {
      setActiveFileIdRaw(id);
      storeActiveFileId(projectName, id);
    },
    [projectName]
  );

  // Fire one file's pending save synchronously (still async at the IDB layer,
  // but no longer waiting on the debounce timer).
  const flushSave = useCallback((fileId: string) => {
    const pending = pendingSavesRef.current.get(fileId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingSavesRef.current.delete(fileId);
    saveFileData(fileId, pending.data).catch(e =>
      console.error("Failed to save file:", e)
    );
  }, []);

  const flushAllSaves = useCallback(() => {
    for (const fileId of Array.from(pendingSavesRef.current.keys())) {
      flushSave(fileId);
    }
  }, [flushSave]);

  // Flush pending writes when the page is hidden/unloaded so a reload within
  // the debounce window doesn't see empty files.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushAllSaves();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushAllSaves);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushAllSaves);
      flushAllSaves();
    };
  }, [flushAllSaves]);

  // Per-file debounced save — a write to file B never clobbers file A's
  // pending write, and switching active file is safe.
  const scheduleSave = useCallback((fileId: string, data: Uint8Array) => {
    const existing = pendingSavesRef.current.get(fileId);
    if (existing) clearTimeout(existing.timeoutId);
    const timeoutId = setTimeout(() => {
      pendingSavesRef.current.delete(fileId);
      saveFileData(fileId, data).catch(e =>
        console.error("Failed to save file:", e)
      );
    }, SAVE_DEBOUNCE_MS);
    pendingSavesRef.current.set(fileId, { data, timeoutId });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const projectFiles = await getProjectFiles(projectName);
        if (cancelled) return;
        const workspaceFiles: WorkspaceFile[] = projectFiles.map(pf => ({
          id: pf.id,
          name: pf.path,
        }));
        dispatch({ type: "SET_FILES", files: workspaceFiles });
        setActiveFileIdRaw(prev => {
          if (!prev && workspaceFiles.length > 0) {
            const stored = getStoredActiveFileId(projectName);
            if (stored && workspaceFiles.some(f => f.id === stored))
              return stored;
            return workspaceFiles[0].id;
          }
          return prev;
        });
      } catch (e) {
        console.error("Failed to load files:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  const loadFileContent = useCallback(
    async (fileId: string): Promise<Uint8Array> => {
      const cached = contentCacheRef.current.get(fileId);
      if (cached !== undefined) return cached;
      const data = await getFileContent(fileId);
      // Don't clobber a cache entry that was written by the user (via
      // updateFileContent) while the IDB read was in flight.
      const afterFetch = contentCacheRef.current.get(fileId);
      if (afterFetch !== undefined) return afterFetch;
      contentCacheRef.current.set(fileId, data);
      return data;
    },
    []
  );

  const updateFileContent = useCallback(
    (content: string) => {
      const data = textEncoder.encode(content);
      contentCacheRef.current.set(activeFileId, data);
      scheduleSave(activeFileId, data);
    },
    [activeFileId, scheduleSave]
  );

  const emptyData = useMemo(() => new Uint8Array(0), []);

  const addFile = useCallback(async (): Promise<string> => {
    const name = generateUniqueName(files);
    try {
      const file = await createFile(projectName, name, emptyData);
      dispatch({ type: "ADD_FILE", file: { id: file.id, name } });
      contentCacheRef.current.set(file.id, emptyData);
      setActiveFileId(file.id);
      return file.id;
    } catch (e) {
      console.error("Failed to create file:", e);
      return "";
    }
  }, [files, projectName, setActiveFileId, emptyData]);

  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      try {
        const pending = pendingSavesRef.current.get(fileId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingSavesRef.current.delete(fileId);
        }
        await deleteFile(fileId);
        contentCacheRef.current.delete(fileId);
        if (activeFileId === fileId) {
          const remaining = files.filter(f => f.id !== fileId);
          setActiveFileId(remaining.length > 0 ? remaining[0].id : "");
        }
        dispatch({ type: "DELETE_FILE", fileId });
      } catch (e) {
        console.error("Failed to delete file:", e);
      }
    },
    [files, activeFileId, setActiveFileId]
  );

  const handleRenameFile = useCallback(
    async (fileId: string, newName: string) => {
      if (files.some(f => f.id !== fileId && f.name === newName)) {
        alert("A file with this name already exists");
        return;
      }
      try {
        await renameFileInDb(fileId, newName);
        dispatch({ type: "RENAME_FILE", fileId, newName });
      } catch (e) {
        console.error("Failed to rename file:", e);
      }
    },
    [files]
  );

  return {
    files,
    activeFileId,
    loading,
    setActiveFileId,
    updateFileContent,
    addFile,
    deleteFile: handleDeleteFile,
    renameFile: handleRenameFile,
    loadFileContent,
    contentCache: contentCacheRef,
  };
}
