import { useEffect, useRef, useState } from 'react';
import { CATEGORIES, type Batch, type FormOptions } from '@auto-reimbursement/contracts';
import { api, apiUrl, openAuthed } from '../api';
import { NoteEditor } from '../components/NoteEditor';
import { ReconcileWorkspace } from '../components/ReconcileWorkspace';

interface SavedSnapshot {
  options: FormOptions;
  noteBySheet: Record<string, string | null>;
}

function noteBySheetOf(batch: Batch): Record<string, string | null> {
  return Object.fromEntries(batch.sheets.map((sheet) => [sheet.id, sheet.noteId]));
}

function snapshotOf(batch: Batch): SavedSnapshot {
  return { options: batch.options, noteBySheet: noteBySheetOf(batch) };
}

export function PreviewPage({ batchId }: { batchId: string | null }): React.JSX.Element {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  // P-05：记录最近一次保存到服务器的快照，用于 dirty 判断与「已保存」反馈
  const [saved, setSaved] = useState<SavedSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (batchId === null) {
      setBatch(null);
      setSaved(null);
      return;
    }
    void api.batch(batchId).then((loaded) => {
      setBatch(loaded);
      setSaved(snapshotOf(loaded));
    }, (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : '加载预览失败'),
    );
  }, [batchId]);

  const dirty =
    batch !== null &&
    saved !== null &&
    (JSON.stringify(batch.options) !== JSON.stringify(saved.options) ||
      JSON.stringify(noteBySheetOf(batch)) !== JSON.stringify(saved.noteBySheet));
  // 渲染期同步刷新 ref：若挂在依赖 dirty 的被动 effect 上，快速连续「编辑→跳转」
  // 会在 effect 运行前漏掉守卫（e2e 曾复现）。监听器改为挂载一次、经 ref 读最新值。
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // P-05：有未保存修改时，关闭/刷新页面与站内跳转都要提示
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
      }
    };
    const onHashChange = (event: HashChangeEvent) => {
      if (!dirtyRef.current) return;
      const target = new URL(event.newURL).hash;
      const leaving = !target.startsWith('#preview') && !/^#batches\/[^/]+\/preview$/.test(target);
      if (leaving && !window.confirm('有未保存的修改，确定离开吗？')) {
        window.location.hash = new URL(event.oldURL).hash;
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const errorText = (reason: unknown, fallback: string) =>
    reason instanceof Error
      ? `${typeof (reason as Error & { code?: unknown }).code === 'string' ? `${(reason as Error & { code: string }).code}：` : ''}${reason.message}`
      : fallback;

  async function save(options: FormOptions, notes: Record<string, string | null>): Promise<void> {
    if (!batch) return;
    setBusy(true);
    try {
      const savedBatch = await api.saveBatchOptions(batch.id, options, notes);
      setBatch(savedBatch);
      setSaved(snapshotOf(savedBatch));
      setNotice('已保存');
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(errorText(reason, '保存失败'));
    } finally {
      setBusy(false);
    }
  }

  async function move(category: (typeof CATEGORIES)[number], direction: -1 | 1): Promise<void> {
    if (!batch) return;
    setBusy(true);
    try {
      const moved = await api.moveGroup(batch.id, category, direction);
      // P-05：服务器返回的是旧快照，必须合并回本地未保存的选项与备注选择
      setBatch({
        ...moved,
        options: batch.options,
        sheets: moved.sheets.map((sheet) => {
          const local = batch.sheets.find((item) => item.id === sheet.id);
          return local === undefined ? sheet : { ...sheet, noteId: local.noteId };
        }),
      });
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(errorText(reason, '调整失败'));
    } finally {
      setBusy(false);
    }
  }

  async function exportCurrent(): Promise<void> {
    if (!batch) return;
    // P-05：有未保存修改时先保存再导出，避免按服务器旧值定稿
    if (dirty) {
      setBusy(true);
      try {
        const savedBatch = await api.saveBatchOptions(batch.id, batch.options, noteBySheetOf(batch));
        setBatch(savedBatch);
        setSaved(snapshotOf(savedBatch));
        setNotice('已保存');
        setRevision((value) => value + 1);
      } catch (reason) {
        setError(errorText(reason, '保存失败'));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    // P-05：导出即定稿，点击前二次确认将锁定的内容
    const { department, signerName, date } = batch.options;
    if (
      !window.confirm(
        `生成后将锁定：部门 ${department || '（空）'}、报销人 ${signerName || '（空）'}、日期 ${date || '（空）'}。确定生成 PDF 吗？`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const exported = await api.exportBatch(batch.id);
      setBatch(exported);
      setSaved(snapshotOf(exported));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成失败');
    } finally {
      setBusy(false);
    }
  }

  async function cancelAndRecreate(): Promise<void> {
    if (!batch) return;
    if (!window.confirm('撤销后票据将退回本次报销池，可修正后重新生成报销单；已生成的 PDF 将保留为作废件。确定撤销吗？')) return;
    setBusy(true);
    try {
      await api.cancelBatch(batch.id);
      window.location.hash = '#pool';
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '撤销失败');
      setBusy(false);
    }
  }

  // 备注保存：空字符串 = 清空本页备注（解除关联）；有独立备注则就地更新批次快照；
  // 无备注或备注被其他页共用则新建批次内备注再关联。失败保留弹窗与输入。
  async function saveSheetNote(sheetId: string, content: string): Promise<void> {
    if (!batch) return;
    setBusy(true);
    setNoteError(null);
    try {
      if (content === '') {
        const noteBySheet = Object.fromEntries(batch.sheets.map((sheet) => [sheet.id, sheet.noteId]));
        const persisted = { ...noteBySheet, [sheetId]: null };
        setBatch(await api.saveBatchOptions(batch.id, batch.options, persisted));
        // 该调用同时持久化了本地 options，saved 快照同步推进
        setSaved({ options: batch.options, noteBySheet: persisted });
      } else {
        const sheet = batch.sheets.find((item) => item.id === sheetId);
        if (sheet === undefined) return;
        const shared =
          sheet.noteId !== null &&
          batch.sheets.some((item) => item.id !== sheetId && item.noteId === sheet.noteId);
        if (sheet.noteId !== null && !shared) {
          // 保留用户尚未保存的本地选项（部门/日期/签名人），不能用服务器快照覆盖
          const updated = await api.updateBatchNote(batch.id, sheet.noteId, { content });
          setBatch({ ...updated, options: batch.options });
        } else {
          const sheetIndex = batch.sheets.findIndex((item) => item.id === sheetId);
          const withNote = await api.createBatchNote(batch.id, {
            name: `第 ${sheetIndex + 1} 页手写备注`,
            content,
          });
          const created = withNote.notes.find(
            (note) => !batch.notes.some((existing) => existing.id === note.id),
          );
          if (created === undefined) throw new Error('备注创建失败');
          const noteBySheet = Object.fromEntries(withNote.sheets.map((item) => [item.id, item.noteId]));
          // 用本地当前 options 保存，避免把未保存的部门/签名人输入回写成服务器旧值
          const persisted = { ...noteBySheet, [sheetId]: created.id };
          setBatch(await api.saveBatchOptions(batch.id, batch.options, persisted));
          setSaved({ options: batch.options, noteBySheet: persisted });
        }
      }
      setRevision((value) => value + 1);
      setEditingSheetId(null);
    } catch (reason) {
      setNoteError(errorText(reason, '保存备注失败'));
    } finally {
      setBusy(false);
    }
  }

  if (batchId === null) {
    return (
      <main className="page-content">
        <h2>生成预览</h2>
        <p>请先在报销池生成报销单，或从历史报销单中选择一个批次。</p>
      </main>
    );
  }
  if (batch === null) {
    return (
      <main className="page-content">
        <h2>生成预览</h2>
        {error ? <p role="alert">{error}</p> : <p>正在加载预览…</p>}
      </main>
    );
  }

  const readonly = batch.pdfPath !== null;
  const previewUrl = apiUrl(`/api/batches/${encodeURIComponent(batch.id)}/preview.pdf`);
  const editingSheet = batch.sheets.find((sheet) => sheet.id === editingSheetId) ?? null;
  const editingNote =
    editingSheet?.noteId == null
      ? null
      : (batch.notes.find((note) => note.id === editingSheet.noteId) ?? null);

  return (
    <main className="page-content reconcile-page">
      <h2>生成预览</h2>
      {error && <p role="alert">{error}</p>}
      <ReconcileWorkspace batch={batch} previewUrl={`${previewUrl}?revision=${revision}`} />
      <p>
        <a
          href={batch.pdfPath === null ? previewUrl : apiUrl(`/api/batches/${encodeURIComponent(batch.id)}/pdf`)}
          onClick={(event) => {
            event.preventDefault();
            void openAuthed(
              batch.pdfPath === null
                ? `/api/batches/${encodeURIComponent(batch.id)}/preview.pdf`
                : `/api/batches/${encodeURIComponent(batch.id)}/pdf`,
            );
          }}
        >
          打开或下载 PDF
        </a>
      </p>
      <fieldset disabled={readonly || busy}>
        <legend>报销单选项</legend>
        <label>
          部门
          <input
            value={batch.options.department}
            onChange={(e) => {
              setNotice(null);
              setBatch({ ...batch, options: { ...batch.options, department: e.target.value } });
            }}
          />
        </label>
        <label>
          日期
          <input
            value={batch.options.date ?? ''}
            onChange={(e) => {
              setNotice(null);
              setBatch({ ...batch, options: { ...batch.options, date: e.target.value || null } });
            }}
          />
        </label>
        <label>
          签名人
          <input
            value={batch.options.signerName}
            onChange={(e) => {
              setNotice(null);
              setBatch({ ...batch, options: { ...batch.options, signerName: e.target.value } });
            }}
          />
        </label>
        {batch.sheets.map((sheet, index) => (
          <div key={sheet.id} className="sheet-note-row">
            <label>
              第 {index + 1} 页备注（选模板会替换当前备注）
              <select
                aria-label={`第 ${index + 1} 页备注模板`}
                value={sheet.noteId ?? ''}
                onChange={(e) => {
                  const value = e.target.value || null;
                  setNotice(null);
                  setBatch({
                    ...batch,
                    sheets: batch.sheets.map((item) =>
                      item.id === sheet.id ? { ...item, noteId: value } : item,
                    ),
                  });
                }}
              >
                <option value="">无备注</option>
                {batch.notes.map((note) => (
                  <option key={note.id} value={note.id}>
                    {note.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                setNoteError(null);
                setEditingSheetId(sheet.id);
              }}
            >
              编辑备注
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            void save(
              batch.options,
              Object.fromEntries(batch.sheets.map((sheet) => [sheet.id, sheet.noteId])),
            )
          }
        >
          保存预览设置
        </button>
        {dirty && <p role="status">有未保存的修改（生成 PDF 前会自动保存）</p>}
        {!dirty && notice !== null && <p role="status">{notice}</p>}
      </fieldset>
      <section>
        <h3>分类顺序</h3>
        {CATEGORIES.filter((category) =>
          batch.sheets.some((sheet) => sheet.groups.some((group) => group.category === category)),
        ).map((category) => (
          <p key={category}>
            {category}{' '}
            <button type="button" disabled={readonly || busy} onClick={() => void move(category, -1)}>
              上一页
            </button>{' '}
            <button type="button" disabled={readonly || busy} onClick={() => void move(category, 1)}>
              下一页
            </button>
          </p>
        ))}
      </section>
      <button type="button" disabled={busy || readonly} onClick={() => void exportCurrent()}>
        生成 PDF
      </button>
      {readonly && (
        <section className="finalized-notice" aria-label="已定稿提示">
          <p>已生成 PDF，报销单已定稿，部门、日期、签名人与备注不可直接修改。</p>
          <p>如需修改，请先撤销本单：票据将退回本次报销池，可修正后重新生成；原 PDF 保留为作废件备查。</p>
          <button type="button" disabled={busy} onClick={() => void cancelAndRecreate()}>
            撤销并退回报销池
          </button>
        </section>
      )}
      {editingSheet !== null && (
        <NoteEditor
          title={`编辑第 ${batch.sheets.findIndex((sheet) => sheet.id === editingSheet.id) + 1} 页备注`}
          initialContent={editingNote?.content ?? ''}
          busy={busy}
          error={noteError}
          onSave={(content) => void saveSheetNote(editingSheet.id, content)}
          onCancel={() => setEditingSheetId(null)}
        />
      )}
    </main>
  );
}
