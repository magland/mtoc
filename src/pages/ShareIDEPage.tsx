import HomeIcon from "@mui/icons-material/Home";
import { Alert, Box, IconButton, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { useShareProjectFiles } from "../hooks/useShareProjectFiles";
import { IDEWorkspace } from "../components/IDEWorkspace";

export function ShareIDEPage() {
  const navigate = useNavigate();
  const filesApi = useShareProjectFiles();

  const headerContent = (
    <Box sx={{ display: "flex", alignItems: "center", px: 1, py: 0.5 }}>
      <IconButton size="small" onClick={() => navigate("/")} sx={{ mr: 0.5 }}>
        <HomeIcon fontSize="small" />
      </IconButton>
      <Typography variant="body2" fontWeight="medium" sx={{ flexGrow: 1 }}>
        Shared project (read-only)
      </Typography>
      {filesApi.urlSizeTooLarge && (
        <Alert severity="warning" sx={{ py: 0, mr: 1 }}>
          Project is too large for the share URL.
        </Alert>
      )}
    </Box>
  );

  return <IDEWorkspace filesApi={filesApi} header={headerContent} />;
}
