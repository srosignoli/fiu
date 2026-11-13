import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { searchAtlas, words } from './search.ts';
import type { Skeleton } from './skeleton.ts';
import type { Atlas } from './store.ts';
import type { ForeignRule } from './ua.ts';

/**
 * Understand-Anything's business rules as Prediction topics (ADR 0010): which code a rule is about, so a
 * Prediction can measure whether the code does what the rule says. The rule is the model's word; where it
 * points is a guess the human confirms; the Prediction is Verified like any other.
 */

/** A place a rule may be enforced: a function, and why Fiu thinks so. */
export interface RuleTarget {
  path: string;
  symbol: string;
  /** `names`: the rule names it, or a constant it uses; `search`: its words match the rule's, among the rule's files. */
  evidence: 'names' | 'search';
}

/** At most this many places per rule: the human picks, Fiu never guesses silently. */
export const RULE_TARGETS = 3;

/** Names a rule may mention: UPPER_SNAKE, camelCase, or PascalCase of two words or more (Go's exported `TrustStreak`). */
const IDENTIFIER = /`?\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b`?/g;

/**
 * Where a rule may be enforced, best first. A function the rule names comes first, then the functions of a
 * file that use a constant it names (`DRILL_MAX_CHANGED_LINES`); otherwise Atlas search over the rule's
 * words among its files (the files of its domain's flows), or the whole repository when it has none.
 * Numbers are never matched to constants: "3" is too many things.
 */
export async function locateRule(
  rule: Pick<ForeignRule, 'text' | 'files'>,
  repoRoot: string,
  skeleton: Skeleton,
  atlas: Atlas,
  extras: ReadonlyMap<string, { tags: string[]; layer?: string }> = new Map(),
): Promise<RuleTarget[]> {
  const targets: RuleTarget[] = [];
  const add = (target: RuleTarget) => {
    if (targets.length < RULE_TARGETS && !targets.some((t) => t.path === target.path && t.symbol === target.symbol)) targets.push(target);
  };
  const inScope = (path: string) => rule.files.length === 0 || rule.files.includes(path);
  const named = [...new Set([...rule.text.matchAll(IDENTIFIER)].map((m) => m[1]!))];
  const files = [...skeleton.files.values()].filter((f) => f.described).sort((a, b) => Number(inScope(b.path)) - Number(inScope(a.path)));
  for (const name of named) {
    for (const file of files) {
      const symbol = file.symbols.find((s) => s.callable && (s.name === name || s.name.endsWith(`.${name}`)));
      if (symbol) add({ path: file.path, symbol: symbol.name, evidence: 'names' });
    }
    // A constant: the functions of its file that use it enforce the rule. Declared as `const NAME =`, or in a
    // Go `const ( … )` block or Python module as `NAME =` at the start of a line.
    const declared = new RegExp(`(?:\\b(?:const|let|var)\\s+${name}\\b|^\\s*${name}\\s*(?:[\\w.*\\[\\]]+\\s*)?=[^=])`);
    for (const file of files) {
      const lines = (await readFile(join(repoRoot, file.path), 'utf8').catch(() => '')).split('\n');
      if (!lines.some((line) => declared.test(line))) continue;
      const uses = new RegExp(`\\b${name}\\b`);
      for (const symbol of file.symbols) {
        if (symbol.callable && lines.slice(symbol.startLine - 1, symbol.endLine).some((line) => uses.test(line))) add({ path: file.path, symbol: symbol.name, evidence: 'names' });
      }
    }
  }
  if (targets.length > 0) return targets;
  const ruleWords = [...new Set(words(rule.text))];
  const needed = Math.min(MIN_SHARED_WORDS, ruleWords.length);
  for (const result of searchAtlas(rule.text, skeleton, atlas, new Map(), extras)) {
    if (!result.symbol || !result.callable || !inScope(result.path)) continue;
    // One shared word ("expiry") is a coincidence: the place must share several of the rule's words.
    const said = words(`${result.path} ${result.symbol} ${result.text ?? ''} ${atlas.files[result.path]?.text ?? ''}`);
    if (ruleWords.filter((w) => said.some((s) => sameStem(w, s))).length >= needed) add({ path: result.path, symbol: result.symbol, evidence: 'search' });
  }
  return targets;
}

/** Distinct words a place found by search must share with the rule. */
const MIN_SHARED_WORDS = 2;

/** As Atlas search compares words: equal, or one a prefix of the other once the shorter loses its last letter. */
const sameStem = (a: string, b: string) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short === long || (short.length >= 4 && long.startsWith(short)) || (short.length >= 5 && long.startsWith(short.slice(0, -1)));
};

/**
 * The rule some words mean: the same text ignoring case, else the one rule holding every word ("daily
 * limit" finds "Default caps: queue cap 3, daily limit 5…"). None, or several, is an error listing them.
 */
export function findRule(rules: ForeignRule[], wanted: string): ForeignRule {
  const exact = rules.find((rule) => rule.text.toLowerCase() === wanted.trim().toLowerCase());
  if (exact) return exact;
  const goal = words(wanted);
  const matching = goal.length === 0 ? [] : rules.filter((rule) => goal.every((word) => words(rule.text).some((w) => w.startsWith(word) || word.startsWith(w))));
  if (matching.length === 1) return matching[0]!;
  const listed = (list: ForeignRule[]) => list.slice(0, 12).map((rule) => `- ${rule.text}`).join('\n') + (list.length > 12 ? `\n… and ${list.length - 12} more` : '');
  throw new RuleNotFoundError(
    matching.length > 1
      ? `"${wanted}" matches ${matching.length} rules; use more of their words:\n${listed(matching)}`
      : `No rule matches "${wanted}". \`fiu predict --rule\` lists them all; some are:\n${listed(rules)}`,
  );
}

export class RuleNotFoundError extends Error {}
