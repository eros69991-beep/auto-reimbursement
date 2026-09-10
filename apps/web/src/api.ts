import type {
  ApiErrorBody,
  Batch,
  BackupResult,
  Category,
  FormOptions,
  Progress,
  HistoryMonth,
  MaintenanceResult,
  Note,
  Receipt,
  Rule,
  Settings,
  Totals,
  UploadResult,
} from '@auto-reimbursement/contracts';

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as Partial<ApiErrorBody> | null;
    const failure = new Error(typeof error?.message === 'string' ? error.message : '请求失败');
    Object.assign(failure, { code: typeof error?.code === 'string' ? error.code : null });
    throw failure;
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
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

function receipts(view: 'pool' | 'pending'): Promise<Receipt[]> {
  return requestJson<Receipt[]>(`/api/receipts?view=${view}`);
}

function totals(): Promise<Totals> {
  return requestJson<Totals>('/api/pool/totals');
}

function updateReceipt(id: string, patch: { paidFen?: number; category?: Category }): Promise<Receipt> {
  return requestJson<Receipt>(`/api/receipts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

function confirmReceipt(id: string): Promise<Receipt> {
  return requestJson<Receipt>(`/api/receipts/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
}

function confirmDistinct(id: string): Promise<Receipt> {
  return requestJson<Receipt>(`/api/receipts/${encodeURIComponent(id)}/confirm-distinct`, { method: 'POST' });
}

function retryReceipt(id: string): Promise<Receipt> {
  return requestJson<Receipt>(`/api/receipts/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

function setRefund(id: string, refundFen: number): Promise<Receipt> {
  return requestJson<Receipt>(`/api/receipts/${encodeURIComponent(id)}/refund`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refundFen }),
  });
}

async function addRefundImage(id: string, file: File): Promise<Receipt> {
  const data = new FormData();
  data.append('file', file);
  return requestJson<Receipt>(`/api/receipts/${encodeURIComponent(id)}/refund-images`, {
    method: 'POST',
    body: data,
  });
}

async function deleteReceipt(id: string): Promise<void> {
  const response = await fetch(`/api/receipts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as Partial<ApiErrorBody> | null;
    throw new Error(typeof error?.message === 'string' ? error.message : '请求失败');
  }
}

function settings(): Promise<Settings> {
  return requestJson<Settings>('/api/settings');
}

function createBatch(ids: string[], options: FormOptions): Promise<Batch> {
  return requestJson<Batch>('/api/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receiptIds: ids, options }),
  });
}

function batch(id: string): Promise<Batch> { return requestJson(`/api/batches/${encodeURIComponent(id)}`); }
function moveGroup(id: string, category: Category, direction: -1 | 1): Promise<Batch> { return requestJson(`/api/batches/${encodeURIComponent(id)}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, direction }) }); }
function saveBatchOptions(id: string, options: FormOptions, noteBySheet: Record<string, string | null>): Promise<Batch> { return requestJson(`/api/batches/${encodeURIComponent(id)}/options`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options, noteBySheet }) }); }
function exportBatch(id: string): Promise<Batch> { return requestJson(`/api/batches/${encodeURIComponent(id)}/export`, { method: 'POST' }); }
function history(): Promise<HistoryMonth[]> { return requestJson('/api/history'); }
function saveSettings(settings: Settings): Promise<Settings> { return requestJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }); }
async function saveSignature(file: File): Promise<Settings> { const data = new FormData(); data.append('file', file); return requestJson('/api/settings/signature', { method: 'POST', body: data }); }
function notes(): Promise<Note[]> { return requestJson('/api/notes'); }
function saveNote(note: Note): Promise<Note> { return requestJson(`/api/notes/${encodeURIComponent(note.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(note) }); }
function deleteNote(id: string): Promise<void> { return requestJson(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
function rules(): Promise<Rule[]> { return requestJson('/api/rules'); }
function saveRule(rule: Rule): Promise<Rule> { return requestJson(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) }); }
function deleteRule(id: string): Promise<void> { return requestJson(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
function apiStatus(): Promise<import('@auto-reimbursement/contracts').ApiStatus> { return requestJson('/api/ai/status'); }
function archive(month: string): Promise<MaintenanceResult> { return requestJson(`/api/archive/${encodeURIComponent(month)}`, { method: 'POST' }); }
function unarchive(month: string): Promise<MaintenanceResult> { return requestJson(`/api/unarchive/${encodeURIComponent(month)}`, { method: 'POST' }); }
function cleanup(month: string, confirmation: string): Promise<MaintenanceResult> { return requestJson(`/api/cleanup/${encodeURIComponent(month)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation }) }); }
function backup(): Promise<BackupResult> { return requestJson('/api/backup', { method: 'POST' }); }

export function formOptionsFromSettings(settings: Settings, now: Date): FormOptions {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return {
    department: settings.department,
    date: settings.dateMode === 'blank'
      ? null
      : settings.dateMode === 'custom'
        ? settings.customDate
        : date,
    signerMode: settings.signerMode,
    signerName: settings.signerName,
    signature: settings.signerMode === 'image' ? settings.signature : null,
  };
}

export const api = {
  upload,
  progress,
  imageUrl,
  receipts,
  totals,
  updateReceipt,
  confirmReceipt,
  confirmDistinct,
  retryReceipt,
  setRefund,
  addRefundImage,
  deleteReceipt,
  settings,
  createBatch,
  batch,
  moveGroup,
  saveBatchOptions,
  exportBatch,
  history,
  saveSettings,
  saveSignature,
  notes,
  saveNote,
  deleteNote,
  rules,
  saveRule,
  deleteRule,
  apiStatus,
  archive,
  unarchive,
  cleanup,
  backup,
};
