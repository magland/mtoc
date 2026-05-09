import pako from "pako";
import { fileText, type WorkspaceFile } from "../hooks/useProjectFiles";

export interface ShareData {
  files: { name: string; content: string }[];
  activeFileName: string | null;
}

const textEncoder = new TextEncoder();

/** Convert bytes to base64url, chunked to avoid call-stack overflow on
 *  large buffers (spread args into String.fromCharCode is the
 *  conventional shortcut and breaks on V8 above ~100 KB). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, end) as unknown as number[]
    );
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function encodeShareData(
  files: WorkspaceFile[],
  contentMap: Map<string, Uint8Array>,
  activeFileId: string
): string {
  const activeFile = files.find(f => f.id === activeFileId);
  const data: ShareData = {
    files: files.map(f => ({
      name: f.name,
      content: fileText(contentMap.get(f.id) ?? new Uint8Array(0)),
    })),
    activeFileName: activeFile?.name ?? null,
  };
  const compressed = pako.deflate(textEncoder.encode(JSON.stringify(data)));
  return bytesToBase64Url(compressed);
}

/** Encode a single script into a share-page URL hash. */
export function makeShareHash(name: string, code: string): string {
  const fileName = `${name}.m`;
  const data: ShareData = {
    files: [{ name: fileName, content: code }],
    activeFileName: fileName,
  };
  const compressed = pako.deflate(textEncoder.encode(JSON.stringify(data)));
  return bytesToBase64Url(compressed);
}

export function decodeShareData(encoded: string): ShareData {
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const json = new TextDecoder().decode(pako.inflate(bytes));
  return JSON.parse(json);
}

export interface ShareFilesResult {
  files: WorkspaceFile[];
  contentMap: Map<string, Uint8Array>;
  activeFileId: string;
}

export function shareDataToWorkspaceFiles(data: ShareData): ShareFilesResult {
  const files: WorkspaceFile[] = [];
  const contentMap = new Map<string, Uint8Array>();
  for (const f of data.files) {
    const id = crypto.randomUUID();
    files.push({ id, name: f.name });
    contentMap.set(id, textEncoder.encode(f.content));
  }
  let activeFileId = "";
  if (data.activeFileName) {
    const match = files.find(f => f.name === data.activeFileName);
    if (match) activeFileId = match.id;
  }
  if (!activeFileId && files.length > 0) activeFileId = files[0].id;
  return { files, contentMap, activeFileId };
}
