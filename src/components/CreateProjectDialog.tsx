import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Typography,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import { validateProjectName } from "../utils/validation";
import { createProject, listProjects } from "../db/operations";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

export function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: CreateProjectDialogProps) {
  const [projectName, setProjectName] = useState("");
  const [error, setError] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    listProjects().then(projects => {
      const existing = new Set(projects.map(p => p.name));
      let name = "untitled";
      let i = 2;
      while (existing.has(name)) name = `untitled-${i++}`;
      setProjectName(name);
    });
  }, [open]);

  const inputElRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open && projectName && inputElRef.current) {
      inputElRef.current.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectName === ""]);

  const handleCreate = async () => {
    const projects = await listProjects();
    const existingNames = projects.map(p => p.name);
    const validation = validateProjectName(projectName, existingNames);
    if (!validation.valid) {
      setError(validation.error || "Invalid project name");
      return;
    }
    setCreating(true);
    try {
      await createProject(projectName);
      navigate(`/project/${projectName}`);
      handleClose();
      onCreated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    if (creating) return;
    setProjectName("");
    setError("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create New Project</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          inputRef={inputElRef}
          margin="dense"
          label="Project Name"
          type="text"
          fullWidth
          variant="outlined"
          value={projectName}
          onChange={e => {
            setProjectName(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={e => {
            if (e.key === "Enter" && !creating) handleCreate();
          }}
          error={!!error}
          helperText={
            error ||
            "Use only letters, numbers, dashes, and underscores (no spaces)"
          }
          disabled={creating}
        />
        {error && (
          <Typography variant="caption" color="error" sx={{ mt: 1 }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={creating}>
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          variant="contained"
          disabled={!projectName.trim() || creating}
        >
          {creating ? "Creating..." : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
