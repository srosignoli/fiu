import type { FileState } from '../map/map.ts';
import type { Skeleton } from './skeleton.ts';
import { entryState, type Atlas } from './store.ts';

export const SEARCH_RESULTS = 10;

export interface SearchResult {
  path: string;
  /** Set for a function, class, or other symbol; absent for a whole file. */
  symbol?: string;
  /** The Atlas entry, when there is one. */
  text?: string;
  /** Set when the entry is Understand-Anything's (ADR 0010). */
  source?: 'understand-anything';
  stale: boolean;
  state: FileState;
  tooLong: boolean;
  /** A function or method: a better target than a type of the same score. */
  callable: boolean;
  score: number;
}

/** Words that say nothing about what to find. */
const STOPWORDS = new Set(
  'a an and are as at be by do does for from how i in into is it its learn me my of on or so study that the their them this to understand want what when where which who why with work works'.split(' '),
);

/** A word reduced to its stem, so "retries", "retrying", and "retry" meet. */
function stem(word: string): string {
  for (const [suffix, replacement] of [['ies', 'y'], ['ied', 'y'], ['ing', ''], ['ed', ''], ['es', ''], ['s', '']] as const) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) return word.slice(0, -suffix.length) + replacement;
  }
  return word;
}

/** Lowercase stems of the words in a text, a path, or a name (camelCase and snake_case split). */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word))
    .map(stem);
}

/**
 * Whether two stems name the same thing: equal, one a prefix of the other (four letters or more:
 * "verify" and "verification"), or differing only in the last letter of the shorter ("verify", "verifi").
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return (short.length >= 4 && long.startsWith(short)) || (short.length >= 5 && long.startsWith(short.slice(0, -1)));
}

/**
 * A goal's score against named fields: each goal word scores its best field's weight (a name 2, an
 * entry or a method's class 1), so a word found twice counts once, times how rare the word is.
 */
function score(goal: string[], fields: [weight: number, words: string[]][], rarity: Map<string, number>): number {
  return goal.reduce((sum, g) => sum + (rarity.get(g) ?? 1) * Math.max(0, ...fields.filter(([, found]) => found.some((w) => sameWord(g, w))).map(([weight]) => weight)), 0);
}

/**
 * How much each goal word tells files apart: log(1 + files / files mentioning it), as inverse document
 * frequency does. A word most files mention ("drill" in Fiu) counts for less than one few do ("verify"),
 * so a match on the rare word outranks a match on the common one.
 */
function rarities(goal: string[], fileWords: string[][]): Map<string, number> {
  const files = Math.max(fileWords.length, 1);
  return new Map(goal.map((g) => [g, Math.log(1 + files / Math.max(1, fileWords.filter((found) => found.some((w) => sameWord(g, w))).length))]));
}

const RANK: Record<FileState, number> = { red: 0, amber: 1, grey: 2, green: 3 };

/**
 * Files and symbols for a goal, best first: local and free. A match in a name (file path or symbol)
 * counts double over a match in an Atlas entry or in a method's class; among equals, functions before types, then the human's
 * map state, never-practised code first. Works on names alone before any entry is written. `extras` are
 * further words for a file (Understand-Anything's tags and layer), matched like its entry.
 */
export function searchAtlas(
  goal: string,
  skeleton: Skeleton,
  atlas: Atlas,
  states: Map<string, FileState>,
  extras: ReadonlyMap<string, { tags: string[]; layer?: string }> = new Map(),
): SearchResult[] {
  const wanted = [...new Set(words(goal))];
  if (wanted.length === 0) return [];
  const described = [...skeleton.files.values()].filter((file) => file.described);
  const extraWordsOf = (path: string) => {
    const extra = extras.get(path);
    return extra ? words([...extra.tags, extra.layer ?? ''].join(' ')) : [];
  };
  const rarity = rarities(
    wanted,
    described.map((file) => {
      const entry = atlas.files[file.path];
      return [...words(file.path), ...(entry ? words([entry.text, ...Object.values(entry.functions)].join(' ')) : []), ...file.symbols.flatMap((s) => words(s.name)), ...extraWordsOf(file.path)];
    }),
  );
  const results: SearchResult[] = [];
  for (const file of described) {
    const entry = atlas.files[file.path];
    const stale = entryState(entry, file.hash) === 'stale';
    const state = states.get(file.path) ?? 'grey';
    const source = entry?.source ? { source: entry.source } : {};
    const fileScore = score(wanted, [[2, words(file.path)], [1, entry ? words(entry.text) : []], [1, extraWordsOf(file.path)]], rarity);
    if (fileScore > 0) results.push({ path: file.path, ...(entry ? { text: entry.text, ...source } : {}), stale, state, tooLong: file.tooLong, callable: true, score: fileScore });
    for (const symbol of file.symbols) {
      const text = entry?.functions[symbol.name];
      const dot = symbol.name.lastIndexOf('.');
      const symbolScore = score(wanted, [[2, words(symbol.name.slice(dot + 1))], [1, words(symbol.name.slice(0, Math.max(dot, 0)))], [1, text ? words(text) : []]], rarity);
      if (symbolScore > 0) results.push({ path: file.path, symbol: symbol.name, ...(text ? { text, ...source } : {}), stale, state, tooLong: file.tooLong, callable: symbol.callable, score: symbolScore });
    }
  }
  return results.sort((a, b) => b.score - a.score || Number(b.callable) - Number(a.callable) || RANK[a.state] - RANK[b.state] || Number(!!b.text) - Number(!!a.text) || a.path.localeCompare(b.path) || (a.symbol ?? '').localeCompare(b.symbol ?? ''));
}

/** The target to hand to `fiu drill`, `fiu kata`, or `fiu predict`. */
export const targetOf = (result: Pick<SearchResult, 'path' | 'symbol'>) => (result.symbol ? `${result.path}#${result.symbol}` : result.path);
