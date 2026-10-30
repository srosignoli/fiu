import type { DirEntry, FileEntry, FileState, MapReport, Suggestion } from './map.ts';

const MARKS: Record<FileState, string> = { red: '●', amber: '◐', green: '✓', grey: '·' };
const CODES: Record<FileState, string> = { red: '31', amber: '33', green: '32', grey: '2' };

export interface RenderOptions {
  /** ANSI colours (off for pipes and NO_COLOR). */
  color: boolean;
}

export function renderMap(report: MapReport, { color }: RenderOptions): string {
  const paint = (state: FileState, text: string) => (color ? `\x1b[${CODES[state]}m${text}\x1b[0m` : text);
  const lines: string[] = [];
  const legend = `${paint('red', '●')} complex, never practised   ${paint('amber', '◐')} out of date or AI-changed   ${paint('green', '✓')} practised`;

  // An Atlas entry, dimmed, on the line under what it describes; ≈ when the code changed since.
  const note = (indent: string, atlas: { text: string; stale: boolean } | undefined) =>
    atlas ? atlas.text.split('\n').map((line, i) => paint('grey', `${indent}${i === 0 && atlas.stale ? '≈ ' : ''}${line}`)) : [];

  // Drilling into one directory: its files. Otherwise: every directory with something to say.
  const single = report.scope && report.dirs.length === 1 && report.dirs[0]!.path === report.scope;
  if (single) {
    const dir = report.dirs[0]!;
    lines.push(`${dir.path}  ${counts(dir, paint)}`, ...note('', dir.atlas), legend, '');
    for (const file of dir.files) {
      lines.push(`  ${paint(file.state, MARKS[file.state])} ${basename(file.path).padEnd(32)} ${paint(file.state === 'grey' ? 'grey' : file.state, describe(file))}`.trimEnd());
      lines.push(...note('      ', file.atlas));
    }
  } else {
    // With an Atlas the map is also for orientation: every directory, each with what it is for.
    const shown = report.atlas ? report.dirs : report.dirs.filter((d) => d.state !== 'grey');
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
