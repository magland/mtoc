import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
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
  checkRemoteServiceHealth,
  getPasskey,
  getRemoteServiceUrl,
  regeneratePasskey,
  setPasskey,
  setRemoteServiceUrl,
} from "../utils/remoteExecution";

interface ExecutionSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after the user changes settings, so the parent can re-probe
   *  /health and refresh the connection-status icon. */
  onChanged?: () => void;
}

type ProbeStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; cc: string }
  | { state: "fail"; message: string };

export function ExecutionSettingsDialog({
  open,
  onClose,
  onChanged,
}: ExecutionSettingsDialogProps) {
  const [url, setUrl] = useState(getRemoteServiceUrl());
  const [passkey, setPasskeyState] = useState(getPasskey());
  const [probe, setProbe] = useState<ProbeStatus>({ state: "idle" });

  useEffect(() => {
    if (open) {
      setUrl(getRemoteServiceUrl());
      setPasskeyState(getPasskey());
      setProbe({ state: "idle" });
    }
  }, [open]);

  const trimmedPasskey = passkey.trim();
  const passkeyValid = trimmedPasskey.length > 0;
  const command = `npx tsx src/cli.ts serve --passkey ${trimmedPasskey}`;
  const npmCommand = `npm run serve -- --passkey ${trimmedPasskey}`;

  const handleCheck = async () => {
    setProbe({ state: "checking" });
    const health = await checkRemoteServiceHealth(url, trimmedPasskey);
    if (health) {
      setProbe({ state: "ok", cc: health.cc });
    } else {
      setProbe({
        state: "fail",
        message:
          "No response from server. Start it in a terminal with the command below.",
      });
    }
  };

  const handleSave = () => {
    setRemoteServiceUrl(url);
    if (passkeyValid) setPasskey(trimmedPasskey);
    onChanged?.();
    onClose();
  };

  const handleRegeneratePasskey = () => {
    setPasskeyState(regeneratePasskey());
    setProbe({ state: "idle" });
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Execution server</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          mtoc is a static translator and cannot run code in the browser. To
          execute the generated C, start a small local server in a terminal and
          the IDE will POST the C source to it for compilation and execution.
        </DialogContentText>

        <Stack spacing={2}>
          <TextField
            label="Server URL"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder={DEFAULT_REMOTE_SERVICE_URL}
            fullWidth
            size="small"
          />

          <TextField
            label="Passkey"
            value={passkey}
            onChange={e => {
              setPasskeyState(e.target.value);
              setProbe({ state: "idle" });
            }}
            fullWidth
            size="small"
            error={!passkeyValid}
            helperText={
              passkeyValid
                ? "Auto-generated for you, but you can replace it with your own. Whatever you use here must match the --passkey you pass to the server."
                : "Passkey cannot be empty."
            }
            slotProps={{ htmlInput: { spellCheck: false, autoCorrect: "off" } }}
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
              Run from the mtoc repo root. The passkey is stored in this browser
              and persists until you clear site data or regenerate it — if you
              regenerate, restart the server with the new key.
            </Typography>
          </Box>

          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="outlined"
              size="small"
              onClick={handleCheck}
              disabled={probe.state === "checking"}
            >
              {probe.state === "checking" ? "Checking…" : "Check connection"}
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

          {probe.state === "ok" && (
            <Typography variant="body2" color="success.main">
              Connected. Compiler: <code>{probe.cc}</code>
            </Typography>
          )}
          {probe.state === "fail" && (
            <Typography variant="body2" color="warning.main">
              {probe.message}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!passkeyValid}
        >
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
