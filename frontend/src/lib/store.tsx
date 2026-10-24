import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  deriveStatus,
  missingSamples,
  withoutProject,
} from "./mock-service";
import type { DiligenceProject } from "./types";

// v2: projects saved under the earlier key are dropped on purpose, so the demo
// projects that shipped with the prototype no longer appear in a saved list.
const KEY = "diligence-live:v2";

interface Store {
  projects: DiligenceProject[];
  hydrated: boolean;
  updateProject: (id: string, fn: (p: DiligenceProject) => DiligenceProject) => void;
  addProject: (p: DiligenceProject) => void;
  removeProject: (id: string) => void;
  removeAllProjects: () => void;
  loadSamples: () => void;
}

const Ctx = createContext<Store | null>(null);

const touch = (p: DiligenceProject): DiligenceProject => ({
  ...p,
  status: deriveStatus(p),
  updatedAt: new Date().toISOString(),
});

export function StoreProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<DiligenceProject[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setProjects(JSON.parse(raw));
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(KEY, JSON.stringify(projects));
  }, [projects, hydrated]);

  // The demo simulation engine (interviews that started themselves and filled in
  // canned answers) is switched off: interviews now happen only as real live calls
  // (components/live-call.tsx), started by the consultant.

  const updateProject = useCallback((id: string, fn: (p: DiligenceProject) => DiligenceProject) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? touch(fn(p)) : p)));
  }, []);
  const addProject = useCallback((p: DiligenceProject) => setProjects((ps) => [p, ...ps]), []);
  const removeProject = useCallback(
    (id: string) => setProjects((ps) => withoutProject(ps, id)),
    [],
  );
  const removeAllProjects = useCallback(() => setProjects([]), []);
  const loadSamples = useCallback(() => setProjects((ps) => [...missingSamples(ps), ...ps]), []);

  const value = useMemo(
    () => ({
      projects,
      hydrated,
      updateProject,
      addProject,
      removeProject,
      removeAllProjects,
      loadSamples,
    }),
    [projects, hydrated, updateProject, addProject, removeProject, removeAllProjects, loadSamples],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used within StoreProvider");
  return s;
}

export function useProject(id: string) {
  const { projects, updateProject, hydrated } = useStore();
  const project = projects.find((p) => p.id === id);
  const update = useCallback(
    (fn: (p: DiligenceProject) => DiligenceProject) => updateProject(id, fn),
    [id, updateProject],
  );
  return { project, update, hydrated };
}
