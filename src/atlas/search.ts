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
  for (const [suffix, replacement] of [['ies', 'y'], ['ing', ''], ['ed', ''], ['es', ''], ['s', '']] as const) {
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

/** How many of the goal's words appear among these words; a word of four letters or more also matches as a prefix. */
function matches(goal: string[], found: string[]): number {
  return goal.filter((g) => found.some((w) => w === g || (g.length >= 4 && w.startsWith(g)) || (w.length >= 4 && g.startsWith(w)))).length;
}

const RANK: Record<FileState, number> = { red: 0, amber: 1, grey: 2, green: 3 };

/**
 * Files and symbols for a goal, best first: local and free. A match in a name (file path or symbol)
 * counts double over a match in an Atlas entry; among equals, functions before types, then the human's
 * map state, never-practised code first. Works on names alone before any entry is written.
 */
export function searchAtlas(goal: string, skeleton: Skeleton, atlas: Atlas, states: Map<string, FileState>): SearchResult[] {
  const wanted = [...new Set(words(goal))];
  if (wanted.length === 0) return [];
  const results: SearchResult[] = [];
  for (const file of skeleton.files.values()) {
    if (!file.described) continue;
    const entry = atlas.files[file.path];
    const stale = entryState(entry, file.hash) === 'stale';
    const state = states.get(file.path) ?? 'grey';
    const fileScore = 2 * matches(wanted, words(file.path)) + (entry ? matches(wanted, words(entry.text)) : 0);
    if (fileScore > 0) results.push({ path: file.path, ...(entry ? { text: entry.text } : {}), stale, state, tooLong: file.tooLong, callable: true, score: fileScore });
    for (const symbol of file.symbols) {
      const text = entry?.functions[symbol.name];
      const score = 2 * matches(wanted, words(symbol.name)) + (text ? matches(wanted, words(text)) : 0);
      if (score > 0) results.push({ path: file.path, symbol: symbol.name, ...(text ? { text } : {}), stale, state, tooLong: file.tooLong, callable: symbol.callable, score });
    }
  }
  return results.sort((a, b) => b.score - a.score || Number(b.callable) - Number(a.callable) || RANK[a.state] - RANK[b.state] || Number(!!b.text) - Number(!!a.text) || a.path.localeCompare(b.path) || (a.symbol ?? '').localeCompare(b.symbol ?? ''));
}

/** The target to hand to `kin drill`, `kin kata`, or `kin predict`. */
export const targetOf = (result: Pick<SearchResult, 'path' | 'symbol'>) => (result.symbol ? `${result.path}#${result.symbol}` : result.path);
