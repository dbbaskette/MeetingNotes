// electron/renderer/src/views/meeting-detail/EditableTitle.tsx
// Moved out of MeetingDetailView.tsx (#256).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import { Icon } from '../../components/icons';

/** Click-to-edit meeting title for the detail header (#A5). Display mode
 *  is a button with a quiet hover affordance (dotted underline + faint
 *  pencil) so the interaction is discoverable without shouting; clicking
 *  swaps in an input seeded with the current title, focused + selected.
 *  Enter saves, Esc cancels, blur saves-if-changed; an empty/whitespace
 *  title cancels rather than saving. Persists through the SAME
 *  meetings:rename IPC the ⋯ menu's rename dialog uses, then reloads. */
export function EditableTitle({
  id, title, onRenamed,
}: {
  id: string;
  title: string;
  onRenamed: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set when Enter/Esc already resolved the edit, so the blur the
  // resolution itself triggers doesn't commit a second time (or commit
  // a value the user just escaped out of).
  const settledRef = useRef(false);

  // True while a pointer button is held. A press on a neighbouring control
  // blurs the field; see the blur handler for why that matters.
  const pressedRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const down = (): void => { pressedRef.current = true; };
    const up = (): void => { pressedRef.current = false; };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      pressedRef.current = false;
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [editing]);

  function start(): void {
    setValue(title);
    settledRef.current = false;
    setEditing(true);
  }

  async function commit(leave = true): Promise<void> {
    if (leave) setEditing(false);
    const trimmed = value.trim();
    // Empty/whitespace → cancel, don't save. Unchanged → no-op.
    if (trimmed === '' || trimmed === title || busy) return;
    setBusy(true);
    try {
      await api.meetings.rename(id, trimmed);
      onRenamed();
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        title="Click to rename"
        className="group max-w-full font-semibold truncate align-middle
                   hover:underline decoration-dotted underline-offset-4"
      >
        {title}
        <span aria-hidden className="ml-1.5 text-xs opacity-0 group-hover:opacity-40 transition-opacity"><Icon name="pencil" className="inline w-3 h-3" /></span>
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      value={value}
      disabled={busy}
      maxLength={500}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          settledRef.current = true;
          void commit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          settledRef.current = true;
          setEditing(false);
        }
      }}
      onBlur={() => {
        if (settledRef.current) return;
        if (!pressedRef.current) { void commit(); return; }
        // The blur came from pressing another control. The field is wider
        // than the title, so leaving edit mode now would slide the header
        // out from under the pointer and the click would never arrive. Save
        // now; put the title back once the click has been delivered.
        settledRef.current = true;
        void commit(false);
        const leave = (): void => {
          window.removeEventListener('pointerup', leave, true);
          window.removeEventListener('pointercancel', leave, true);
          setTimeout(() => setEditing(false), 0);
        };
        window.addEventListener('pointerup', leave, true);
        window.addEventListener('pointercancel', leave, true);
      }}
      aria-label="Meeting title"
      className="w-full max-w-md text-center font-semibold bg-surface border border-brand-indigo/60
                 rounded-md px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-brand-indigo/30
                 disabled:opacity-60"
    />
  );
}
