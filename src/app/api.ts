/** Typed calls to the local server (server/api.ts). */
import type { ExportPlan, ExportStatus, MediaRecord, MediaStatus } from "../../shared/types";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) throw new Error((data as { error?: string } | null)?.error ?? `${response.status} ${response.statusText}`);
  return data as T;
}

function post<T>(url: string, body: unknown = {}): Promise<T> {
  return call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export const api = {
  registerMedia: (path: string) => post<MediaRecord>("/api/media/register", { path }),
  uploadMedia: (file: File) => call<MediaRecord>(`/api/media/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file }),
  mediaStatus: (id: string) => call<MediaStatus>(`/api/media/${id}/status`),
  mediaUrl: (id: string, proxy: boolean) => `/api/media/${id}/file${proxy ? "?proxy=1" : ""}`,
  peaks: async (id: string): Promise<Float32Array | null> => {
    const response = await fetch(`/api/media/${id}/peaks`);
    if (!response.ok) return null;
    return new Float32Array(await response.arrayBuffer());
  },

  pickMedia: (initialDir?: string) => post<{ path: string | null }>("/api/dialog/open-media", { initialDir }),
  pickProject: () => post<{ path: string | null }>("/api/dialog/open-project"),
  pickProjectSave: (fileName: string, initialDir?: string) => post<{ path: string | null }>("/api/dialog/save-project", { fileName, initialDir }),
  pickExport: (fileName: string, initialDir?: string) => post<{ path: string | null }>("/api/dialog/save-export", { fileName, initialDir }),
  reveal: (path: string) => post<{ ok: boolean }>("/api/reveal", { path }),
  exists: (path: string) => post<{ exists: boolean }>("/api/exists", { path }),

  loadAutosave: () => call<unknown>("/api/autosave"),
  saveAutosave: (data: unknown) => call<{ ok: boolean }>("/api/autosave", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
  saveProject: (path: string, project: unknown) => post<{ path: string }>("/api/project/save", { path, project }),
  readProject: (path: string) => post<{ path: string; project: unknown }>("/api/project/read", { path }),

  createExport: () => post<{ id: string }>("/api/export/jobs"),
  uploadExportImage: (job: string, index: number | "blank", png: Blob) => call<{ ok: boolean }>(`/api/export/jobs/${job}/images/${index}`, { method: "PUT", body: png }),
  startExport: (job: string, plan: ExportPlan) => post<ExportStatus>(`/api/export/jobs/${job}/start`, { plan }),
  exportStatus: (job: string) => call<ExportStatus>(`/api/export/jobs/${job}`),
  cancelExport: (job: string) => post<ExportStatus>(`/api/export/jobs/${job}/cancel`),
};

export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : "";
}

export function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return path.slice(index + 1);
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
