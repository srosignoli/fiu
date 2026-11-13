import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspacePaths } from '../workspace.ts';
import { readAtlasOverlay, type AtlasOverlay } from './overlay.ts';
import { searchAtlas, words } from './search.ts';
import type { Skeleton } from './skeleton.ts';
import type { Atlas } from './store.ts';
import type { ForeignRule } from './ua.ts';

/**
 * Business rules as Prediction topics (ADR 0011): a rule is a claim about the system, and a Prediction
 * about it measures whether the code agrees. Rules come from the team's rules file, from
 * Understand-Anything's domain graph (ADR 0010), or as the human types one. Where a rule points is a
 * guess the human confirms, unless the rules file pins it; the Prediction is Verified like any other.
 */

/** The team's rules, committed with the code: `- ` items, `## Heading` domains, an optional `→ path#symbol`. */
export const RULES_FILE = '.fiu-rules.md';

/** Where a rule came from, shown with it. */
export type RuleSource = 'rules-file' | 'understand-anything' | 'typed';

export const RULE_SOURCE_LABEL: Record<RuleSource, string> = { 'rules-file': RULES_FILE, 'understand-anything': 'Understand-Anything', typed: 'as you wrote it' };

/** A business rule from any source. `files` narrows where it is searched for; empty means everywhere. */
export interface BusinessRule extends ForeignRule {
  source: RuleSource;
  /** Pinned in the rules file with `→ path#symbol`: where it is enforced, with no search. */
  pinned?: { path: string; symbol?: string };
}

/** A typed rule needs this many words: fewer are a search for a known rule, not a claim. */
export const TYPED_RULE_MIN_WORDS = 4;

/**
 * The rules file's rules. Each Markdown list item is a rule; the nearest `#` heading above it is its
 * domain; a trailing `→ path#symbol` (or `-> path#symbol`) pins where it is enforced. Other lines are
 * left alone, so the file can explain itself.
 */
export function parseRulesFile(text: string): BusinessRule[] {
  const rules: BusinessRule[] = [];
  let domain: string | undefined;
  for (const raw of text.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      domain = heading[1]!.trim();
      continue;
    }
    const item = /^\s*[-*+]\s+(.+?)\s*$/.exec(raw);
    if (!item) continue;
    const [, body] = item;
    const pin = /^(.*?)\s*(?:→|->)\s*`?([^\s`#]+)(?:#([^\s`]+))?`?\s*$/.exec(body!);
    const text = (pin ? pin[1]! : body!).trim();
    if (!text) continue;
    rules.push({ text, ...(domain ? { domain } : {}), files: pin ? [pin[2]!] : [], source: 'rules-file', ...(pin ? { pinned: { path: pin[2]!, ...(pin[3] ? { symbol: pin[3] } : {}) } } : {}) });
  }
  return rules;
}

/**
 * Every known rule: the rules file's first (the team's own word), then Understand-Anything's, unless it
 * is off or absent. A rule with the same text in both counts once, as the team's. Never fails for a
 * missing source: no rules is an empty list.
 */
export async function readRules(paths: Pick<WorkspacePaths, 'atlasFile' | 'configFile' | 'repoRoot'>, skeleton: Skeleton): Promise<{ rules: BusinessRule[]; overlay: AtlasOverlay }> {
  const overlay = await readAtlasOverlay(paths, skeleton);
  const fromFile = parseRulesFile(await readFile(join(paths.repoRoot, RULES_FILE), 'utf8').catch(() => ''));
  const known = new Set(fromFile.map((r) => r.text.toLowerCase()));
  const fromUa: BusinessRule[] = overlay.ua.status === 'read' ? overlay.ua.atlas.rules.filter((r) => !known.has(r.text.toLowerCase())).map((r) => ({ ...r, source: 'understand-anything' })) : [];
  return { rules: [...fromFile, ...fromUa], overlay };
}

/** A rule as the human typed it: searched for everywhere. */
export const typedRule = (text: string): BusinessRule => ({ text: text.trim(), files: [], source: 'typed' });

/** Whether words not matching any rule can stand as a rule of their own. */
export const canBeTypedRule = (text: string) => words(text).length >= TYPED_RULE_MIN_WORDS;

export const NO_RULES = `No business rules here yet: write some in ${RULES_FILE} (one \`- \` item per rule), type one with at least ${TYPED_RULE_MIN_WORDS} words, or run Understand-Anything's /understand and /understand-domain.`;

/** A place a rule may be enforced: a function, and why Fiu thinks so. */
export interface RuleTarget {
  path: string;
  symbol: string;
  /** `pinned`: the rules file says so; `names`: the rule names it, or a constant it uses; `search`: its words match the rule's, among the rule's files. */
  evidence: 'pinned' | 'names' | 'search';
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
  rule: Pick<BusinessRule, 'text' | 'files' | 'pinned'>,
  repoRoot: string,
  skeleton: Skeleton,
  atlas: Atlas,
  extras: ReadonlyMap<string, { tags: string[]; layer?: string }> = new Map(),
): Promise<RuleTarget[]> {
  const targets: RuleTarget[] = [];
  // Pinned with a function: that is the place. Pinned with a file only: search within it.
  if (rule.pinned?.symbol && skeleton.files.has(rule.pinned.path)) return [{ path: rule.pinned.path, symbol: rule.pinned.symbol, evidence: 'pinned' }];
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

/** The evidence for a place, in words. */
export const EVIDENCE_WORDS: Record<RuleTarget['evidence'], string> = { pinned: `${RULES_FILE} names it`, names: 'the rule names it', search: 'its words match the rule' };

/** As Atlas search compares words: equal, or one a prefix of the other once the shorter loses its last letter. */
const sameStem = (a: string, b: string) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short === long || (short.length >= 4 && long.startsWith(short)) || (short.length >= 5 && long.startsWith(short.slice(0, -1)));
};

/**
 * The rule some words mean: the same text ignoring case, else the one rule holding every word ("daily
 * limit" finds "Default caps: queue cap 3, daily limit 5…"). None, or several, is an error listing them.
 */
export function findRule<R extends ForeignRule>(rules: R[], wanted: string): R {
  const exact = rules.find((rule) => rule.text.toLowerCase() === wanted.trim().toLowerCase());
  if (exact) return exact;
  const goal = words(wanted);
  const matching = goal.length === 0 ? [] : rules.filter((rule) => goal.every((word) => words(rule.text).some((w) => w.startsWith(word) || word.startsWith(w))));
  if (matching.length === 1) return matching[0]!;
  const listed = (list: R[]) => list.slice(0, 12).map((rule) => `- ${rule.text}`).join('\n') + (list.length > 12 ? `\n… and ${list.length - 12} more` : '');
  throw new RuleNotFoundError(
    matching.length > 1
      ? `"${wanted}" matches ${matching.length} rules; use more of their words:\n${listed(matching)}`
      : rules.length === 0
        ? `No rule matches "${wanted}". ${NO_RULES}`
        : `No rule matches "${wanted}". \`fiu predict --rule\` lists them all; some are:\n${listed(rules)}`,
  );
}

export class RuleNotFoundError extends Error {}
