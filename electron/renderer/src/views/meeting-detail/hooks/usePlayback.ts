// electron/renderer/src/views/meeting-detail/hooks/usePlayback.ts
// Audio playback state for the meeting page, moved out of
// MeetingDetailView.tsx (#256). Called from useMeetingDetail at the same
// point in the hook order the code had in the view.
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextPlaybackRate, guardedSeek, SKIP_SECONDS } from '../../../lib/audio-controls';
import { createPlaybackClock } from '../../../lib/playback-clock';
import type { MeetingDetail, Tab } from '../types';

export function usePlayback({ id, m, seekSeconds, setTab }: {
  id: string;
  m: MeetingDetail | null;
  seekSeconds: number | undefined;
  /** The view's stable useState setter for the active tab. */
  setTab: (tab: Tab) => void;
}) {
  // Lifted audio state so the transcript's click-to-seek + current-line
  // highlight can reach the <audio> element in the sticky footer. The
  // ref survives tab switches; tab switches alone never unmount the
  // player. (#42)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The playback position is NOT root state: only the transcript reads it,
  // through this clock, so a playback tick re-renders the transcript alone
  // instead of the whole detail tree (#301).
  const [playbackClock] = useState(() => createPlaybackClock());
  // timeupdate fires ~4x/sec, but the transcript highlight only changes
  // at whole-second granularity; the clock drops repeats of the same second.
  const onTimeUpdate = useCallback((e: React.SyntheticEvent<HTMLAudioElement>): void => {
    playbackClock.set(Math.floor((e.target as HTMLAudioElement).currentTime));
  }, [playbackClock]);
  // Stable identity: passed down to every (memoized) transcript row —
  // a fresh function per render would defeat React.memo on the rows.
  const [seekRevision,setSeekRevision]=useState(0);
  const seekTo = useCallback((seconds: number): void => {
    playbackClock.set(seconds);setSeekRevision(value=>value+1);
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = seconds;
    if (el.paused) void el.play();
  }, [playbackClock]);

  // Playback controls (#A3): speed cycle + ±15s skips. The chosen rate is
  // per-session component state; a ref mirrors it so the loadedmetadata
  // re-apply (rates reset when a new src loads) and the keydown handler
  // below stay identity-stable.
  const [rate, setRate] = useState(1);
  const rateRef = useRef(1);
  const cycleRate = useCallback((): void => {
    const next = nextPlaybackRate(rateRef.current);
    rateRef.current = next;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, []);
  const applyRate = useCallback((): void => {
    if (audioRef.current) audioRef.current.playbackRate = rateRef.current;
  }, []);
  // Relative skip. Unlike seekTo (click-to-seek), a skip on a paused
  // player stays paused — the user is scrubbing, not asking for playback.
  const skipBy = useCallback((delta: number): void => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = guardedSeek(el.currentTime, delta, el.duration);
  }, []);

  // Keyboard transport: Space play/pause, ←/→ skip ∓/±15s. Ignored while
  // typing (input/textarea/select/contentEditable) or with any modifier
  // held, so cmd-K, shift-selection etc. pass through untouched. Space is
  // additionally ignored when a button/link has focus — Space must keep
  // activating the focused control (arrows still seek there, which is
  // what makes them work right after clicking a transcript row).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input,textarea,select,[contenteditable]')) return;
      // A focused <audio> handles Space and the arrows itself; acting here
      // too toggled playback twice. And while any dialog is open the keys
      // belong to the dialog, not to the player behind it (#296).
      if (t?.closest('audio,video')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const el = audioRef.current;
      if (!el) return;
      if (e.code === 'Space') {
        if (t?.closest('button,[role="button"],a')) return;
        e.preventDefault(); // don't scroll the page
        if (el.paused) void el.play(); else el.pause();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        el.currentTime = guardedSeek(el.currentTime, -SKIP_SECONDS, el.duration);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        el.currentTime = guardedSeek(el.currentTime, SKIP_SECONDS, el.duration);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Palette-driven jump (#45): when opened with `seekSeconds`, switch to
  // the transcript tab and seek the audio once it's ready. readyState >= 1
  // means metadata is loaded and `currentTime` writes will stick;
  // otherwise the seek silently drops.
  useEffect(() => {
    if (seekSeconds === undefined) return;
    setTab('transcript');
    const el = audioRef.current;
    if (!el) return;
    const apply = (): void => seekTo(seekSeconds);
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
    return () => el.removeEventListener('loadedmetadata', apply);
  // setTab is the view's stable useState setter; the dependency list is kept
  // exactly as it was before the move out of MeetingDetailView (#256).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekSeconds, id, m?.id, seekTo]);

  return { audioRef, playbackClock, onTimeUpdate, seekRevision, seekTo, rate, cycleRate, applyRate, skipBy };
}
