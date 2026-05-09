import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider, createTheme, CssBaseline } from "@mui/material";
import { ProjectListPage } from "./pages/ProjectListPage";
import { ProjectIDEPage } from "./pages/ProjectIDEPage";
import { ShareIDEPage } from "./pages/ShareIDEPage";

const theme = createTheme({
  palette: { mode: "light" },
  typography: { fontSize: 13 },
});

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ProjectListPage />} />
          <Route path="/project/:projectName" element={<ProjectIDEPage />} />
          <Route path="/share" element={<ShareIDEPage />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
