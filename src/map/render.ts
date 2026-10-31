import type { Confidence } from '../workouts/attempts.ts';
import type { DirEntry, FileEntry, FileState, MapReport, Suggestion } from './map.ts';
import { MIN_ANSWERS, type PredictionStats, type Tally } from './stats.ts';

const MARKS: Record<FileState, string> = { red: '●', amber: '◐', green: '✓', grey: '·' };
const CODES: Record<FileState, string> = { red: '31', amber: '33', green: '32', grey: '2' };

export interface RenderOptions {
  /** ANSI colours (off for pipes and NO_COLOR). */
  color: boolean;
}

export function renderMap(report: MapReport, { color }: RenderOptions): string {
  const paint = (state: FileState, text: string) => (color ? `\x1b[${CODES[state]}m${text}\x1b[0m` : text);
  const lines: string[] = [];
  const hasBlind = report.dirs.some((d) => d.blindSpots > 0);
  const legend = `${paint('red', '●')} complex, never practised   ${paint('amber', '◐')} out of date or AI-changed   ${paint('green', '✓')} practised${hasBlind ? `   ${paint('red', '⚠')} Blind Spot: you were certain, and wrong` : ''}`;

  // An Atlas entry, dimmed, on the line under what it describes; ≈ when the code changed since.
  const note = (indent: string, atlas: { text: string; stale: boolean } | undefined) =>
    atlas ? atlas.text.split('\n').map((line, i) => paint('grey', `${indent}${i === 0 && atlas.stale ? '≈ ' : ''}${line}`)) : [];

  // Drilling into one directory: its files. Otherwise: every directory with something to say.
  const single = report.scope && report.dirs.length === 1 && report.dirs[0]!.path === report.scope;
  if (single) {
    const dir = report.dirs[0]!;
    lines.push(`${dir.path}  ${counts(dir, paint)}`, ...note('', dir.atlas), legend, '');
    for (const file of dir.files) {
      const blind = file.blindSpot ? `${paint('red', '⚠')} ` : '';
      lines.push(`  ${paint(file.state, MARKS[file.state])} ${basename(file.path).padEnd(32)} ${blind}${paint(file.state === 'grey' ? 'grey' : file.state, describe(file))}`.trimEnd());
      lines.push(...note('      ', file.atlas));
    }
  } else {
    // With an Atlas the map is also for orientation: every directory, each with what it is for.
    const shown = report.atlas ? report.dirs : report.dirs.filter((d) => d.state !== 'grey' || d.blindSpots > 0);
    lines.push(`Comprehension map${report.scope ? ` of ${report.scope}` : ''}`, ...(report.scope ? [] : note('', report.atlas?.overview)), legend, '');
    if (shown.every((d) => d.state === 'grey')) lines.push('  Nothing complex left unpractised here.');
    const width = Math.min(48, Math.max(...shown.map((d) => (d.path || '.').length), 10));
    for (const dir of shown) {
      lines.push(`  ${paint(dir.state, MARKS[dir.state])} ${(dir.path || '.').padEnd(width)}  ${counts(dir, paint)}`.trimEnd());
      lines.push(...note('      ', dir.atlas));
    }
    const quiet = report.dirs.length - shown.length;
    if (quiet > 0) lines.push(paint('grey', `  … and ${quiet} director${quiet === 1 ? 'y' : 'ies'} with nothing to worry about`));
  }

  if (report.atlas && report.atlas.staleFiles + report.atlas.staleFolders > 0) {
    const changed = [report.atlas.staleFiles > 0 ? `${report.atlas.staleFiles} file(s)` : '', report.atlas.staleFolders > 0 ? `${report.atlas.staleFolders} folder(s)` : ''].filter(Boolean).join(' and ');
    lines.push('', paint('grey', `Atlas: ${changed} changed since described (≈): \`kin atlas build\` to refresh.`));
  }

  if (report.suggestions.length > 0) {
    lines.push('', 'Next:');
    for (const suggestion of report.suggestions) lines.push(`  ${command(suggestion)}`);
  }
  return lines.join('\n');
}

function counts(dir: DirEntry, paint: (state: FileState, text: string) => string): string {
  const parts = (['red', 'amber', 'green'] as const).filter((s) => dir.counts[s] > 0).map((s) => paint(s, `${MARKS[s]}${dir.counts[s]}`));
  if (dir.blindSpots > 0) parts.push(paint('red', `⚠${dir.blindSpots}`));
  return parts.join(' ');
}

function describe(file: FileEntry): string {
  const waiting = file.waitingWorkout ? ` (a ${noun(file.waitingWorkout)} is waiting: kin train ${file.waitingWorkout})` : '';
  switch (file.state) {
    case 'red':
      return `complex, never practised${waiting}`;
    case 'amber':
      return file.practice ? `changed ${file.staleBy} lines since you practised it${waiting}` : `changed by AI recently, never practised${waiting}`;
    case 'green':
      return file.practice === 'completed' ? 'practised' : 'practised (gave up, saw the solution)';
    case 'grey':
      return '';
  }
}

function command(suggestion: Suggestion): string {
  switch (suggestion.kind) {
    case 'check':
      return `kin predict ${suggestion.path}   (you were certain about it, and wrong: check your picture again)`;
    case 'train':
      return `kin train ${suggestion.workoutId}   (a ${noun(suggestion.workoutId)} is already waiting for ${suggestion.path})`;
    case 'explore':
      return `kin explore ${suggestion.path || '.'}   (${suggestion.red} complex files never practised)`;
    case 'drill':
      return `kin drill ${suggestion.path}   (or ask your agent: /kin-drill ${suggestion.path})`;
  }
}

/** Workout ids start with their kind. */
const noun = (workoutId: string) => (workoutId.startsWith('kata_') ? 'Kata' : 'Drill');

const basename = (path: string) => path.split('/').pop() ?? path;

const LEVELS: Record<Confidence, string> = { guessing: 'Guessing', 'fairly-sure': 'Fairly sure', certain: 'Certain' };

/** `kin stats`: accuracy, calibration, trend, the weakest directories, and Blind Spots. A rate needs MIN_ANSWERS answers. */
export function renderStats(stats: PredictionStats, { color }: RenderOptions): string {
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
  const red = (text: string) => (color ? `\x1b[31m${text}\x1b[0m` : text);
  const pct = (t: Tally) => (t.answers >= MIN_ANSWERS ? `${Math.round((100 * t.right) / t.answers)}%` : '—');
  const of = (t: Tally) => `${t.right} of ${t.answers}`;
  const where = stats.scope ? ` in ${stats.scope}` : '';
  if (stats.overall.answers === 0) return `No Predictions answered${where} yet. Ask for one with: kin predict${stats.scope ? ` ${stats.scope}` : ''}`;

  const lines = [`Your Predictions${where}: ${pct(stats.overall)} right (${of(stats.overall)}, first answers only)`, ''];
  const rated = stats.calibration.filter((c) => c.answers > 0);
  if (rated.length > 0) {
    lines.push('How sure you were, and how often you were right:');
    for (const level of stats.calibration) {
      const gap = level.answers >= MIN_ANSWERS ? level.right / level.answers - level.expected : 0;
      const note = level.answers < MIN_ANSWERS ? '' : gap <= -0.2 ? red('  overconfident') : gap >= 0.2 ? '  underconfident' : '  well calibrated';
      lines.push(`  ${LEVELS[level.confidence].padEnd(12)} ${pct(level).padStart(4)} right  (${of(level)}; expected about ${Math.round(level.expected * 100)}%)${note}`);
    }
    lines.push('');
  }
  const { recent, before } = stats.trend;
  if (recent.answers > 0 && before.answers > 0) lines.push(`Last 30 days: ${pct(recent)} (${of(recent)}); before: ${pct(before)} (${of(before)})`, '');
  const dirs = stats.byDirectory.filter((d) => d.answers > 0);
  if (dirs.length > 1) {
    lines.push('By directory, weakest first:');
    for (const dir of dirs) lines.push(`  ${(dir.path || '.').padEnd(32)} ${pct(dir).padStart(4)}  (${of(dir)})`);
    lines.push('');
  }
  if (stats.blindSpots.length > 0) {
    lines.push(red('⚠ Blind Spots: you were certain, and wrong'));
    for (const spot of stats.blindSpots) lines.push(`  ${spot.path}   check again: kin predict ${spot.path}`);
  } else if (rated.length > 0) {
    lines.push('No Blind Spots: nothing you were certain of turned out wrong.');
  }
  lines.push(dim(`Rates appear once ${MIN_ANSWERS} answers are behind them. Only on this machine.`));
  return lines.join('\n').trimEnd();
}
