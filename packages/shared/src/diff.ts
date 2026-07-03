/**
 * Minimal, dependency-free line diff (LCS) for rendering Edit/MultiEdit changes
 * as red/green lines. Returns the merged sequence of removed/added/unchanged
 * lines in display order. Shared: the web UI renders it; the server uses it to
 * diff edits for Markdown export.
 */

export type DiffLineType = 'add' | 'del' | 'context';
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** Count added / removed lines in a diff. */
export function diffStats(lines: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.type === 'add') additions++;
    else if (l.type === 'del') deletions++;
  }
  return { additions, deletions };
}

/** File extension (Shiki language hint) from a path; undefined if none. */
export function extOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

// Guard against a pathological O(m*n) table for very large inputs.
const MAX_CELLS = 2_000_000;

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  // Treat a wholly-empty side as zero lines (not one empty line), so a brand-new
  // file shows as pure additions rather than "+content / -<empty>".
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');

  if (oldText === newText) return a.map((text) => ({ type: 'context', text }));

  // Too large to diff cheaply — show as a full replacement.
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }

  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++]! });
  while (j < n) out.push({ type: 'add', text: b[j++]! });
  return out;
}
