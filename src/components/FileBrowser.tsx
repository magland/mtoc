import { useState } from "react";
import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
  Tooltip,
  TextField,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import type { WorkspaceFile } from "../hooks/useProjectFiles";

interface FileBrowserProps {
  files: WorkspaceFile[];
  activeFileId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newName: string) => void;
}

export function FileBrowser({
  files,
  activeFileId,
  onSelect,
  onAdd,
  onDelete,
  onRename,
}: FileBrowserProps) {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startRename = (file: WorkspaceFile) => {
    setRenameId(file.id);
    setRenameValue(file.name);
  };

  const commitRename = () => {
    if (renameId && renameValue.trim() && renameValue.trim() !== "") {
      onRename(renameId, renameValue.trim());
    }
    setRenameId(null);
    setRenameValue("");
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderRight: 1,
        borderColor: "divider",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box sx={{ fontSize: 13, fontWeight: 600, color: "text.secondary" }}>
          FILES
        </Box>
        <Tooltip title="Add file">
          <IconButton size="small" onClick={onAdd}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <List dense disablePadding sx={{ flex: 1, overflowY: "auto" }}>
        {files.map(f => (
          <ListItem
            key={f.id}
            disablePadding
            secondaryAction={
              renameId === f.id ? null : (
                <Box sx={{ display: "flex" }}>
                  <Tooltip title="Rename">
                    <IconButton
                      edge="end"
                      size="small"
                      onClick={e => {
                        e.stopPropagation();
                        startRename(f);
                      }}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      edge="end"
                      size="small"
                      onClick={e => {
                        e.stopPropagation();
                        if (
                          window.confirm(
                            `Delete '${f.name}'? This cannot be undone.`
                          )
                        ) {
                          onDelete(f.id);
                        }
                      }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              )
            }
          >
            {renameId === f.id ? (
              <Box sx={{ px: 2, py: 0.5, width: "100%" }}>
                <TextField
                  size="small"
                  fullWidth
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") {
                      setRenameId(null);
                      setRenameValue("");
                    }
                  }}
                  onBlur={commitRename}
                />
              </Box>
            ) : (
              <ListItemButton
                selected={f.id === activeFileId}
                onClick={() => onSelect(f.id)}
              >
                <ListItemText
                  primary={f.name}
                  primaryTypographyProps={{
                    fontSize: 13,
                    fontFamily: "monospace",
                  }}
                />
              </ListItemButton>
            )}
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
