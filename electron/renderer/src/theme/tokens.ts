export const tokens = {
  indigo: '#6366f1',
  violet: '#8b5cf6',
  gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
  amber: '#f59e0b',
  amberBg: '#fef3c7',
  amberText: '#92400e',
  okGreen: '#16a34a',
  speakerPalette: ['#6366f1', '#8b5cf6', '#ec4899', '#0ea5e9', '#22c55e', '#f97316'],
} as const;

export function colorForSpeakerIndex(idx: number): string {
  return tokens.speakerPalette[idx % tokens.speakerPalette.length]!;
}
