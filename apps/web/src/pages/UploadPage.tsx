import { useEffect, useState } from 'react';
import type { Progress, UploadResult } from '@auto-reimbursement/contracts';
import { api } from '../api';
import { compressForUpload } from '../compress';

type UploadClient = Pick<typeof api, 'upload' | 'progress' | 'imageUrl' | 'receiptOriginalUrl'>;

const EMPTY_PROGRESS: Progress = { total: 0, recognizing: 0, ready: 0, pending: 0 };
const MAX_FILES = 50;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// P-12：每 3 张一个请求、并发 2，单批失败只影响本批，可单独重试
const CHUNK_SIZE = 3;
const CONCURRENCY = 2;

type RejectedRow = UploadResult['rejected'][number] & { name: string };

interface FileFailure {
  name: string;
  reason: string;
  file: File;
  retryable: boolean;
}

function rejectionReason(code: string): string {
  switch (code) {
    case 'INVALID_IMAGE':
      return '格式不支持或图片损坏';
    case 'IMAGE_TOO_LARGE':
      return '超过 20 MB 限制';
    default:
      return '服务器未接收';
  }
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(runners);
}

export function UploadPage({ client = api }: { client?: UploadClient }): React.JSX.Element {
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [accepted, setAccepted] = useState<UploadResult['accepted']>([]);
  const [acceptedFiles, setAcceptedFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<RejectedRow[]>([]);
  const [failedFiles, setFailedFiles] = useState<FileFailure[]>([]);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [uploadDone, setUploadDone] = useState(0);
  const [uploadBytes, setUploadBytes] = useState({ loaded: 0, total: 0 });
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [retryVersion, setRetryVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  // P-32：与回收站中凭证重复时，一键把原凭证从回收站恢复
  async function restoreDeleted(receiptId: string): Promise<void> {
    setError(null);
    try {
      const restored = await api.restoreReceipt(receiptId);
      setNotice(`已从回收站恢复 ${restored.merchant ?? '原凭证'}，请到「本期报销池」查看。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '恢复失败');
    }
  }

  // P-25：AI 未配置时提前告知（上传后会全部转人工录入），并给出设置入口
  const [aiMissing, setAiMissing] = useState(false);
  useEffect(() => {
    let active = true;
    void api.apiStatus().then((status) => {
      if (active) setAiMissing(!status.configured);
    }, () => {
      // 状态查询失败不阻塞上传流程
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (activeIds.length === 0 || pollError) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await client.progress(activeIds, controller.signal);
        if (disposed) return;
        setProgress(next);
        if (next.recognizing > 0) timer = setTimeout(() => void poll(), 1_000);
      } catch (reason) {
        if (!disposed && !controller.signal.aborted) {
          setPollError(reason instanceof Error ? reason.message : '获取识别进度失败');
        }
      }
    };
    void poll();

    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [activeIds, client, pollError, retryVersion]);

  // append=true 用于「重试失败文件」：结果追加到已有列表，不覆盖之前已接收的文件和识别进度
  async function submit(incoming: File[], carry: FileFailure[] = [], append = false): Promise<void> {
    if (incoming.length === 0 || isUploading) return;
    setError(null);
    setPollError(null);
    if (incoming.length > MAX_FILES) {
      setError('单次最多 50 张');
      return;
    }

    // P-12：逐文件校验，不合格的直接给出原因，不拖累其他文件
    const valid: File[] = [];
    const failures: FileFailure[] = [];
    for (const file of incoming) {
      if (!ACCEPTED_TYPES.has(file.type)) {
        failures.push({ name: file.name, reason: '格式不支持（仅 JPEG、PNG、WebP）', file, retryable: false });
      } else if (file.size > MAX_FILE_BYTES) {
        failures.push({ name: file.name, reason: '超过 20 MB 限制', file, retryable: false });
      } else {
        valid.push(file);
      }
    }
    setFailedFiles([...carry, ...failures]);
    if (valid.length === 0) return;

    setIsUploading(true);
    setUploadDone(0);
    try {
      setBatchFiles(valid);
      const chunks: File[][] = [];
      for (let start = 0; start < valid.length; start += CHUNK_SIZE) {
        chunks.push(valid.slice(start, start + CHUNK_SIZE));
      }
      const results: (UploadResult | null)[] = chunks.map(() => null);
      const failureReasons = chunks.map(() => '网络错误或服务器不可用');
      // 字节进度：压缩前先按原文件大小估算，每批压缩完换成实际上传大小
      const chunkTotals = chunks.map((chunk) => chunk.reduce((sum, file) => sum + file.size, 0));
      const chunkLoaded = chunks.map(() => 0);
      const reportBytes = (): void => setUploadBytes({
        loaded: chunkLoaded.reduce((sum, value) => sum + value, 0),
        total: chunkTotals.reduce((sum, value) => sum + value, 0),
      });
      reportBytes();
      let completed = 0;
      await runPool(chunks, CONCURRENCY, async (chunkFiles, index) => {
        try {
          // 压缩放进上传并发池按批进行（P-12 压缩失败自动回退原图）：同一时刻最多
          // CONCURRENCY × CHUNK_SIZE 张在内存里解码，避免手机一次选几十张照片时同时解码全部原图
          const prepared = await Promise.all(chunkFiles.map((file) => compressForUpload(file)));
          chunkTotals[index] = prepared.reduce((sum, file) => sum + file.size, 0);
          reportBytes();
          results[index] = await client.upload(prepared, (loaded) => {
            chunkLoaded[index] = Math.min(loaded, chunkTotals[index]!);
            reportBytes();
          });
          chunkLoaded[index] = chunkTotals[index]!;
        } catch (reason) {
          // 单批失败不拖累其他批；保留服务器给出的原因（例如限流「上传过于频繁」），方便判断何时重试
          results[index] = null;
          if (reason instanceof Error && reason.message !== '') failureReasons[index] = reason.message;
        } finally {
          completed += chunkFiles.length;
          setUploadDone(completed);
          reportBytes();
        }
      });

      const acceptedAll: UploadResult['accepted'] = [];
      const acceptedFilesAll: File[] = [];
      const rejectedAll: RejectedRow[] = [];
      const networkFailures: FileFailure[] = [];
      chunks.forEach((chunkFiles, chunkIndex) => {
        const result = results[chunkIndex];
        if (result === null) {
          for (const file of chunkFiles) {
            networkFailures.push({ name: file.name, reason: failureReasons[chunkIndex]!, file, retryable: true });
          }
          return;
        }
        const rejectedIndexes = new Map(result.rejected.map((item) => [item.index, item]));
        let acceptedCursor = 0;
        chunkFiles.forEach((file, localIndex) => {
          const rejection = rejectedIndexes.get(localIndex);
          if (rejection !== undefined) {
            rejectedAll.push({ ...rejection, index: chunkIndex * CHUNK_SIZE + localIndex, name: file.name });
            return;
          }
          const receipt = result.accepted[acceptedCursor];
          if (receipt !== undefined) {
            acceptedAll.push(receipt);
            acceptedFilesAll.push(file);
            acceptedCursor += 1;
          }
        });
      });

      setAccepted((previous) => (append ? [...previous, ...acceptedAll] : acceptedAll));
      setAcceptedFiles((previous) => (append ? [...previous, ...acceptedFilesAll] : acceptedFilesAll));
      setRejected((previous) => (append ? [...previous, ...rejectedAll] : rejectedAll));
      setFailedFiles([...carry, ...failures, ...networkFailures]);
      const ids = acceptedAll.map((receipt) => receipt.id);
      if (append) {
        setProgress((previous) => ({
          ...previous,
          total: previous.total + ids.length,
          recognizing: previous.recognizing + ids.length,
        }));
        setActiveIds((previous) => [...previous, ...ids]);
      } else {
        setProgress({ total: ids.length, recognizing: ids.length, ready: 0, pending: 0 });
        setActiveIds(ids);
      }
    } finally {
      setIsUploading(false);
    }
  }

  function retryProgress(): void {
    setPollError(null);
    setRetryVersion((version) => version + 1);
  }

  // P-12：只重传网络失败的文件，校验失败的（格式/大小）重传也没有意义
  async function retryFailed(): Promise<void> {
    const retryable = failedFiles.filter((failure) => failure.retryable);
    if (retryable.length === 0) return;
    const keep = failedFiles.filter((failure) => !failure.retryable);
    await submit(retryable.map((failure) => failure.file), keep, true);
  }

  return (
    <main className="page-content">
      <section aria-labelledby="upload-heading" className="upload-panel">
        <h2 id="upload-heading">上传凭证</h2>
        {aiMissing && (
          <p role="status" className="banner-warning">
            AI 识别未配置：上传的凭证将全部转为人工录入。可在<a href="#settings">设置</a>中配置识别服务。
          </p>
        )}
        <p>一次可上传最多 50 张 JPEG、PNG 或 WebP 图片，单张不超过 20 MB；大图会自动压缩后分批上传。</p>
        <label
          aria-label="拖放凭证图片"
          className="drop-target"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void submit(Array.from(event.dataTransfer.files));
          }}
        >
          <strong>{isUploading
            ? `正在上传 ${uploadDone}/${batchFiles.length} 张（${formatMb(uploadBytes.loaded)}/${formatMb(uploadBytes.total)} MB）…`
            : '拖放图片到这里，或点击选择文件'}</strong>
          <input
            aria-label="选择凭证图片"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            disabled={isUploading}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // P-12：重置 input，重新选择同一批文件也能触发 change
              event.target.value = '';
              void submit(files);
            }}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {pollError && (
          <div className="poll-error" role="status">
            <p>获取识别进度失败，请重试。</p>
            <button type="button" onClick={retryProgress}>重试</button>
          </div>
        )}
      </section>

      <section aria-label="识别进度" className="progress-panel">
        <h2>识别进度</h2>
        <p>总数：{progress.total}</p>
        <p>识别中：{progress.recognizing}</p>
        <p>成功数：{progress.ready}</p>
        <p>待处理数：{progress.pending}</p>
      </section>

      {(accepted.length > 0 || rejected.length > 0) && (
        <section aria-label="上传结果" className="upload-results">
          <h2>上传结果</h2>
          {accepted.length > 0 && (
            <ul aria-label="已接收文件">
              {accepted.map((receipt, index) => <li key={receipt.id}>已接收：{acceptedFiles[index]?.name ?? receipt.id}</li>)}
            </ul>
          )}
          {rejected.length > 0 && (
            <ul aria-label="被拒绝文件">
              {rejected.map((item) => (
                <li key={`${item.index}-${item.code}`}>
                  {item.code === 'DELETED_DUPLICATE' ? '重复文件（在回收站）' : item.duplicateId ? '重复文件' : '未接收文件'}：{item.name}
                  {!item.duplicateId && `（${rejectionReason(item.code)}）`}
                  {item.duplicateId && item.code !== 'DELETED_DUPLICATE' && <>（<a href={client.receiptOriginalUrl(item.duplicateId)} onClick={(event) => { event.preventDefault(); void api.openAuthed(`/api/receipts/${encodeURIComponent(item.duplicateId!)}/original-image`); }}>查看重复凭证</a>）</>}
                  {item.code === 'DELETED_DUPLICATE' && item.duplicateId && (
                    <>（<button type="button" onClick={() => void restoreDeleted(item.duplicateId!)}>从回收站恢复</button>）</>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {failedFiles.length > 0 && (
        <section aria-label="上传失败" className="upload-results">
          <h2>上传失败</h2>
          <ul aria-label="上传失败文件">
            {failedFiles.map((failure, index) => (
              <li key={`${failure.name}-${index}`}>{failure.name}：{failure.reason}</li>
            ))}
          </ul>
          {failedFiles.some((failure) => failure.retryable) && (
            <button type="button" disabled={isUploading} onClick={() => void retryFailed()}>重试失败文件</button>
          )}
        </section>
      )}
    </main>
  );
}
