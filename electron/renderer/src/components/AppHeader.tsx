// electron/renderer/src/components/AppHeader.tsx
//
// The top bar shared by every top-level view (Library, Actions, Weekly,
// Settings): brand lockup, primary navigation, then view-specific controls.
// Each view used to build its own header, and Settings used a narrower one
// with no lockup, so the navigation jumped sideways when switching to it
// (#296). Rendering one header inside the same `max-w-5xl` shell keeps the
// tabs in the same place on every view.

import type { ReactNode } from 'react';
import { AppNav, type NavTarget } from './AppNav';
import logoUrl from '../assets/logo.png';

/** Shell classes every top-level view wraps itself in, so the header lines up. */
export const APP_SHELL_CLASS = 'app-view h-full w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 flex flex-col';

export function AppHeader({ active, onNav, navKey, pageTitle, className = 'mb-8', children }: {
  active: NavTarget;
  onNav: (target: NavTarget) => void;
  /** Change it to remount the nav so its selection pill glides in again. */
  navKey?: string;
  /** Screen-reader page heading when the view has no visible one. */
  pageTitle?: string;
  className?: string;
  /** View-specific controls, placed after the navigation. */
  children?: ReactNode;
}): JSX.Element {
  return (
    <header className={`app-chrome shrink-0 flex flex-wrap items-center gap-4 ${className}`}>
      {/* min-h matches the tallest control any view adds (the Record button),
          so the row — and the navigation in it — sits at the same height everywhere. */}
      <div className="flex items-center gap-2.5 min-h-[42px]">
        <img src={logoUrl} alt="" className="h-9 w-auto" />
        {pageTitle
          ? <><span className="text-lg font-semibold tracking-tight">MeetingNotes</span><h1 className="sr-only">{pageTitle}</h1></>
          : <h1 className="text-lg font-semibold tracking-tight">MeetingNotes</h1>}
      </div>
      <AppNav key={navKey} active={active} onNav={onNav} />
      {children}
    </header>
  );
}
