import type { ApiErrorBody, Progress, UploadResult } from '@auto-reimbursement/contracts';

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as Partial<ApiErrorBody> | null;
    throw new Error(typeof error?.message === 'string' ? error.message : '请求失败');
  }
  return response.json() as Promise<T>;
}

async function upload(files: File[]): Promise<UploadResult> {
  const data = new FormData();
  for (const file of files) data.append('files', file);
  return requestJson<UploadResult>('/api/receipts/upload', { method: 'POST', body: data });
}

function progress(ids: string[], signal?: AbortSignal): Promise<Progress> {
  const query = new URLSearchParams({ ids: ids.join(',') });
  return requestJson<Progress>(`/api/progress?${query}`, { signal });
}

function imageUrl(id: string): string {
  return `/api/images/${encodeURIComponent(id)}`;
}

export const api = { upload, progress, imageUrl };
