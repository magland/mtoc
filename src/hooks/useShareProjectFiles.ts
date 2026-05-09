import {
  useState,
  useCallback,
  useMemo,
  useReducer,
  useEffect,
  useRef,
} from "react";
import type { WorkspaceFile, UseProjectFilesResult } from "./useProjectFiles";
import {
  encodeShareData,
  decodeShareData,
  shareDataToWorkspaceFiles,
} from "../utils/shareUrl";

const textEncoder = new TextEncoder();

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

function generateUniqueName(files: WorkspaceFile[]): string {
  const existing = new Set(files.map(f => f.name));
  for (let i = 1; ; i++) {
    const name = `untitled${i === 1 ? "" : i}.m`;
    if (!existing.has(name)) return name;
  }
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

export function useShareProjectFiles(): UseProjectFilesResult & {
  urlSizeTooLarge: boolean;
} {
  const [files, dispatch] = useReducer(filesReducer, []);
  const [activeFileId, setActiveFileId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [urlSizeTooLarge, setUrlSizeTooLarge] = useState(false);
  const contentMapRef = useRef(new Map<string, Uint8Array>());

  useEffect(() => {
    try {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const data = decodeShareData(hash);
        const {
          files: wsFiles,
          contentMap,
          activeFileId: aId,
        } = shareDataToWorkspaceFiles(data);
        contentMapRef.current = contentMap;
        dispatch({ type: "SET_FILES", files: wsFiles });
        setActiveFileId(aId);
      } else {
        const id = crypto.randomUUID();
        const data = textEncoder.encode("% Write your numbl script here\n");
        contentMapRef.current.set(id, data);
        dispatch({ type: "SET_FILES", files: [{ id, name: "main.m" }] });
        setActiveFileId(id);
      }
    } catch (e) {
      console.error("Failed to decode share URL:", e);
      const id = crypto.randomUUID();
      const data = textEncoder.encode("% Failed to load shared project\n");
      contentMapRef.current.set(id, data);
      dispatch({ type: "SET_FILES", files: [{ id, name: "main.m" }] });
      setActiveFileId(id);
    } finally {
      setLoading(false);
    }
  }, []);

  const debouncedUpdateUrl = useMemo(
    () =>
      debounce((currentFiles: WorkspaceFile[], currentActiveId: string) => {
        try {
          const encoded = encodeShareData(
            currentFiles,
            contentMapRef.current,
            currentActiveId
          );
          const newUrl = `${window.location.pathname}#${encoded}`;
          setUrlSizeTooLarge(newUrl.length > 64000);
          window.history.replaceState(null, "", newUrl);
        } catch (e) {
          console.error("Failed to update share URL:", e);
        }
      }, 500),
    []
  );

  useEffect(() => {
    if (!loading && files.length > 0) {
      debouncedUpdateUrl(files, activeFileId);
    }
  }, [files, activeFileId, loading, debouncedUpdateUrl]);

  const updateFileContent = useCallback(
    (content: string) => {
      contentMapRef.current.set(activeFileId, textEncoder.encode(content));
      debouncedUpdateUrl(files, activeFileId);
    },
    [activeFileId, files, debouncedUpdateUrl]
  );

  const emptyData = useMemo(() => new Uint8Array(0), []);

  const addFile = useCallback(async (): Promise<string> => {
    const name = generateUniqueName(files);
    const id = crypto.randomUUID();
    contentMapRef.current.set(id, emptyData);
    dispatch({ type: "ADD_FILE", file: { id, name } });
    setActiveFileId(id);
    return id;
  }, [files, emptyData]);

  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      contentMapRef.current.delete(fileId);
      if (activeFileId === fileId) {
        const remaining = files.filter(f => f.id !== fileId);
        setActiveFileId(remaining.length > 0 ? remaining[0].id : "");
      }
      dispatch({ type: "DELETE_FILE", fileId });
    },
    [files, activeFileId]
  );

  const handleRenameFile = useCallback(
    async (fileId: string, newName: string) => {
      if (files.some(f => f.id !== fileId && f.name === newName)) {
        alert("A file with this name already exists");
        return;
      }
      dispatch({ type: "RENAME_FILE", fileId, newName });
    },
    [files]
  );

  const loadFileContent = useCallback(async (fileId: string) => {
    return contentMapRef.current.get(fileId) ?? new Uint8Array(0);
  }, []);

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
    contentCache: contentMapRef,
    urlSizeTooLarge,
  };
}
