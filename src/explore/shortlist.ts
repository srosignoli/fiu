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
}

export const SHORTLIST_SIZE = 10;
/** Files shorter than this rarely hold a unit worth a Drill. */
const MIN_LINES = 15;
const OUTLINE_LINES = 12;

/** Branching and error-handling constructs common to the supported languages. */
const BRANCHING = /\b(if|else|for|while|switch|case|catch|except|elif|match|select|defer|go|await|try|throw|raise|return)\b|&&|\|\||\?\?|=>/g;
/** Lines that declare something: functions, types, classes, exported values. */
const DECLARATION = /^\s*(export\s|pub\s|public\s|def\s|async\s+def\s|class\s|func\s|function\s|interface\s|type\s|struct\s|enum\s|const\s+\w+\s*=\s*(async\s*)?\(|impl\s)/;

export class ExploreTargetError extends Error {}

/** The module's most logic-dense source files, at most SHORTLIST_SIZE, densest first. */
export async function shortlist(repoRoot: string, modulePath: string, profiles: readonly LanguageProfile[]): Promise<Candidate[]> {
  const absolute = join(repoRoot, modulePath);
  const info = await stat(absolute).catch(() => undefined);
  if (!info) throw new ExploreTargetError(`${modulePath} does not exist.`);
  if (!info.isDirectory()) throw new ExploreTargetError(`${modulePath} is a file: explore a module directory, or drill one file with \`kin drill ${modulePath}\`.`);

  // Tracked files only: what the team shares, not local build output.
  const { stdout } = await execa('git', ['ls-files', '-z', '--', modulePath || '.'], { cwd: repoRoot });
  const candidates: Candidate[] = [];
  for (const path of stdout.split('\0').filter(Boolean)) {
    if (!isDrillableSourcePath(path)) continue;
    let profile: LanguageProfile;
    try {
      profile = profileForFile(path, profiles);
    } catch (error) {
      if (error instanceof UnsupportedLanguageError) continue;
      throw error;
    }
    const source = await readFile(join(repoRoot, path), 'utf8').catch(() => undefined);
    if (source === undefined) continue;
    const lines = source.split('\n');
    if (lines.length < MIN_LINES || lines.length > MAX_SOURCE_LINES) continue;
    const branches = source.match(BRANCHING)?.length ?? 0;
    candidates.push({
      path: path.split(sep).join('/'),
      profile,
      lines: lines.length,
      // Density, gently favouring bigger files: a 40-line helper and a 600-line module can tie on density alone.
      score: (branches / lines.length) * Math.log10(lines.length),
      outline: lines.filter((line) => DECLARATION.test(line)).slice(0, OUTLINE_LINES).map((line) => line.trim().slice(0, 120)),
    });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, SHORTLIST_SIZE);
}

export const repoRelativeDir = (repoRoot: string, dir: string) => relative(repoRoot, dir).split(sep).join('/');
