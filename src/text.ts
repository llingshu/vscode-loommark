export type OffsetEdit = { from: number; to: number; insert: string };

export function singleSplice(previous: string, next: string): OffsetEdit | null {
  if (previous === next) return null;

  let start = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (start < sharedLength && previous.charCodeAt(start) === next.charCodeAt(start)) start++;

  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start
    && nextEnd > start
    && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd--;
    nextEnd--;
  }

  return { from: start, to: previousEnd, insert: next.slice(start, nextEnd) };
}
