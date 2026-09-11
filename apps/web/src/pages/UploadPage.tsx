import { useEffect, useState } from 'react';
import type { Progress, UploadResult } from '@auto-reimbursement/contracts';
import { api } from '../api';

type UploadClient = Pick<typeof api, 'upload' | 'progress' | 'imageUrl' | 'receiptOriginalUrl'>;

const EMPTY_PROGRESS: Progress = { total: 0, recognizing: 0, ready: 0, pending: 0 };

export function UploadPage({ client = api }: { client?: UploadClient }): React.JSX.Element {
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [accepted, setAccepted] = useState<UploadResult['accepted']>([]);
  const [acceptedFiles, setAcceptedFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<UploadResult['rejected']>([]);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [retryVersion, setRetryVersion] = useState(0);

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

  async function submit(files: File[]): Promise<void> {
    if (files.length > 50) {
      setError('单次最多 50 张');
      return;
    }
    if (files.length === 0 || isUploading) return;

    setError(null);
    setPollError(null);
    setIsUploading(true);
    setBatchFiles(files);
    try {
      const result = await client.upload(files);
      setAccepted(result.accepted);
      setRejected(result.rejected);
      const rejectedIndexes = new Set(result.rejected.map((item) => item.index));
      setAcceptedFiles(files.filter((_, index) => !rejectedIndexes.has(index)));
      const ids = result.accepted.map((receipt) => receipt.id);
      setProgress({ total: ids.length, recognizing: ids.length, ready: 0, pending: 0 });
      setActiveIds(ids);
    } catch (reason) {
      setError(`上传失败：${reason instanceof Error ? reason.message : '网络错误'}`);
      setActiveIds([]);
      setProgress(EMPTY_PROGRESS);
    } finally {
      setIsUploading(false);
    }
  }

  function retryProgress(): void {
    setPollError(null);
    setRetryVersion((version) => version + 1);
  }

  return (
    <main className="page-content">
      <section aria-labelledby="upload-heading" className="upload-panel">
        <h2 id="upload-heading">上传凭证</h2>
        <p>一次可上传最多 50 张 JPEG、PNG 或 WebP 图片。</p>
        <label
          aria-label="拖放凭证图片"
          className="drop-target"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void submit(Array.from(event.dataTransfer.files));
          }}
        >
          <strong>{isUploading ? `正在上传 ${batchFiles.length} 张…` : '拖放图片到这里，或点击选择文件'}</strong>
          <input
            aria-label="选择凭证图片"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            disabled={isUploading}
            onChange={(event) => void submit(Array.from(event.target.files ?? []))}
          />
        </label>
        {error && <p role="alert">{error}</p>}
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
                  {item.duplicateId ? '重复文件' : '未接收文件'}：{batchFiles[item.index]?.name ?? `第 ${item.index + 1} 张`}
                  {item.duplicateId && <>（<a href={client.receiptOriginalUrl(item.duplicateId)}>查看重复凭证</a>）</>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
