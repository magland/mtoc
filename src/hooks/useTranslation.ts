import { useEffect, useRef, useState } from "react";
import { useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import {
  translateProject,
  type SourceFile,
  type TranslateError,
} from "../translate.js";
import { offsetToLineCol } from "../parser/sourceLoc.js";

interface UseTranslationResult {
  c: string;
  error: TranslateError | null;
}

const MARKER_OWNER = "mtoc";
const DEBOUNCE_MS = 300;

export function useTranslation(
  files: SourceFile[],
  activeName: string,
  editorModel: editor.ITextModel | null,
  includeRuntime: boolean = false
): UseTranslationResult {
  const [c, setC] = useState<string>("");
  const [error, setError] = useState<TranslateError | null>(null);
  const monaco = useMonaco();
  const lastModelRef = useRef<editor.ITextModel | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const result = translateProject(files, activeName, { includeRuntime });
      if (result.error) {
        setError(result.error);
        // Keep the previously-good C source so the user can still see
        // what the last successful translation produced. (No-op on first
        // failure: setC("") would erase it; the existing state stays.)
      } else {
        setError(null);
        setC(result.c ?? "");
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [files, activeName, includeRuntime]);

  // Drive Monaco markers off of (error, editorModel, monaco).
  useEffect(() => {
    if (!monaco) return;
    // Clear stale markers when the active model changes.
    if (lastModelRef.current && lastModelRef.current !== editorModel) {
      try {
        monaco.editor.setModelMarkers(lastModelRef.current, MARKER_OWNER, []);
      } catch {
        /* model may have been disposed; nothing to clear */
      }
    }
    lastModelRef.current = editorModel;

    if (!editorModel) return;

    if (
      !error ||
      error.startOffset === undefined ||
      error.endOffset === undefined ||
      (error.fileName !== undefined && error.fileName !== activeName)
    ) {
      monaco.editor.setModelMarkers(editorModel, MARKER_OWNER, []);
      return;
    }

    const source = editorModel.getValue();
    const start = offsetToLineCol(source, error.startOffset);
    const end = offsetToLineCol(
      source,
      Math.max(error.endOffset, error.startOffset + 1)
    );
    monaco.editor.setModelMarkers(editorModel, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: `${error.kind}: ${error.message}`,
        startLineNumber: start.line,
        startColumn: start.column,
        endLineNumber: end.line,
        endColumn: end.column,
      },
    ]);
  }, [monaco, editorModel, error, activeName]);

  return { c, error };
}
