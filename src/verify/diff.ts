/** A contiguous region where two texts differ. */
export interface Hunk {
  /** 1-based line in the original text where the region starts. */
  line: number;
  removed: string[];
  added: string[];
}

/** Line endings, trailing whitespace, and trailing blank lines don't count as differences. */
function normalisedLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** A minimal line diff (longest common subsequence), grouped into contiguous hunks. */
export function diffLines(original: string, changed: string): Hunk[] {
  const a = normalisedLines(original);
  const b = normalisedLines(changed);

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  const flush = () => {
    if (current) hunks.push(current);
    current = undefined;
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      current ??= { line: i + 1, removed: [], added: [] };
      current.added.push(b[j++]!);
    } else {
      current ??= { line: i + 1, removed: [], added: [] };
      current.removed.push(a[i++]!);
    }
  }
  flush();
  return hunks;
}
