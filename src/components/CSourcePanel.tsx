import {
  Box,
  Alert,
  FormControl,
  FormControlLabel,
  MenuItem,
  Select,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import Editor from "@monaco-editor/react";
import type { TranslateError, SourceFile } from "../translate";
import { OPT_PROFILES, type OptProfile } from "../optProfile";

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
  /** Last-selected optimization profile. Changing this resets the three
   *  toggles below to the profile's defaults via `onProfileChange`; the
   *  user can then override individual toggles without the dropdown
   *  "drifting." */
  profile: OptProfile;
  onProfileChange: (value: OptProfile) => void;
  enableTempInlining: boolean;
  onEnableTempInliningChange: (value: boolean) => void;
  /** `-ffast-math` toggle. Does NOT change the displayed C — only
   *  affects the compile-and-run output. Lives here alongside the
   *  other build toggles for a single place to find them. */
  fastMath: boolean;
  onFastMathChange: (value: boolean) => void;
  /** Max threads for parallel elementwise loops. `1` (default) =
   *  pure serial, no `#pragma omp` in the displayed C. `"auto"` lets
   *  OpenMP pick the count at run time. A number `>= 2` emits a
   *  startup `omp_set_num_threads(N)` call. Affects BOTH the
   *  displayed C and the compile-and-run output. */
  threads: number | "auto";
  onThreadsChange: (value: number | "auto") => void;
  /** True while a remote run is in flight — toggling fast-math
   *  mid-run wouldn't take effect until the next run. We disable
   *  the switch to make that obvious. */
  isRunning: boolean;
}

const THREAD_PRESETS: ReadonlyArray<number | "auto"> = [1, 2, 4, 8, 16, "auto"];

function threadValueToLabel(value: number | "auto"): string {
  if (value === "auto") return "auto threads";
  return value === 1 ? "1 thread" : `${value} threads`;
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
  profile,
  onProfileChange,
  enableTempInlining,
  onEnableTempInliningChange,
  fastMath,
  onFastMathChange,
  threads,
  onThreadsChange,
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
          <FormControl size="small" sx={{ m: 0 }}>
            <Select
              value={profile}
              onChange={e => onProfileChange(e.target.value as OptProfile)}
              variant="standard"
              disableUnderline
              renderValue={v => `opt: ${v}`}
              sx={{
                fontSize: 12,
                color: "text.secondary",
                "& .MuiSelect-select": { py: 0, pr: "18px !important" },
              }}
            >
              {OPT_PROFILES.map(p => (
                <MenuItem key={p} value={p} dense>
                  <Typography variant="caption">opt: {p}</Typography>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Tooltip title="Inline single-use tensor temporaries.">
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
          <Tooltip title="Compile with -ffast-math.">
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
          <FormControl size="small" sx={{ m: 0 }}>
            <Select
              value={String(threads)}
              onChange={e => {
                const v = e.target.value;
                onThreadsChange(v === "auto" ? "auto" : Number(v));
              }}
              variant="standard"
              disableUnderline
              renderValue={v =>
                threadValueToLabel(v === "auto" ? "auto" : Number(v))
              }
              sx={{
                fontSize: 12,
                color: "text.secondary",
                "& .MuiSelect-select": { py: 0, pr: "18px !important" },
              }}
            >
              {THREAD_PRESETS.map(p => (
                <MenuItem key={String(p)} value={String(p)} dense>
                  <Typography variant="caption">
                    {threadValueToLabel(p)}
                    {p === 1 ? " (serial)" : ""}
                  </Typography>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Tooltip title="Show runtime helpers inline.">
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
