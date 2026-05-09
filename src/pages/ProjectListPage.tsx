import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  Button,
  Container,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Tooltip,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  CircularProgress,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import GitHubIcon from "@mui/icons-material/GitHub";
import { useNavigate, Link as RouterLink } from "react-router-dom";
import { CreateProjectDialog } from "../components/CreateProjectDialog";
import { listProjects, deleteProject, renameProject } from "../db/operations";
import { validateProjectName } from "../utils/validation";
import type { Project } from "../db/schema";

function formatDate(timestamp: number): string {
  if (!timestamp) return "Never";
  const date = new Date(timestamp);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function ProjectListPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");

  const reload = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    await deleteProject(deleteTarget.name);
    setDeleteTarget(null);
    reload();
  };

  const handleConfirmRename = async () => {
    if (!renameTarget) return;
    const existing = (projects ?? [])
      .filter(p => p.name !== renameTarget.name)
      .map(p => p.name);
    const v = validateProjectName(renameValue, existing);
    if (!v.valid) {
      setRenameError(v.error || "Invalid name");
      return;
    }
    await renameProject(renameTarget.name, renameValue);
    setRenameTarget(null);
    setRenameValue("");
    setRenameError("");
    reload();
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" fontWeight={600}>
            mtoc
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Static numbl-to-C translator. Edit a script and watch the generated
            C update live.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Tooltip title="GitHub">
            <IconButton
              component="a"
              href="https://github.com/flatironinstitute/mtoc"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubIcon />
            </IconButton>
          </Tooltip>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
          >
            New project
          </Button>
        </Stack>
      </Stack>

      {projects === null ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : projects.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: "center" }} variant="outlined">
          <Typography variant="body1" color="text.secondary" gutterBottom>
            No projects yet.
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            sx={{ mt: 1 }}
          >
            Create your first project
          </Button>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Last opened</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {projects.map(p => (
                <TableRow key={p.name} hover>
                  <TableCell>
                    <RouterLink
                      to={`/project/${p.name}`}
                      style={{
                        color: "inherit",
                        textDecoration: "none",
                        fontFamily: "monospace",
                      }}
                      onClick={e => {
                        e.preventDefault();
                        navigate(`/project/${p.name}`);
                      }}
                    >
                      {p.displayName || p.name}
                    </RouterLink>
                  </TableCell>
                  <TableCell>{formatDate(p.lastOpenedAt)}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Rename">
                      <IconButton
                        size="small"
                        onClick={() => {
                          setRenameTarget(p);
                          setRenameValue(p.name);
                          setRenameError("");
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton
                        size="small"
                        onClick={() => setDeleteTarget(p)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <CreateProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={reload}
      />

      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        maxWidth="sm"
      >
        <DialogTitle>Delete project?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will permanently delete <strong>{deleteTarget?.name}</strong>{" "}
            and all of its files. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" onClick={handleConfirmDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Rename project</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="New name"
            value={renameValue}
            onChange={e => {
              setRenameValue(e.target.value);
              if (renameError) setRenameError("");
            }}
            onKeyDown={e => {
              if (e.key === "Enter") handleConfirmRename();
            }}
            error={!!renameError}
            helperText={renameError || " "}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button variant="contained" onClick={handleConfirmRename}>
            Rename
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
