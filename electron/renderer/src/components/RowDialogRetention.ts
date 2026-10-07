import { createContext } from 'react';

/** Optional signal for a virtualized row's owned dialog. Opening retains the
 * row independently of DOM focus; closing/unmounting releases that retention.
 * Normal lists/detail views have no provider and need no lifecycle changes. */
export const RowDialogRetention = createContext<((meetingId: string, open: boolean) => void) | null>(null);
