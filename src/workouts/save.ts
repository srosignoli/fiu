import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { execa } from 'execa';
import { describeCost, type Cost } from '../cost/usage.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { answersOnly, type AnyWorkoutOutput, type DiagnosisCause, type PredictionOption, type WorkoutKind } from '../synthesis/schema.ts';
import { findOriginalDefect, type OriginalDefect } from '../verify/defect.ts';
import { aroundThisCode, answerTexts, otherVersions, type AroundThisCode } from './context.ts';
import type { WorkspacePaths } from '../workspace.ts';

export const SOLUTION_DIRNAME = '.solution';

/** Where a Workout came from: the commit its Source Anchors point into. */
export interface SourceRevision {
  /** HEAD when the Workout was made; absent in a repository with no commits. */
  commit?: string;
  /** True when the source file differed from that commit (or was untracked). */
  dirty: boolean;
}

export interface SourceAnchor {
  path: string;
  startLine: number;
  endLine: number;
  explanation: string;
  commit?: string;
}

/** Who wrote a Workout's content: Fiu via the user's API key, or the user's coding agent. */
export type Generator = 'fiu' | 'agent';
/** Why a Workout exists: the user asked for it, an agent made it at the end of its own task, a commit triggered it, or it is a Track step. */
export type Origin = 'manual' | 'agent-task' | 'commit' | 'explore';

/** Who shared a Workout or Track with the team, stamped when it was shared. */
export interface SharedBy {
  name: string;
  email: string;
  at: string;
}

/** The Track a Drill belongs to. Step order lives in the Track's manifest, not here: a dropped step would make a number here wrong for good. */
export interface TrackPlacement {
  id: string;
  /** Absent when an agent builds the Track: it names the Track only after its Drills are saved. */
  title?: string;
  /** The module the Track teaches, relative to the repository root. */
  module: string;
  /** Set when the Track follows a business flow (ADR 0010): its name. */
  flow?: string;
  why: string;
}

/** What a What-if models (§11.14). */
export interface WhatIfPlacement {
  sentence?: string;
  modelled: string;
}

/**
 * The business rule a Prediction is about (ADR 0010): Understand-Anything's text, and whether the code,
 * as measured, does what it says (the generating model's reading). Shown only after answering.
 */
export interface RulePlacement {
  text: string;
  domain?: string;
  agrees: boolean;
  note: string;
}

/** A question's place in its Series (§11.11). */
export interface SeriesPlacement {
  id: string;
  /** 1-based. */
  index: number;
  /** How many questions the Series saved. */
  of: number;
}

/** The metadata saved beside a Workout as workout.json. */
export interface WorkoutRecord {
  id: string;
  kind: WorkoutKind;
  /** Absent on Workouts made before agent mode: those are `fiu`. */
  generator?: Generator;
  /** Absent on Workouts made before agent mode: those are `manual`. */
  origin?: Origin;
  /** For Origin `commit`: the commit it was generated from, and whether an AI co-authored it. */
  commit?: { sha: string; aiAuthored: boolean; subject?: string };
  /** For Origin `explore`: the Track this Drill is a step of. */
  track?: TrackPlacement;
  /** For a question of a Prediction Series: which Series, and where in it. */
  series?: SeriesPlacement;
  /** Set on Workouts fetched from the team's shared branch: who shared them. */
  sharedBy?: SharedBy;
  title: string;
  slug: string;
  pillar: AnyWorkoutOutput['pillar'];
  estimatedMinutes: number;
  language: string;
  createdAt: string;
  source: { path: string; symbol?: string } & SourceRevision;
  sourceAnchors: SourceAnchor[];
  hints: string[];
  /** Drill only: the test that exposes the injected bug. */
  regressionTestName?: string;
  /** Drill only: internal note on the bug. */
  injectedBugDescription?: string;
  /** Kata only: internal note on what was removed and what a correct fill must do. */
  gapSummary?: string;
  /** Prediction only: what the human reads, and the answer (the options in the order they were written; Attempts shuffle them). */
  prediction?: { scenario: string; explanation: string; options: PredictionOption[] };
  /** What-if only: the human's sentence, when they typed one, and how the model read it. */
  whatIf?: WhatIfPlacement;
  /** A Prediction about a business rule: the rule, and whether the code follows it. Never shown before answering. */
  rule?: RulePlacement;
  /** Diagnosis only: the Causes (the order they were written; Attempts shuffle them) and why the true one explains the incident, its Symptom. */
  diagnosis?: { explanation: string; causes: DiagnosisCause[] };
  /** A bug the source file appears to contain already. Shown only after an Attempt. */
  originalDefect?: OriginalDefect;
  /** "Around this code", as it was when the Workout was made (§11.15). */
  around?: AroundThisCode;
  /** What generating this Workout cost, across all its generation attempts. Absent when the user's agent generated it (not measured) and on Workouts made before cost recording. */
  cost?: Cost & { generationAttempts: number };
  /** `solution` is the Reference Solution; `originalTest` the tests the Workout was Verified with; `previous`, for a Prediction from a commit, the Previous Version. */
  files: { code: string; test: string; solution: string; originalTest: string; previous?: string };
}

export async function sourceRevision(repoRoot: string, path: string): Promise<SourceRevision> {
  const head = await execa('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoRoot, reject: false });
  if (head.exitCode !== 0) return { dirty: true };
  const status = await execa('git', ['status', '--porcelain', '--', path], { cwd: repoRoot });
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== '' };
}

export interface SaveDrillOptions {
  paths: WorkspacePaths;
  profile: LanguageProfile;
  /** The generated Workout, of either kind. */
  drill: AnyWorkoutOutput;
  kind?: WorkoutKind;
  /** The source file, relative to the repository root. */
  sourcePath: string;
  symbol?: string;
  /** The source file as sent to the generator, where the Workout's bug is looked for. Absent: not looked for. */
  source?: string;
  revision: SourceRevision;
  /** Absent when the user's agent generated the Workout: its cost isn't measured. */
  cost?: Cost;
  generationAttempts: number;
  generator?: Generator;
  origin?: Origin;
  commit?: { sha: string; aiAuthored: boolean; subject?: string };
  track?: TrackPlacement;
  series?: SeriesPlacement;
  whatIf?: WhatIfPlacement;
  rule?: RulePlacement;
  /** Set to build "Around this code": the Language Profiles the Atlas and links are read with. */
  contextProfiles?: readonly LanguageProfile[];
  now?: Date;
}

/** Writes a Verified Drill or Kata into .fiu/workouts/<id>/ and returns its record. */
export async function saveDrill({
  paths,
  profile,
  drill,
  kind = 'drill',
  sourcePath,
  symbol,
  source,
  revision,
  cost,
  generationAttempts,
  generator = 'fiu',
  origin = 'manual',
  commit,
  track,
  series,
  whatIf,
  rule,
  contextProfiles,
  now = new Date(),
}: SaveDrillOptions): Promise<WorkoutRecord> {
  const id = uniqueId(paths, `${kind}_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${drill.slug}`);
  const dir = join(paths.workoutsDir, id);
  const solution = join(SOLUTION_DIRNAME, profile.codeFilename);
  const originalTest = join(SOLUTION_DIRNAME, profile.testFilename);
  const previous = drill.previous ? join(SOLUTION_DIRNAME, `previous${extname(profile.codeFilename)}`) : undefined;
  const originalDefect = source === undefined ? undefined : findOriginalDefect(kind, drill, source, profile.lineComment);
  const around = contextProfiles ? await safeAround(paths, contextProfiles, profile, sourcePath, symbol, kind, drill) : undefined;

  const record: WorkoutRecord = {
    id,
    kind,
    generator,
    origin,
    ...(commit ? { commit } : {}),
    ...(track ? { track } : {}),
    ...(series ? { series } : {}),
    ...(whatIf ? { whatIf } : {}),
    ...(rule ? { rule } : {}),
    title: drill.title,
    slug: drill.slug,
    pillar: drill.pillar,
    estimatedMinutes: drill.estimatedMinutes,
    language: profile.id,
    createdAt: now.toISOString(),
    source: { path: sourcePath, ...(symbol ? { symbol } : {}), ...revision },
    sourceAnchors: drill.sourceAnchors.map((anchor) => ({ path: sourcePath, ...anchor, commit: revision.commit })),
    hints: drill.hints ?? [],
    ...(kind === 'drill'
      ? { regressionTestName: drill.regressionTestName, injectedBugDescription: drill.injectedBugDescription }
      : kind === 'kata'
        ? { gapSummary: drill.gapSummary }
        : kind === 'diagnosis'
          ? { diagnosis: { explanation: drill.explanation ?? '', causes: drill.causes ?? [] } }
          : { prediction: { scenario: drill.scenario ?? '', explanation: drill.explanation ?? '', options: drill.options ?? [] } }),
    ...(originalDefect ? { originalDefect } : {}),
    ...(around ? { around } : {}),
    ...(cost ? { cost: { ...cost, generationAttempts } } : {}),
    // A Prediction or Diagnosis has no code to work on: its code and tests are the ones it was Verified with.
    files: answersOnly(kind)
      ? { code: solution, test: originalTest, solution, originalTest, ...(previous ? { previous } : {}) }
      : { code: profile.codeFilename, test: profile.testFilename, solution, originalTest },
  };

  const files: Record<string, string> = {
    ...(answersOnly(kind)
      ? {}
      : { ...profile.supportFiles, [profile.codeFilename]: drill.startingCode ?? '', [profile.testFilename]: drill.testSuiteCode }),
    'README.md': kind === 'prediction' ? predictionReadme(record) : kind === 'diagnosis' ? diagnosisReadme(record) : readme(drill, record, dir, paths.repoRoot),
    [solution]: drill.referenceSolution,
    [originalTest]: drill.testSuiteCode,
    ...(previous ? { [previous]: drill.previous! } : {}),
    'workout.json': JSON.stringify(record, null, 2) + '\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return record;
}

/** A new Series id, `series_<date>_<slug>`, not taken by any Workout's Series. */
export async function newSeriesId(paths: WorkspacePaths, slug: string, now = new Date()): Promise<string> {
  const base = `series_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${slug}`;
  const taken = new Set<string>();
  for (const dir of existsSync(paths.workoutsDir) ? await readdir(paths.workoutsDir) : []) {
    const json = await readFile(join(paths.workoutsDir, dir, 'workout.json'), 'utf8').catch(() => undefined);
    const id = json ? (JSON.parse(json) as WorkoutRecord).series?.id : undefined;
    if (id) taken.add(id);
  }
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function uniqueId(paths: WorkspacePaths, base: string): string {
  const taken = (id: string) => existsSync(join(paths.workoutsDir, id)) || existsSync(join(paths.doneDir, id));
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

function provenance(record: WorkoutRecord): string[] {
  const { commit, dirty } = record.source;
  const revision = commit
    ? `Derived from commit \`${commit.slice(0, 12)}\`${dirty ? ' plus uncommitted changes' : ''}.`
    : 'Derived from uncommitted code.';
  const cost = record.cost
    ? `Generated for ${describeCost(record.cost)} over ${plural(record.cost.generationAttempts, 'attempt')} (estimated with prices as of ${record.cost.pricesAsOf}).`
    : 'Generated by your coding agent (cost not measured: it used your agent\'s plan).';
  return [revision, '', cost];
}

/**
 * Written by Fiu, not the model: the Scenario and the options, sorted so the order they were written
 * in gives nothing away. The answer and the Source Anchors stay in workout.json until after answering.
 */
function predictionReadme(record: WorkoutRecord): string {
  const { scenario, options } = record.prediction!;
  const sorted = options.map((o) => o.text.trim()).sort((a, b) => a.localeCompare(b));
  return [
    `# ${record.title}`,
    '',
    ...(record.series ? [`*Question ${record.series.index} of ${record.series.of} about \`${record.source.path}\`.*`, ''] : []),
    ...trackPlacement(record),
    ...(record.whatIf ? [...whatIfLines(record.whatIf), ''] : []),
    ...aroundLines(record),
    '## Scenario',
    '',
    scenario.trim(),
    '',
    '## What happens?',
    '',
    ...sorted.map((text) => `- ${text}`),
    '',
    `Answer with \`fiu train ${record.id}\`.`,
    '',
    `## Source`,
    '',
    `\`${record.source.path}\`. ${provenance(record).join('\n')}`,
    '',
  ].join('\n');
}

/** Fiu's own line on every What-if's reveal: what was measured, and what wasn't. */
export const WHAT_IF_LIMITS = 'Measured on a self-contained copy of this unit, not your whole system. Nothing in your repository changed.';

/** The change as the human put it, and as the model read it: that the code matches the sentence is the model's word. */
/** After answering a Prediction about a rule: the rule as written, and whether the code follows it. */
export function ruleLines({ text, domain, agrees, note }: RulePlacement): string[] {
  return [`The rule this was about (Understand-Anything${domain ? `, ${domain}` : ''}): "${text}"`, `${agrees ? 'The code follows it' : 'The code does NOT follow it'}: ${note.trim()} (as measured; the comparison is the model's reading)`];
}

export function whatIfLines({ sentence, modelled }: WhatIfPlacement): string[] {
  return sentence ? [`Imagine this change: ${sentence}`, `Modelled as: ${modelled.trim()}`] : [`Imagine this change: ${modelled.trim()}`];
}

/** Readers can't see the code, so Fiu itself says the incident isn't real. */
export const PRACTICE_INCIDENT = "Practice incident: this didn't happen. The code here was changed on purpose.";

/** The incident shown: the true Cause's Symptom. */
export const incidentOf = (record: WorkoutRecord) => record.diagnosis!.causes.find((c) => c.correct)!.symptom.trim();

/** Written by Fiu, not the model: the incident and the Causes, sorted so their written order gives nothing away. */
function diagnosisReadme(record: WorkoutRecord): string {
  const sorted = record.diagnosis!.causes.map((c) => c.text.trim()).sort((a, b) => a.localeCompare(b));
  return [
    `# ${record.title}`,
    '',
    ...trackPlacement(record),
    `*${PRACTICE_INCIDENT}*`,
    '',
    ...aroundLines(record),
    '## What happened',
    '',
    incidentOf(record),
    '',
    '## What explains it?',
    '',
    ...sorted.map((text) => `- ${text}`),
    '',
    `Answer with \`fiu train ${record.id}\`.`,
    '',
    '## Source',
    '',
    `\`${record.source.path}\`. ${provenance(record).join('\n')}`,
    '',
  ].join('\n');
}

/** "Around this code", when the Workout has one, followed by a blank line. */
const aroundLines = (record: WorkoutRecord): string[] => (record.around && record.around.lines.length > 0 ? [...record.around.lines, ''] : []);

/** A Track step's README opens with its place in the Track. */
function trackPlacement(record: WorkoutRecord): string[] {
  if (!record.track) return [];
  const trackName = record.track.title
    ? `the Track "${record.track.title}"`
    : record.track.flow
      ? `a Track following the flow "${record.track.flow}"`
      : `a Track on ${record.track.module || 'this repository'}`;
  return [`*Part of ${trackName}: ${record.track.why}*`, ''];
}

function readme(drill: AnyWorkoutOutput, record: WorkoutRecord, dir: string, repoRoot: string): string {
  const link = relative(dir, join(repoRoot, record.source.path)).split('\\').join('/');
  const anchors = record.sourceAnchors.map(
    (a) => `- [${a.path}:${a.startLine}-${a.endLine}](${link}#L${a.startLine}-L${a.endLine}): ${a.explanation}`,
  );
  return [`# ${drill.title}`, '', ...trackPlacement(record), ...aroundLines(record), (drill.readmeMarkdown ?? '').trim(), '', '## Source', '', ...anchors, '', ...provenance(record), ''].join('\n');
}

/** "Around this code" is an extra: whatever goes wrong building it, the Verified Workout is saved without it. */
async function safeAround(
  paths: WorkspacePaths,
  profiles: readonly LanguageProfile[],
  profile: LanguageProfile,
  sourcePath: string,
  symbol: string | undefined,
  kind: WorkoutKind,
  drill: AnyWorkoutOutput,
): Promise<AroundThisCode | undefined> {
  try {
    const versions = { kind, referenceSolution: drill.referenceSolution, startingCode: drill.startingCode, previous: drill.previous, options: drill.options, causes: drill.causes };
    const answer = answerTexts(versions);
    return await aroundThisCode({ paths, profiles, profile, sourcePath, symbol, kind, referenceSolution: drill.referenceSolution, others: otherVersions(versions), ...(answer ? { answer } : {}) });
  } catch {
    return undefined;
  }
}
