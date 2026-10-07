/** Capture source labels and optional human titles are independent. */
export function captureTitle(value: string | null | undefined): string | undefined {
  const title = value?.trim();
  if (!title) return undefined;
  if (
    title.length > 200 ||
    [...title].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Recording title must be at most 200 characters, on one line.');
  return title;
}
