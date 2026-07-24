import { request } from "./client"
import type { Dataset } from "./types"

/**
 * Upload a recording. The server parses it synchronously and rejects an
 * unreadable file with a 400, so a resolved promise means the dataset is
 * `parsed` and can back a session immediately.
 */
export function uploadDataset(file: File, subjectId?: string): Promise<Dataset> {
  const form = new FormData()
  form.append("file", file)
  if (subjectId) form.append("subjectId", subjectId)

  return request<Dataset>("/datasets/upload", { method: "POST", body: form })
}

export function listDatasets(): Promise<Dataset[]> {
  return request<Dataset[]>("/datasets")
}

export function getDataset(datasetId: string): Promise<Dataset> {
  return request<Dataset>(`/datasets/${datasetId}`)
}

export function deleteDataset(datasetId: string): Promise<void> {
  return request<void>(`/datasets/${datasetId}`, { method: "DELETE" })
}
