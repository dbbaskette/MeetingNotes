// Tiny segmented level meter for the live recording row. peakDb is the
// most recent peak (-160..0). We map to a 0..1 fill and split into
// 10 segments. Re-renders only when peakDb changes meaningfully.
export function VuMeter({ peakDb }: { peakDb: number }): JSX.Element {
  // -60dB is "quiet but audible," 0dB is "clipping." Clamp + normalize.
  const fill = Math.max(0, Math.min(1, (peakDb + 60) / 60));
  const lit = Math.round(fill * 10);
  return (
    <div className="flex items-center gap-[2px]" aria-label={`peak ${peakDb.toFixed(0)} dB`}>
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className={`w-[3px] h-3 rounded-sm ${
            i < lit
              ? i < 7 ? 'bg-status-ok' : i < 9 ? 'bg-status-warn' : 'bg-danger-solid'
              : 'bg-surface-border'
          }`}
        />
      ))}
    </div>
  );
}
