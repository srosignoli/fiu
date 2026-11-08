import { posix } from 'node:path';
import { loadLinks, NO_LINKS } from '../atlas/links.ts';
import { words } from '../atlas/search.ts';
import { buildSkeleton } from '../atlas/skeleton.ts';
import { entryState, readAtlas } from '../atlas/store.ts';
import { extractSymbols } from '../atlas/symbols.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { DiagnosisCause, PredictionOption, WorkoutKind } from '../synthesis/schema.ts';
import { diffLines, type Hunk } from '../verify/diff.ts';
import { buildVariant } from '../verify/gate.ts';
import type { WorkspacePaths } from '../workspace.ts';

/**
 * "Around this code" (§11.15, ADR 0009): what surrounds a Workout's target, never the target
 * itself. Assembled from a template out of the Atlas and the links, with no model call, so its author
 * never saw the Workout. Saved with the Workout, which never changes.
 */
export interface AroundThisCode {
  /** The section's Markdown lines, label included. */
  lines: string[];
  /** Description lines left out because they named the target or what the Workout changed or removed. */
  dropped: number;
}

/** Top entries per link row: any more and the section becomes reading homework. */
const PER_ROW = 3;
export const MODEL_WORD = '*Descriptions are written by a model from the code, not Verified; links are computed from imports and git history.*';
export const NO_DESCRIPTIONS = '*Links are computed from imports and git history. Run `fiu atlas build` for what these files are for.*';
const STALE = ' *(written before the code last changed)*';

/** Words too common in code to give anything away when a description happens to use them. */
const COMMON = new Set(
  'this that then else return const function async await true false null undefined none self with from import export class value values result results item items data list index count length string number error errors default type types new'.split(
    ' ',
  ),
);

export interface AroundOptions {
  paths: WorkspacePaths;
  profiles: readonly LanguageProfile[];
  profile: LanguageProfile;
  sourcePath: string;
  symbol?: string;
  /** A Prediction (What-ifs included) never shows the file's entry: its answer is behaviour, and the entry summarises behaviour. Default: drill. */
  kind?: WorkoutKind;
  referenceSolution: string;
  /** Every other version of the code the Workout holds (`otherVersions`): what differs from the Reference Solution is the target. */
  others: string[];
  /** For a Prediction or Diagnosis: the true option's (or Cause's) text and the wrong ones'. */
  answer?: { truth: string; wrong: string[] };
}

/** What a Workout holds besides its Reference Solution, as saved in its record and files. */
export interface WorkoutVersions {
  kind: WorkoutKind;
  referenceSolution: string;
  /** Drill and Kata: the code the human starts from. */
  startingCode?: string;
  /** A Prediction from a commit or a What-if: the code before. */
  previous?: string;
  options?: PredictionOption[];
  causes?: DiagnosisCause[];
}

/**
 * The other versions of the code: a Drill's bugged code or a Kata's gapped code; a Prediction's wrong
 * options' Variants (and the code before, for the old-behaviour option); every Cause's Variant.
 */
export function otherVersions(w: WorkoutVersions): string[] {
  if (w.kind === 'drill' || w.kind === 'kata') return w.startingCode === undefined ? [] : [w.startingCode];
  if (w.kind === 'diagnosis') return (w.causes ?? []).map((c) => buildVariant(w.referenceSolution, c.variant));
  return (w.options ?? []).filter((o) => !o.correct).map((o) => (o.previous ? (w.previous ?? '') : buildVariant(w.referenceSolution, o.variant))).filter(Boolean);
}

/** The true option's (or Cause's) text and the wrong ones', for a Prediction or Diagnosis. */
export function answerTexts(w: Pick<WorkoutVersions, 'options' | 'causes'>): AroundOptions['answer'] {
  const choices = w.options ?? w.causes;
  const truth = choices?.find((c) => c.correct);
  return truth ? { truth: truth.text, wrong: choices!.filter((c) => !c.correct).map((c) => c.text) } : undefined;
}

/** The section, or undefined when there is nothing around the code to say. */
export async function aroundThisCode(options: AroundOptions): Promise<AroundThisCode | undefined> {
  const { paths, profiles, sourcePath } = options;
  const skeleton = await buildSkeleton(paths.repoRoot, profiles);
  const file = skeleton.files.get(sourcePath);
  if (!file) return undefined;
  const atlas = await readAtlas(paths);
  const links = await loadLinks(paths, skeleton, profiles);
  const own = links.files[sourcePath] ?? NO_LINKS;
  const hubs = new Set(links.hubs);

  const hunks = options.others.flatMap((other) => diffLines(options.referenceSolution, other));
  const named = leakChecker(targetNames(options, hunks), distinctiveTokens(options.referenceSolution, hunks, options.profile.lineComment));
  const picksAnswer = options.answer ? answerPicker(options.answer) : () => false;
  const leaks = (text: string) => named(text) || picksAnswer(text);
  let dropped = 0;
  const describe = (label: string, text: string | undefined, stale: boolean): string[] => {
    if (!text) return [];
    if (leaks(text)) {
      dropped++;
      return [];
    }
    return [`- **${label}:** ${text.replace(/\s*\n\s*/g, ' ').trim()}${stale ? STALE : ''}`];
  };

  const folderPath = posix.dirname(sourcePath) === '.' ? '' : posix.dirname(sourcePath);
  const folder = skeleton.folders.get(folderPath);
  const folderEntry = folderPath === '' ? undefined : atlas.folders[folderPath];
  const fileEntry = atlas.files[sourcePath];
  const descriptions = [
    ...describe(`Folder \`${folderPath}/\``, folderEntry?.text, folder !== undefined && entryState(folderEntry, folder.hash) === 'stale'),
    ...(options.kind === 'prediction' ? [] : describe('This file', fileEntry?.text, entryState(fileEntry, file.hash) === 'stale')),
  ];

  const row = (label: string, paths: string[]): string[] =>
    paths.length === 0 ? [] : [`- **${label}:** ${paths.slice(0, PER_ROW).map((p) => `\`${p}\``).join(', ')}${paths.length > PER_ROW ? `, and ${paths.length - PER_ROW} more` : ''}`];
  const linkRows = [
    ...row('Used by', own.importedBy),
    ...row('Uses', own.imports),
    ...row('Changes with', own.changesWith.map((c) => c.path).filter((p) => !hubs.has(p))),
  ];

  if (descriptions.length === 0 && linkRows.length === 0) return dropped > 0 ? { lines: [], dropped } : undefined;
  const label = descriptions.length > 0 ? MODEL_WORD : NO_DESCRIPTIONS;
  return { lines: ['## Around this code', '', ...descriptions, ...linkRows, '', label], dropped };
}

/** The target: the `#symbol` asked for, and every function the changed or removed lines fall in. */
export function targetNames({ symbol, referenceSolution, profile }: Pick<AroundOptions, 'symbol' | 'referenceSolution' | 'profile'>, hunks: Hunk[]): string[] {
  const names = new Set<string>();
  const add = (name: string) => {
    names.add(name);
    // `Queue.push` is also talked about as `push`.
    const last = name.split('.').pop()!;
    if (last.length >= 4) names.add(last);
  };
  if (symbol) add(symbol);
  const symbols = extractSymbols(referenceSolution, profile.declarationPattern).filter((s) => s.callable);
  for (const hunk of hunks) {
    const start = hunk.line;
    const end = hunk.line + Math.max(hunk.removed.length, 1) - 1;
    for (const s of symbols) if (s.startLine <= end && s.endLine >= start) add(s.name);
  }
  return [...names];
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const NUMBER = /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g;
const STRING = /(['"`])([^'"`\n]{3,})\1/g;

/** A line that is only a comment: it describes the code without changing what it does. */
const commentOnly = (line: string, lineComment?: string) => {
  const text = line.trim();
  return (lineComment !== undefined && text.startsWith(lineComment)) || text.startsWith('/*') || text.startsWith('*');
};

/**
 * What only the changed or removed lines say: identifiers that appear nowhere else in the Reference
 * Solution, numbers other than 0 and 1, and string contents. Names shared with the rest of the code
 * are the unit's ordinary vocabulary, and saying them gives nothing away. Comment lines are left out:
 * they change no behaviour, and their prose would match any description.
 */
export function distinctiveTokens(referenceSolution: string, hunks: Hunk[], lineComment?: string): string[] {
  const changed = hunks.flatMap((h) => [...h.removed, ...h.added]).filter((line) => !commentOnly(line, lineComment));
  const changedSet = new Set(changed.map((line) => line.trim()));
  const rest = referenceSolution
    .split('\n')
    .filter((line) => !changedSet.has(line.trim()))
    .join('\n');
  const elsewhere = new Set(rest.match(IDENTIFIER) ?? []);
  const tokens = new Set<string>();
  for (const line of changed) {
    for (const id of line.match(IDENTIFIER) ?? []) if (id.length >= 4 && !elsewhere.has(id) && !COMMON.has(id.toLowerCase())) tokens.add(id);
    for (const n of line.match(NUMBER) ?? []) if (n !== '0' && n !== '1') tokens.add(n);
    for (const s of line.matchAll(STRING)) tokens.add(s[2]!);
  }
  return [...tokens];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `maxRetries` is also written "max retries" in prose. */
const spoken = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

/**
 * True when a description uses a word only the true option (or Cause) uses: the words that tell the right
 * answer from the wrong ones. Compared as stems, stopwords left out, as Atlas search compares them.
 */
export function answerPicker({ truth, wrong }: { truth: string; wrong: string[] }): (text: string) => boolean {
  const others = new Set(wrong.flatMap((text) => words(text)));
  const telling = new Set(words(truth).filter((word) => !others.has(word)));
  return (text) => words(text).some((word) => telling.has(word));
}

/** True when a description names the target or says what only the changed lines say. */
export function leakChecker(names: string[], tokens: string[]): (text: string) => boolean {
  const patterns = [...names, ...tokens].flatMap((word) => {
    const forms = new Set([word, spoken(word)]);
    return [...forms].filter((form) => form.trim().length > 0).map((form) => new RegExp(`(?<![\\w])${escape(form)}(?![\\w])`, 'i'));
  });
  return (text) => patterns.some((pattern) => pattern.test(text));
}
