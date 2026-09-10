import { useState } from 'react';
import type { Note } from '@auto-reimbursement/contracts';

export function NotesEditor({ notes, onSave, onDelete }: { notes: Note[]; onSave: (note: Note) => Promise<void>; onDelete: (id: string) => Promise<void> }): React.JSX.Element {
  const [draft, setDraft] = useState<Note>({ id: '', name: '', content: '' });
  return <section><h3>备注</h3>{notes.map((note) => <article key={note.id}><strong>{note.name}</strong><pre>{note.content}</pre><button type="button" onClick={() => void onDelete(note.id)}>删除备注</button></article>)}<label>名称<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>内容<textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} /></label><button type="button" disabled={!draft.name} onClick={() => void onSave({ ...draft, id: draft.id || crypto.randomUUID() }).then(() => setDraft({ id: '', name: '', content: '' }))}>保存备注</button></section>;
}
