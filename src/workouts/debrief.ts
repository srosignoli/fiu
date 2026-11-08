import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLinks, NO_LINKS } from '../atlas/links.ts';
import { buildSkeleton } from '../atlas/skeleton.ts';
import { entryState, readAtlas } from '../atlas/store.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { SourceAnchor, WorkoutRecord } from './save.ts';

/**
 * The Debrief (§11.15, ADR 0009): after an Attempt finishes, what the target is for, who calls it, the
 * tensions its links show, and which neighbours to practise next. Computed when shown, from today's code,
 * Atlas, and links: there is nothing left to spoil.
 */
export interface Debrief {
  /** The source file changed since the Workout was made: links and descriptions are from today's code. */
  sourceChanged: boolean;
  anchors: SourceAnchor[];
  /** The target functions, with what the Atlas says each is for. */
  target: { name: string; text?: string }[];
  file?: { text: string; stale: boolean };
  /** Files that use this one and mention a target function by name. */
  callers: string[];
  usedBy: string[];
  /** Computed tension signals, one sentence each. */
  signals: string[];
  tryNext: { command: string; why: string }[];
}

export interface DebriefOptions {
  paths: WorkspacePaths;
  record: WorkoutRecord;
  sourceChanged: boolean;
  /** Absent when context is off: the Debrief is then only where the code lives. */
  profiles?: readonly LanguageProfile[];
}

/** At most this many "Try next" suggestions, and this many files in a list. */
const TRY_NEXT = 3;
const LISTED = 5;

export async function buildDebrief({ paths, record, sourceChanged, profiles }: DebriefOptions): Promise<Debrief> {
  const debrief: Debrief = { sourceChanged, anchors: record.sourceAnchors, target: [], callers: [], usedBy: [], signals: [], tryNext: [] };
  if (!profiles) return debrief;
  const path = record.source.path;
  const skeleton = await buildSkeleton(paths.repoRoot, profiles);
  const file = skeleton.files.get(path);
  if (!file) return debrief;
  const atlas = await readAtlas(paths);
  const links = await loadLinks(paths, skeleton, profiles);
  const own = links.files[path] ?? NO_LINKS;
  const hubs = new Set(links.hubs);

  // The target: the #symbol asked for, and the functions the Source Anchors point at.
  const entry = atlas.files[path];
  const names = new Set<string>(record.source.symbol ? [record.source.symbol] : []);
  for (const symbol of file.symbols) {
    if (!symbol.callable) continue;
    if (record.sourceAnchors.some((a) => a.path === path && symbol.startLine <= a.endLine && symbol.endLine >= a.startLine)) names.add(symbol.name);
  }
  // A function enclosing another (a class around its method) is not the target when the method is.
  const target = [...names].filter((name) => ![...names].some((other) => other !== name && other.startsWith(`${name}.`)));
  debrief.target = target.map((name) => ({ name, ...(entry?.functions[name] ? { text: entry.functions[name] } : {}) }));
  if (entry) debrief.file = { text: entry.text.replace(/\s*\n\s*/g, ' '), stale: entryState(entry, file.hash) === 'stale' };

  debrief.usedBy = own.importedBy;
  const spoken = target.map((name) => name.split('.').pop()!);
  for (const user of own.importedBy) {
    const text = await readFile(join(paths.repoRoot, user), 'utf8').catch(() => '');
    if (spoken.some((name) => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text))) debrief.callers.push(user);
  }

  // Tension signals: computed, never a model's word.
  const imported = new Set([...own.imports, ...own.importedBy]);
  const hidden = own.changesWith.filter((c) => !imported.has(c.path) && !hubs.has(c.path));
  if (own.importedBy.length > 0) debrief.signals.push(`Blast radius: ${plural(own.importedBy.length, 'file')} use this file${own.importedBy.length >= 5 ? ', so a change here travels far' : ''}.`);
  if (links.commitsRead > 0) debrief.signals.push(`Churn: changed in ${own.commits} of the last ${plural(links.commitsRead, 'commit')}.`);
  for (const c of hidden.slice(0, 2)) debrief.signals.push(`Hidden coupling: changes with ${c.path} (together in ${plural(c.shared, 'commit')}), though neither imports the other.`);
  if (hubs.has(path)) debrief.signals.push('Hub: this file changes with a third or more of the codebase.');

  // Try next: neighbours, as commands. Never a What-if sentence: that would need a model.
  const suggest = (command: string, why: string) => {
    if (debrief.tryNext.length < TRY_NEXT && !debrief.tryNext.some((t) => t.command.endsWith(` ${command.split(' ').pop()}`))) debrief.tryNext.push({ command, why });
  };
  const caller = debrief.callers[0] ?? own.importedBy[0];
  if (caller) suggest(`fiu predict ${caller}`, debrief.callers[0] ? `it calls ${spoken[0]}` : 'it uses this file');
  if (hidden[0]) suggest(`fiu diagnose ${hidden[0].path}`, 'it changes with this file, though neither imports the other');
  const dependency = own.imports.find((p) => !p.endsWith('/'));
  if (dependency) suggest(`fiu drill ${dependency}`, 'this file uses it');
  return debrief;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (paths: string[]) => paths.slice(0, LISTED).join(', ') + (paths.length > LISTED ? `, and ${paths.length - LISTED} more` : '');
const DESCRIPTIONS_NOTE = 'Descriptions are written by a model from the code, not Verified; links and signals are computed from imports and git history.';
const LINKS_NOTE = 'Links and signals are computed from imports and git history.';
const hasDescriptions = (d: Debrief) => d.target.some((t) => t.text) || d.file !== undefined;
const note = (d: Debrief) => (hasDescriptions(d) ? DESCRIPTIONS_NOTE : LINKS_NOTE);
/** Which users call the target: "all" when every one of them does. */
function calling(d: Debrief, code: (text: string) => string): string {
  if (d.callers.length === 0) return '';
  const names = d.target.map((t) => code(t.name.split('.').pop()!)).join(', ');
  return d.callers.length === d.usedBy.length ? ` (all call ${names})` : ` (calling ${names}: ${listed(d.callers.map(code))})`;
}
const CHANGED_NOTE = 'The source has changed since this Workout was made: what follows is about today\'s code.';
const hasContext = (d: Debrief) => d.target.some((t) => t.text) || d.file !== undefined || d.usedBy.length > 0 || d.signals.length > 0 || d.tryNext.length > 0;

/** The Debrief as the terminal shows it. */
export function renderDebriefText(d: Debrief): string {
  const lines = ['Debrief'];
  if (d.sourceChanged && hasContext(d)) lines.push(`  ${CHANGED_NOTE}`);
  if (d.anchors.length > 0) lines.push('  Where this lives:', ...d.anchors.map((a) => `    ${a.path}:${a.startLine}-${a.endLine}: ${a.explanation}`));
  const described = d.target.filter((t) => t.text);
  if (described.length > 0 || d.file) {
    lines.push('  What it is for:', ...described.map((t) => `    #${t.name}  ${t.text}`), ...(d.file ? [`    This file: ${d.file.text}${d.file.stale ? ' (written before the code last changed)' : ''}`] : []));
  }
  if (d.usedBy.length > 0) lines.push(`  Used by: ${listed(d.usedBy)}${calling(d, (s) => s)}`);
  if (d.signals.length > 0) lines.push('  Tensions:', ...d.signals.map((s) => `    ${s}`));
  if (d.tryNext.length > 0) {
    const width = Math.max(...d.tryNext.map((t) => t.command.length)) + 3;
    lines.push('  Try next:', ...d.tryNext.map((t) => `    ${t.command.padEnd(width)}${t.why}`));
  }
  if (hasContext(d)) lines.push(`  ${note(d)}`);
  return lines.join('\n');
}

/** The Debrief as `debrief.md` in the Attempt's directory. */
export function renderDebriefMarkdown(d: Debrief, record: WorkoutRecord): string {
  const lines = [`# Debrief: ${record.title}`, ''];
  if (d.sourceChanged && hasContext(d)) lines.push(`*${CHANGED_NOTE}*`, '');
  if (d.anchors.length > 0) lines.push('## Where this lives', '', ...d.anchors.map((a) => `- \`${a.path}:${a.startLine}-${a.endLine}\`: ${a.explanation}`), '');
  const described = d.target.filter((t) => t.text);
  if (described.length > 0 || d.file) {
    lines.push('## What it is for', '', ...described.map((t) => `- \`${t.name}\`: ${t.text}`), ...(d.file ? [`- This file: ${d.file.text}${d.file.stale ? ' *(written before the code last changed)*' : ''}`] : []), '');
  }
  if (d.usedBy.length > 0) {
    lines.push('## Used by', '', `${d.usedBy.map((p) => `\`${p}\``).join(', ')}${calling(d, (s) => `\`${s}\``)}`, '');
  }
  if (d.signals.length > 0) lines.push('## Tensions', '', ...d.signals.map((s) => `- ${s}`), '');
  if (d.tryNext.length > 0) lines.push('## Try next', '', ...d.tryNext.map((t) => `- \`${t.command}\`: ${t.why}`), '');
  if (hasContext(d)) lines.push(`*${note(d)}*`, '');
  return lines.join('\n');
}
