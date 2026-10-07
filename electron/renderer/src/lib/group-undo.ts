/** One process-session owner: toast and native menu consume the same action. */
let action: (() => Promise<void>) | null = null;
let busy = false;
export function rememberGroupUndo(next: () => Promise<void>): () => Promise<void> {
  let consumed = false;
  const owned = async (): Promise<void> => {
    if (consumed || busy) return;
    consumed = true;
    if (action === owned) action = null;
    busy = true;
    try {
      await next();
    } finally {
      busy = false;
    }
  };
  action = owned;
  return owned;
}
export async function undoGroupMove(): Promise<void> {
  if (!action || busy) return;
  await action();
}
if (typeof window !== 'undefined')
  window.addEventListener('mn:undo-group-move', () => {
    void undoGroupMove();
  });
