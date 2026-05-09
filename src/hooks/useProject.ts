import { useState, useEffect, useCallback } from "react";
import { getProject, updateLastOpened } from "../db/operations";
import type { Project } from "../db/schema";

export function useProject(projectName: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadProject = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const proj = await getProject(projectName);
      if (!proj) throw new Error(`Project "${projectName}" not found`);
      await updateLastOpened(projectName);
      setProject(proj);
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Unknown error"));
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    loadProject();
  }, [projectName, loadProject]);

  return { project, loading, error, reload: loadProject };
}
