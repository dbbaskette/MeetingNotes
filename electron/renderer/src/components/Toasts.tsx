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

import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { SPRING } from './motion/spring';
import { createPausableTimer, toastDuration, visibleToasts, type PausableTimer } from '../lib/toast-queue';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastRequest {
  /** Visible message. Kept short; no HTML. */
  message: string;
  /** Optional action button (e.g., "Undo"). */
  action?: ToastAction;
  /** Auto-dismiss duration in ms. Default 6000; errors default to sticky.
   *  `null` = sticky. The countdown pauses while hovered or focused. */
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
  const timersRef = useRef<Record<string, PausableTimer>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const t = timersRef.current[id];
    if (t !== undefined) { t.cancel(); delete timersRef.current[id]; }
  }, []);

  const show = useCallback((req: ToastRequest) => {
    const id = Math.random().toString(36).slice(2, 10);
    setToasts((prev) => [...prev, { ...req, id }]);
    const duration = toastDuration(req);
    if (duration !== null) timersRef.current[id] = createPausableTimer(duration, () => dismiss(id));
    return id;
  }, [dismiss]);

  // Clean up timers on unmount so hot-reloads don't leave dangling setTimeouts.
  useEffect(() => () => {
    Object.values(timersRef.current).forEach((t) => t.cancel());
  }, []);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      {createPortal(
        <div
          // Each toast carries its own role (status or alert).
          // bottom-10 clears the permanent ~29px pipeline status bar docked at
          // the viewport bottom — bottom-6 left toasts painting over its text.
          className="fixed bottom-10 right-6 z-[1100] flex flex-col pointer-events-none"
        >
          <AnimatePresence initial={false}>
            {visibleToasts(toasts).map((t) => (
              <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)}
                onHold={(held) => { const timer = timersRef.current[t.id]; if (held) timer?.pause(); else timer?.resume(); }} />
            ))}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

const ToastItem = forwardRef<HTMLDivElement, {
  toast: ToastState;
  onDismiss: () => void;
  /** Pauses (true) or resumes (false) the auto-dismiss countdown. */
  onHold: (held: boolean) => void;
}>(function ToastItem({ toast, onDismiss, onHold }, ref): JSX.Element {
  const variantClass =
    toast.variant === 'error'
      ? 'bg-danger-solid text-white border-danger-border'
      : 'bg-ink text-surface border-ink';
  return (
    // Height animates too, so the toasts below close the gap smoothly when
    // one leaves. The 8px spacing lives inside the animated box.
    <m.div
      ref={ref}
      initial={{ opacity: 0, x: 24, height: 0 }}
      animate={{ opacity: 1, x: 0, height: 'auto' }}
      exit={{ opacity: 0, x: 24, height: 0 }}
      transition={SPRING}
      className="pointer-events-none flex justify-end"
    ><div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={() => onHold(false)}
      className={`pointer-events-auto mt-2 min-w-[280px] max-w-md rounded-lg border shadow-pop px-4 py-3 flex items-center gap-3 text-sm ${variantClass}`}
    >
      <span className="flex-1 min-w-0 break-words">{toast.message}</span>
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
    </div></m.div>
  );
});

