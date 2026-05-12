import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  DEFAULT_REMOTE_SERVICE_URL,
  DEFAULT_WASM_SERVICE_URL,
  checkRemoteServiceHealth,
  checkWasmServiceHealth,
  getPasskey,
  getRemoteServiceUrl,
  getWasmServiceUrl,
  regeneratePasskey,
  setRemoteServiceUrl,
  setWasmServiceUrl,
} from "../utils/remoteExecution";

interface ExecutionSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after the user changes settings, so the parent can re-probe
   *  /health and refresh the connection-status icon. */
  onChanged?: () => void;
}

type NativeProbe =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; cc: string }
  | { state: "fail"; message: string };

type WasmProbe =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; emcc: string | null }
  | { state: "fail"; message: string };

export function ExecutionSettingsDialog({
  open,
  onClose,
  onChanged,
}: ExecutionSettingsDialogProps) {
  const [url, setUrl] = useState(getRemoteServiceUrl());
  const [wasmUrl, setWasmUrl] = useState(getWasmServiceUrl());
  const [passkey, setPasskey] = useState(getPasskey());
  const [nativeProbe, setNativeProbe] = useState<NativeProbe>({
    state: "idle",
  });
  const [wasmProbe, setWasmProbe] = useState<WasmProbe>({ state: "idle" });

  useEffect(() => {
    if (open) {
      setUrl(getRemoteServiceUrl());
      setWasmUrl(getWasmServiceUrl());
      setPasskey(getPasskey());
      setNativeProbe({ state: "idle" });
      setWasmProbe({ state: "idle" });
    }
  }, [open]);

  const command = `npx tsx src/cli.ts serve --passkey ${passkey}`;
  const npmCommand = `npm run serve -- --passkey ${passkey}`;

  const handleNativeCheck = async () => {
    setNativeProbe({ state: "checking" });
    const health = await checkRemoteServiceHealth(url, passkey);
    if (health) {
      setNativeProbe({ state: "ok", cc: health.cc });
    } else {
      setNativeProbe({
        state: "fail",
        message:
          "No response from local server. Start it in a terminal with the command below.",
      });
    }
  };

  const handleWasmCheck = async () => {
    setWasmProbe({ state: "checking" });
    const health = await checkWasmServiceHealth(wasmUrl);
    if (health && health.ok) {
      setWasmProbe({ state: "ok", emcc: health.emcc });
    } else {
      setWasmProbe({
        state: "fail",
        message:
          "No response from WASM service. The default service is run by the project; you can also point at your own.",
      });
    }
  };

  const handleSave = () => {
    setRemoteServiceUrl(url);
    setWasmServiceUrl(wasmUrl);
    onChanged?.();
    onClose();
  };

  const handleRegeneratePasskey = () => {
    setPasskey(regeneratePasskey());
    setNativeProbe({ state: "idle" });
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Execution settings</DialogTitle>
      <DialogContent>
        <Stack spacing={3}>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Native mode — local server
            </Typography>
            <DialogContentText sx={{ mb: 2 }}>
              Native execution mode needs a small local server because the
              browser can't shell out to <code>cc</code>. The IDE POSTs the
              project's <code>.m</code> source files to it for compilation and
              execution. Skip this section if you only use wasm mode.
            </DialogContentText>

            <Stack spacing={2}>
              <TextField
                label="Local server URL"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder={DEFAULT_REMOTE_SERVICE_URL}
                fullWidth
                size="small"
              />

              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Start the server with this command:
                </Typography>
                <Stack spacing={1}>
                  <CommandRow command={command} onCopy={() => copy(command)} />
                  <CommandRow
                    command={npmCommand}
                    onCopy={() => copy(npmCommand)}
                  />
                </Stack>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mt: 1 }}
                >
                  Run from the mtoc repo root. The passkey is stored in this
                  browser and persists until you clear site data or regenerate
                  it — if you regenerate, restart the server with the new key.
                </Typography>
              </Box>

              <Stack direction="row" spacing={1} alignItems="center">
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleNativeCheck}
                  disabled={nativeProbe.state === "checking"}
                >
                  {nativeProbe.state === "checking"
                    ? "Checking…"
                    : "Check connection"}
                </Button>
                <Button
                  variant="text"
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={handleRegeneratePasskey}
                >
                  Regenerate passkey
                </Button>
              </Stack>

              {nativeProbe.state === "ok" && (
                <Typography variant="body2" color="success.main">
                  Connected. Compiler: <code>{nativeProbe.cc}</code>
                </Typography>
              )}
              {nativeProbe.state === "fail" && (
                <Typography variant="body2" color="warning.main">
                  {nativeProbe.message}
                </Typography>
              )}
            </Stack>
          </Box>

          <Divider />

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              WASM mode — public compile service
            </Typography>
            <DialogContentText sx={{ mb: 2 }}>
              WASM execution mode translates the project in your browser, sends
              the generated C to a public C-to-WebAssembly compile service, and
              instantiates the returned module in-process. No local server
              needed. Point at your own deployment if you'd rather not use the
              default.
            </DialogContentText>

            <Stack spacing={2}>
              <TextField
                label="WASM compile service URL"
                value={wasmUrl}
                onChange={e => setWasmUrl(e.target.value)}
                placeholder={DEFAULT_WASM_SERVICE_URL}
                fullWidth
                size="small"
              />

              <Stack direction="row" spacing={1} alignItems="center">
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleWasmCheck}
                  disabled={wasmProbe.state === "checking"}
                >
                  {wasmProbe.state === "checking"
                    ? "Checking…"
                    : "Check connection"}
                </Button>
              </Stack>

              {wasmProbe.state === "ok" && (
                <Typography variant="body2" color="success.main">
                  Reachable.{" "}
                  {wasmProbe.emcc ? (
                    <>
                      Compiler: <code>{wasmProbe.emcc}</code>
                    </>
                  ) : (
                    "Compiler version unavailable."
                  )}
                </Typography>
              )}
              {wasmProbe.state === "fail" && (
                <Typography variant="body2" color="warning.main">
                  {wasmProbe.message}
                </Typography>
              )}
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CommandRow({
  command,
  onCopy,
}: {
  command: string;
  onCopy: () => void;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        bgcolor: "action.hover",
        borderRadius: 1,
        px: 1.5,
        py: 0.5,
      }}
    >
      <Box
        component="code"
        sx={{
          flex: 1,
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        {command}
      </Box>
      <Tooltip title="Copy">
        <IconButton size="small" onClick={onCopy}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
