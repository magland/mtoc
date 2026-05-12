import {
  Box,
  Alert,
  FormControlLabel,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import Editor from "@monaco-editor/react";
import type { TranslateError, SourceFile } from "../translate";

interface CSourcePanelProps {
  c: string;
  error: TranslateError | null;
  /** Other (non-active) files in the project. Used to suggest "function
   *  defined in helpers.m — switch to that file" when the active file
   *  references a function defined elsewhere. */
  otherFiles: SourceFile[];
  activeName: string;
  includeRuntime: boolean;
  onIncludeRuntimeChange: (value: boolean) => void;
  enableTempInlining: boolean;
  onEnableTempInliningChange: (value: boolean) => void;
  /** `-ffast-math` toggle. Does NOT change the displayed C — only
   *  affects the compile-and-run output. Lives here alongside the
   *  other build toggles for a single place to find them. */
  fastMath: boolean;
  onFastMathChange: (value: boolean) => void;
  /** True while a remote run is in flight — toggling fast-math
   *  mid-run wouldn't take effect until the next run. We disable
   *  the switch to make that obvious. */
  isRunning: boolean;
}

const UNRESOLVED_PATTERN = /unresolved function or builtin '(\w+)'/;

function findFunctionInOtherFiles(
  fnName: string,
  otherFiles: SourceFile[]
): string | null {
  const pattern = new RegExp(
    `^\\s*function\\b[^=\\n]*?\\b${fnName}\\s*\\(`,
    "m"
  );
  for (const f of otherFiles) {
    if (pattern.test(f.source)) return f.name;
  }
  return null;
}

function buildErrorMessage(
  error: TranslateError,
  otherFiles: SourceFile[],
  activeName: string
): string {
  let msg = `${error.kind}: ${error.message}`;
  if (error.fileName && error.fileName !== activeName) {
    msg = `${error.fileName}: ${msg}`;
  }
  const m = error.message.match(UNRESOLVED_PATTERN);
  if (m) {
    const otherFile = findFunctionInOtherFiles(m[1], otherFiles);
    if (otherFile) {
      msg += `\n'${m[1]}' is defined in ${otherFile} — only the active file is translated. Switch to ${otherFile} to translate it directly.`;
    }
  }
  return msg;
}

export function CSourcePanel({
  c,
  error,
  otherFiles,
  activeName,
  includeRuntime,
  onIncludeRuntimeChange,
  enableTempInlining,
  onEnableTempInliningChange,
  fastMath,
  onFastMathChange,
  isRunning,
}: CSourcePanelProps) {
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 0.5,
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, color: "text.secondary" }}
        >
          GENERATED C
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Tooltip title="Substitute every single-use multi-element tensor variable's defining expression into its unique reader. Eliminates large intermediate tensors that thrash cache between separate loops. Numerically identical to the un-inlined build. Affects both the displayed C and the compile-and-run output.">
            <FormControlLabel
              sx={{ m: 0 }}
              control={
                <Switch
                  size="small"
                  checked={enableTempInlining}
                  onChange={e => onEnableTempInliningChange(e.target.checked)}
                />
              }
              label={
                <Typography variant="caption" color="text.secondary">
                  inline temps
                </Typography>
              }
            />
          </Tooltip>
          <Tooltip title="Build the binary with -ffast-math. Lets the C compiler reassociate floating-point ops so hot loops vectorize more aggressively. NOT IEEE-754 strict; numerics may drift in the last few ulps. Affects only the compile-and-run output; the displayed C source is identical.">
            <FormControlLabel
              sx={{ m: 0 }}
              control={
                <Switch
                  size="small"
                  checked={fastMath}
                  onChange={e => onFastMathChange(e.target.checked)}
                  disabled={isRunning}
                />
              }
              label={
                <Typography variant="caption" color="text.secondary">
                  fast math
                </Typography>
              }
            />
          </Tooltip>
          <Tooltip title="Inline mtoc's C runtime helpers (mtoc_disp_double, mtoc_tensor_t, …) into the displayed source. The compile-and-run server always uses the full runtime regardless of this toggle.">
            <FormControlLabel
              sx={{ m: 0 }}
              control={
                <Switch
                  size="small"
                  checked={includeRuntime}
                  onChange={e => onIncludeRuntimeChange(e.target.checked)}
                />
              }
              label={
                <Typography variant="caption" color="text.secondary">
                  runtime helpers
                </Typography>
              }
            />
          </Tooltip>
        </Box>
      </Box>
      {error && (
        <Alert
          severity="error"
          variant="outlined"
          sx={{
            borderRadius: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
            fontSize: 12,
            "& .MuiAlert-message": { py: 0.5 },
          }}
        >
          {buildErrorMessage(error, otherFiles, activeName)}
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language="c"
          value={c}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            wordWrap: "on",
            scrollBeyondLastLine: false,
          }}
        />
      </Box>
    </Box>
  );
}
