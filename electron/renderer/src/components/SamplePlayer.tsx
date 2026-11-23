// electron/renderer/src/components/SamplePlayer.tsx
//
// Compact player for a speaker's voice sample (#298). The row used to pair a
// custom Play button with a native <audio controls> element inside the 260px
// rail: two Play buttons, and Chromium's controls clipped at that width. This
// is one play/pause button, a seekable bar and a time readout that fit.
import { useEffect, useRef, useState } from 'react';

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function SamplePlayer({ src, label }: { src: string; label: string }): JSX.Element {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);
  // A new sample starts from the beginning, stopped.
  useEffect(() => { setPlaying(false); setTime(0); setDuration(0); setError(false); }, [src]);
  function toggle(): void {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setError(true)); else el.pause();
  }
  return (
    <div className="flex items-center gap-2 min-w-0">
      <audio ref={audio} src={src} preload="auto" className="hidden"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setTime(0); }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onError={() => setError(true)} />
      <button type="button" onClick={toggle} disabled={error}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`} aria-pressed={playing}
        className="shrink-0 w-7 h-7 rounded-full bg-brand-solid text-white flex items-center justify-center hover:bg-brand-solid/90 transition disabled:opacity-40">
        <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor" aria-hidden="true">
          {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M4 3v10l9-5z" />}
        </svg>
      </button>
      <input type="range" min={0} max={duration || 1} step={0.05} value={Math.min(time, duration || 1)} disabled={error || !duration}
        aria-label={`Position in ${label}`} aria-valuetext={`${fmt(time)} of ${fmt(duration)}`}
        onChange={(event) => { const el = audio.current; if (el) { el.currentTime = Number(event.target.value); setTime(el.currentTime); } }}
        className="min-w-0 flex-1 h-1 accent-brand-solid" />
      <span className="shrink-0 text-[10px] tabular-nums text-ink-muted">{error ? 'Unavailable' : `${fmt(time)} / ${fmt(duration)}`}</span>
    </div>
  );
}
