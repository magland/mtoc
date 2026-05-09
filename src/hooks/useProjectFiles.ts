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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
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

  const setActiveFileId = useCallback(
    (id: string) => {
      setActiveFileIdRaw(id);
      storeActiveFileId(projectName, id);
    },
    [projectName]
  );

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
      contentCacheRef.current.set(fileId, data);
      return data;
    },
    []
  );

  const debouncedSave = useMemo(
    () =>
      debounce(async (fileId: string, data: Uint8Array) => {
        try {
          await saveFileData(fileId, data);
        } catch (e) {
          console.error("Failed to save file:", e);
        }
      }, 500),
    []
  );

  const updateFileContent = useCallback(
    (content: string) => {
      const data = textEncoder.encode(content);
      contentCacheRef.current.set(activeFileId, data);
      debouncedSave(activeFileId, data);
    },
    [activeFileId, debouncedSave]
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
