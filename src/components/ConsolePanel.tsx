import { useEffect, useRef } from "react";
import { Box, Typography } from "@mui/material";
import type { ConsoleLine, RunStatus } from "../hooks/useRemoteExecution";

interface ConsolePanelProps {
  lines: ConsoleLine[];
  status: RunStatus;
}

const CHANNEL_COLORS: Record<ConsoleLine["channel"], string> = {
  stdout: "text.primary",
  stderr: "warning.main",
  compile_error: "error.main",
  translate_error: "error.main",
  info: "text.secondary",
};

function statusLabel(status: RunStatus): string {
  switch (status) {
    case "idle":
      return "Console — click Run to compile and execute";
    case "compiling":
      return "Compiling WASM…";
    case "running":
      return "Running…";
    case "success":
      return "Exited 0";
    case "error":
      return "Exited with error";
    case "aborted":
      return "Stopped";
    case "compile_error":
      return "Compile error";
  }
}

export function ConsolePanel({ lines, status }: ConsolePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Autoscroll to bottom on new output.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderTop: 1,
        borderColor: "divider",
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
          CONSOLE
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {statusLabel(status)}
        </Typography>
      </Box>
      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.45,
          px: 1.5,
          py: 1,
          whiteSpace: "pre-wrap",
        }}
      >
        {lines.length === 0 ? (
          <Typography
            variant="caption"
            sx={{ color: "text.disabled", fontStyle: "italic" }}
          >
            (no output)
          </Typography>
        ) : (
          lines.map((line, i) => (
            <Box
              key={i}
              component="span"
              sx={{ color: CHANNEL_COLORS[line.channel] }}
            >
              {line.text}
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
