import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { MAX_WORKSPACE_NAME } from './app/workspaces.ts';

export type WorkspaceDialogRequest =
  | { mode: 'save'; name?: string }
  | { mode: 'delete'; custom: string[]; selected?: string };

export type WorkspaceDialogAction =
  | { kind: 'save'; name: string }
  | { kind: 'delete'; name: string };

export interface WorkspaceDialogHandle { open(request: WorkspaceDialogRequest): void }

export function WorkspaceDialog({ ref, act }: { ref: Ref<WorkspaceDialogHandle>; act: (action: WorkspaceDialogAction) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [request, setRequest] = useState<WorkspaceDialogRequest | null>(null);
  const [name, setName] = useState('');

  useImperativeHandle(ref, () => ({
    open(next) {
      setRequest(next);
      setName(next.mode === 'save' ? next.name ?? '' : (next.selected && next.custom.includes(next.selected) ? next.selected : next.custom[0] ?? ''));
      dialog.current?.showModal();
    },
  }));

  const close = () => { dialog.current?.close(); setRequest(null); };
  const submit = () => {
    if (!request) return;
    const clean = name.trim();
    if (!clean) return;
    const action: WorkspaceDialogAction = request.mode === 'save' ? { kind: 'save', name: clean } : { kind: 'delete', name: clean };
    close();
    act(action);
  };

  return (
    <dialog ref={dialog} className="mode-dialog" aria-label={request?.mode === 'delete' ? 'Delete Workspace' : 'Save Workspace'} onClose={() => setRequest(null)}>
      <form onSubmit={event => { event.preventDefault(); submit(); }}>
        <h2>{request?.mode === 'delete' ? 'Delete Workspace' : 'Save Workspace'}</h2>
        {request?.mode === 'delete' ? (
          <label>Workspace <select value={name} onChange={event => setName(event.currentTarget.value)}>
            {request.custom.map(item => <option key={item} value={item}>{item}</option>)}
          </select></label>
        ) : (
          <label>Name <input autoFocus maxLength={MAX_WORKSPACE_NAME} value={name} onChange={event => setName(event.currentTarget.value)} /></label>
        )}
        <div className="actions">
          <button type="button" onClick={close}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>{request?.mode === 'delete' ? 'Delete' : 'Save'}</button>
        </div>
      </form>
    </dialog>
  );
}
