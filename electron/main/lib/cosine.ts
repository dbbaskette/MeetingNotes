export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) throw new Error('cannot compute cosine for zero vector');
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function normalize(v: readonly number[]): number[] {
  const n = Math.hypot(...v);
  if (n === 0) throw new Error('cannot normalize zero vector');
  return v.map((x) => x / n);
}
