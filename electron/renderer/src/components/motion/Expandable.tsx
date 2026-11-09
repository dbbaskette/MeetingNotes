import { AnimatePresence, m } from 'motion/react';
import type { ReactNode } from 'react';
import { SPRING } from './spring';

/** Opens and closes its children by height. Children unmount once closed. */
export function Expandable({ open, id, className, children }: {
  open: boolean; id?: string; className?: string; children: ReactNode;
}): JSX.Element {
  return <AnimatePresence initial={false}>
    {open && <m.div id={id} key="content" className={className} style={{ overflow: 'hidden' }}
      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }} transition={SPRING}>{children}</m.div>}
  </AnimatePresence>;
}
