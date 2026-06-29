// electron/renderer/src/components/Toasts.tsx
//
// Minimal toast system. Intentionally tiny — one stack at the bottom-right,
// auto-dismiss on timer, optional Action button. Pairs with the undoable
// delete (UX rec #2) but is generic enough for future async-completion
// notifications (export finished, processing done, etc.).
//
// Usage:
//   const toast = useToast();
//   toast.show({
//     message: 'Meeting deleted',
//     action: { label: 'Undo', onClick: () => ... },
//     durationMs: 8000,
//   });
//
// Render the <ToastHost/> once near the root of the app.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastRequest {
  /** Visible message. Kept short; no HTML. */
  message: string;
  /** Optional action button (e.g., "Undo"). */
  action?: ToastAction;
  /** Auto-dismiss duration in ms. Default 6000. `null` = sticky. */
  durationMs?: number | null;
  /** Visual style. 'default' for neutral, 'error' for rose. */
  variant?: 'default' | 'error';
}

interface ToastState extends ToastRequest {
  id: string;
}

interface ToastContextValue {
  show: (t: ToastRequest) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastHost>');
  return ctx;
}

export function ToastHost({ children }: { children: React.ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const timersRef = useRef<Record<string, number>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const t = timersRef.current[id];
    if (t !== undefined) { window.clearTimeout(t); delete timersRef.current[id]; }
  }, []);

  const show = useCallback((req: ToastRequest) => {
    const id = Math.random().toString(36).slice(2, 10);
    setToasts((prev) => [...prev, { ...req, id }]);
    const duration = req.durationMs === undefined ? 6000 : req.durationMs;
    if (duration !== null && duration > 0) {
      timersRef.current[id] = window.setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);

  // Clean up timers on unmount so hot-reloads don't leave dangling setTimeouts.
  useEffect(() => () => {
    Object.values(timersRef.current).forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          className="fixed bottom-6 right-6 z-[1100] flex flex-col gap-2 pointer-events-none"
        >
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast, onDismiss,
}: {
  toast: ToastState;
  onDismiss: () => void;
}): JSX.Element {
  const variantClass =
    toast.variant === 'error'
      ? 'bg-danger-solid text-white border-danger-border'
      : 'bg-ink text-surface border-ink';
  return (
    <div
      className={`pointer-events-auto min-w-[280px] max-w-md rounded-lg border shadow-pop px-4 py-3 flex items-center gap-3 text-sm ${variantClass}`}
    >
      <span className="flex-1 truncate">{toast.message}</span>
      {toast.action && (
        <button
          onClick={() => { void toast.action!.onClick(); onDismiss(); }}
          className="font-semibold underline underline-offset-2 hover:no-underline"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="opacity-60 hover:opacity-100 transition"
      >
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
