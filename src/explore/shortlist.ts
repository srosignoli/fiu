import { readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { execa } from 'execa';
import { isDrillableSourcePath } from '../languages/paths.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { profileForFile, UnsupportedLanguageError } from '../languages/registry.ts';
import { MAX_SOURCE_LINES } from '../synthesis/prompt.ts';

export interface Candidate {
  /** Relative to the repository root. */
  path: string;
  profile: LanguageProfile;
  lines: number;
  /** Branching constructs per line: a language-neutral proxy for how much logic a file holds. */
  score: number;
  /** Declaration lines, so the ordering call can see what the file is about without reading it all. */
  outline: string[];
  /** What the Atlas says the file and its key functions are for, when it has an entry: shown in place of the outline. */
  atlas?: string;
  /** For a Track following a flow: the flow's steps this file runs (`step 3 of 7: Read and screen the commit`). */
  flowSteps?: string;
}

export const SHORTLIST_SIZE = 10;
/** Files shorter than this rarely hold a unit worth a Drill. */
const MIN_LINES = 15;
const OUTLINE_LINES = 12;

/** Branching and error-handling constructs common to the supported languages. */
const BRANCHING = /\b(if|else|for|while|switch|case|catch|except|elif|match|select|defer|go|await|try|throw|raise|return)\b|&&|\|\||\?\?|=>/g;
/** Branching constructs in a piece of source. */
export const branchCount = (source: string) => source.match(BRANCHING)?.length ?? 0;

/** Lines that declare something: functions, types, classes, exported values. */
const DECLARATION = /^\s*(export\s|pub\s|public\s|def\s|async\s+def\s|class\s|func\s|function\s|interface\s|type\s|struct\s|enum\s|const\s+\w+\s*=\s*(async\s*)?\(|impl\s)/;

export class ExploreTargetError extends Error {}

/** The module's most logic-dense source files, at most SHORTLIST_SIZE, densest first. */
export async function shortlist(repoRoot: string, modulePath: string, profiles: readonly LanguageProfile[]): Promise<Candidate[]> {
  const absolute = join(repoRoot, modulePath);
  const info = await stat(absolute).catch(() => undefined);
  if (!info) throw new ExploreTargetError(`${modulePath} does not exist.`);
  if (!info.isDirectory()) throw new ExploreTargetError(`${modulePath} is a file: explore a module directory, or drill one file with \`fiu drill ${modulePath}\`.`);

  // Tracked files only: what the team shares, not local build output.
  const { stdout } = await execa('git', ['ls-files', '-z', '--', modulePath || '.'], { cwd: repoRoot });
  const candidates: Candidate[] = [];
  for (const path of stdout.split('\0').filter(Boolean)) {
    const candidate = await candidateFor(repoRoot, path, profiles);
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, SHORTLIST_SIZE);
}

/**
 * One file as a Track candidate, or undefined when it isn't worth a step: a test or generated file, a
 * language Fiu doesn't know, or too short or too long to drill.
 */
export async function candidateFor(repoRoot: string, path: string, profiles: readonly LanguageProfile[]): Promise<Candidate | undefined> {
  if (!isDrillableSourcePath(path)) return undefined;
  let profile: LanguageProfile;
  try {
    profile = profileForFile(path, profiles);
  } catch (error) {
    if (error instanceof UnsupportedLanguageError) return undefined;
    throw error;
  }
  const source = await readFile(join(repoRoot, path), 'utf8').catch(() => undefined);
  if (source === undefined) return undefined;
  const scored = logicScore(source);
  if (!scored) return undefined;
  return {
    path: path.split(sep).join('/'),
    profile,
    ...scored,
    outline: source.split('\n').filter((line) => DECLARATION.test(line)).slice(0, OUTLINE_LINES).map((line) => line.trim().slice(0, 120)),
  };
}

/**
 * How much logic a source file holds: branching constructs per line, gently favouring bigger files (a
 * 40-line helper and a 600-line module can tie on density alone). Undefined for files too short or too
 * long to drill. Shared by `fiu explore` and `fiu map`.
 */
export function logicScore(source: string): { lines: number; score: number } | undefined {
  const lines = source.split('\n').length;
  if (lines < MIN_LINES || lines > MAX_SOURCE_LINES) return undefined;
  const branches = branchCount(source);
  return { lines, score: (branches / lines) * Math.log10(lines) };
}

export const repoRelativeDir = (repoRoot: string, dir: string) => relative(repoRoot, dir).split(sep).join('/');
