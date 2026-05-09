import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ShareIcon from "@mui/icons-material/Share";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { useCallback, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useProject } from "../hooks/useProject";
import { useProjectFiles } from "../hooks/useProjectFiles";
import { IDEWorkspace } from "../components/IDEWorkspace";
import { encodeShareData } from "../utils/shareUrl";
import { getFileContent } from "../db/operations";

export function ProjectIDEPage() {
  const { projectName } = useParams<{ projectName: string }>();
  const navigate = useNavigate();
  const [copyFeedback, setCopyFeedback] = useState(false);

  const {
    project,
    loading: projectLoading,
    error: projectError,
  } = useProject(projectName!);
  const filesApi = useProjectFiles(projectName!);
  const { files, activeFileId, loading: filesLoading } = filesApi;

  const handleShare = useCallback(async () => {
    try {
      // Pull every file's bytes so the share URL contains the whole project.
      const map = new Map<string, Uint8Array>();
      for (const f of files) {
        const cached = filesApi.contentCache.current.get(f.id);
        map.set(f.id, cached ?? (await getFileContent(f.id)));
      }
      const encoded = encodeShareData(files, map, activeFileId);
      const url = `${window.location.origin}/share#${encoded}`;
      if (url.length > 64000) {
        alert(
          "Project is too large to share via URL. Try reducing the number or size of files."
        );
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (e) {
      console.error("Failed to generate share URL:", e);
      alert("Failed to generate share URL.");
    }
  }, [files, activeFileId, filesApi.contentCache]);

  if (projectLoading || filesLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (projectError || !project) {
    return (
      <Box sx={{ p: 4 }}>
        <Typography variant="h4" color="error" gutterBottom>
          {projectError ? "Error Loading Project" : "Project not found"}
        </Typography>
        {projectError && (
          <Typography variant="body1">{projectError.message}</Typography>
        )}
        <Button
          variant="contained"
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate("/")}
          sx={{ mt: 2 }}
        >
          Back to Projects
        </Button>
      </Box>
    );
  }

  const headerContent = (
    <Box sx={{ display: "flex", alignItems: "center", px: 1, py: 0.5 }}>
      <IconButton size="small" onClick={() => navigate("/")} sx={{ mr: 0.5 }}>
        <ArrowBackIcon fontSize="small" />
      </IconButton>
      <Typography variant="body2" fontWeight="medium" sx={{ flexGrow: 1 }}>
        {project.displayName || project.name}
      </Typography>
      <Tooltip title={copyFeedback ? "Copied!" : "Copy shareable URL"}>
        <IconButton size="small" onClick={handleShare}>
          <ShareIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );

  return <IDEWorkspace filesApi={filesApi} header={headerContent} />;
}
