import { useState } from 'react';

export const NOTE_MAX_LENGTH = 2000;

type NoteEditorProps = {
  title: string;
  initialContent: string;
  busy: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onCancel: () => void;
};

// 多行备注编辑弹窗：打开时读取已保存值；保存空字符串 = 清空本页备注；
// 取消不修改；保存失败由父级保留本弹窗并传入 error，输入内容不丢。
export function NoteEditor({
  title,
  initialContent,
  busy,
  error,
  onSave,
  onCancel,
}: NoteEditorProps): React.JSX.Element {
  const [content, setContent] = useState(initialContent);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <textarea
          aria-label="备注内容"
          rows={8}
          maxLength={NOTE_MAX_LENGTH}
          value={content}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
        />
        <p className="note-hint">
          多行纯文本，最多 {NOTE_MAX_LENGTH} 字（当前 {content.length} 字）；保存空内容即清空本页备注。
        </p>
        {error !== null && <p role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => onSave(content)}>
            保存
          </button>
          <button type="button" disabled={busy} onClick={() => setContent('')}>
            清空
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
