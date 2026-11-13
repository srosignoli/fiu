import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLinks, NO_LINKS } from '../atlas/links.ts';
import { buildSkeleton } from '../atlas/skeleton.ts';
import { fromUa, readAtlasOverlay, UA_LABEL, UA_MARK } from '../atlas/overlay.ts';
import { entryState } from '../atlas/store.ts';
import { flowsThrough, type FlowMatch } from '../atlas/ua.ts';
import { locateRule } from '../atlas/rules.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { profileForFile } from '../languages/registry.ts';
import { diffLines } from '../verify/diff.ts';
import type { WorkspacePaths } from '../workspace.ts';
import { otherVersions, targetNames } from './context.ts';
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
  /** The file's entry, and so its functions', came from Understand-Anything's graph (ADR 0010). */
  fromUa?: boolean;
  /** Files that use this one and mention a target function by name, with the names each mentions. */
  callers: { path: string; calls: string[] }[];
  usedBy: string[];
  /** Computed tension signals, one sentence each. */
  signals: string[];
  /** The business flows this code is a step of, from Understand-Anything's domain graph (ADR 0010). */
  flows: DebriefFlow[];
  /** Business rules from that graph that Fiu locates in the target: what this code may be enforcing. */
  rules: { text: string; domain?: string }[];
  tryNext: { command: string; why: string }[];
}

/** One flow through the target: where it starts, which step this is, and the steps either side. */
export interface DebriefFlow {
  name: string;
  domain?: string;
  entry?: string;
  /** 1-based. */
  step: number;
  of: number;
  stepName: string;
  /** `code`: this step is the target's code; `file`: the step is elsewhere in the target's file. */
  where: FlowMatch['where'];
  /** The file changed since UA analysed it. */
  stale: boolean;
  before?: { name: string; path?: string };
  after?: { name: string; path?: string };
}

export interface DebriefOptions {
  paths: WorkspacePaths;
  record: WorkoutRecord;
  sourceChanged: boolean;
  /** Absent when context is off: the Debrief is then only where the code lives. */
  profiles?: readonly LanguageProfile[];
}

/** At most this many "Try next" suggestions, and this many files in a list; at most this many flows. */
const TRY_NEXT = 3;
const FLOWS = 2;
const RULES = 3;
const LISTED = 5;

export async function buildDebrief({ paths, record, sourceChanged, profiles }: DebriefOptions): Promise<Debrief> {
  const debrief: Debrief = { sourceChanged, anchors: record.sourceAnchors, target: [], callers: [], usedBy: [], signals: [], flows: [], rules: [], tryNext: [] };
  if (!profiles) return debrief;
  const path = record.source.path;
  const skeleton = await buildSkeleton(paths.repoRoot, profiles);
  const file = skeleton.files.get(path);
  if (!file) return debrief;
  const { atlas, ua } = await readAtlasOverlay(paths, skeleton);
  const links = await loadLinks(paths, skeleton, profiles);
  const own = links.files[path] ?? NO_LINKS;
  const hubs = new Set(links.hubs);

  const entry = atlas.files[path];
  const target = await findTarget(paths, record, file.symbols, profiles);
  debrief.target = target.map((name) => ({ name, ...(entry?.functions[name] ? { text: entry.functions[name] } : {}) }));
  if (entry) debrief.file = { text: entry.text.replace(/\s*\n\s*/g, ' '), stale: entryState(entry, file.hash) === 'stale' };
  if (fromUa(entry)) debrief.fromUa = true;
  if (ua.status === 'read') {
    // A rule counts when one of its located places is a target function; only rules that could reach this file are located.
    const reach = ua.atlas.rules.filter((r) => r.files.length === 0 || r.files.includes(path) || file.symbols.some((s) => r.text.includes(s.name.split('.').pop()!)));
    for (const rule of reach) {
      if (debrief.rules.length >= RULES) break;
      const places = await locateRule(rule, paths.repoRoot, skeleton, atlas);
      if (places.some((p) => p.path === path && target.includes(p.symbol))) debrief.rules.push({ text: rule.text, ...(rule.domain ? { domain: rule.domain } : {}) });
    }
    const ranges = file.symbols.filter((s) => target.includes(s.name));
    debrief.flows = flowsThrough(ua.atlas.flows, path, ranges).slice(0, FLOWS).map(({ flow, index, where }) => {
      const step = flow.steps[index]!;
      const neighbour = (i: number) => (flow.steps[i] ? { name: flow.steps[i]!.name, ...(flow.steps[i]!.path ? { path: flow.steps[i]!.path } : {}) } : undefined);
      const [before, after] = [neighbour(index - 1), neighbour(index + 1)];
      return {
        name: flow.name,
        ...(flow.domain ? { domain: flow.domain } : {}),
        ...(flow.entry ? { entry: flow.entry } : {}),
        step: index + 1,
        of: flow.steps.length,
        stepName: step.name,
        where,
        stale: !step.current,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      };
    });
  }

  debrief.usedBy = own.importedBy;
  const spoken = [...new Set(target.map((name) => name.split('.').pop()!))];
  for (const user of own.importedBy) {
    const text = await readFile(join(paths.repoRoot, user), 'utf8').catch(() => '');
    const calls = spoken.filter((name) => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text));
    if (calls.length > 0) debrief.callers.push({ path: user, calls });
  }

  // Tension signals: computed, never a model's word.
  const imported = new Set([...own.imports, ...own.importedBy]);
  const hidden = own.changesWith.filter((c) => !imported.has(c.path) && !hubs.has(c.path));
  if (own.importedBy.length > 0) debrief.signals.push(`Blast radius: ${plural(own.importedBy.length, 'file')} ${own.importedBy.length === 1 ? 'uses' : 'use'} this file${own.importedBy.length >= 5 ? ', so a change here travels far' : ''}.`);
  if (links.commitsRead > 0) debrief.signals.push(`Churn: changed in ${own.commits} of the last ${plural(links.commitsRead, 'commit')}.`);
  for (const c of hidden.slice(0, 2)) debrief.signals.push(`Hidden coupling: changes with ${c.path} (together in ${plural(c.shared, 'commit')}), though neither imports the other.`);
  if (hubs.has(path)) debrief.signals.push('Hub: this file changes with a third or more of the codebase.');

  // Try next: neighbours, as commands. Never a What-if sentence: that would need a model.
  const suggest = (command: string, why: string) => {
    if (debrief.tryNext.length < TRY_NEXT && !debrief.tryNext.some((t) => t.command.endsWith(` ${command.split(' ').pop()}`))) debrief.tryNext.push({ command, why });
  };
  const caller = debrief.callers[0];
  if (caller) suggest(`fiu predict ${caller.path}`, `it calls ${caller.calls[0]}`);
  else if (own.importedBy[0]) suggest(`fiu predict ${own.importedBy[0]}`, 'it uses this file');
  if (hidden[0]) suggest(`fiu diagnose ${hidden[0].path}`, 'it changes with this file, though neither imports the other');
  // The next step of a flow, in another file: where the work goes after this code.
  const next = debrief.flows.find((f) => f.after?.path && f.after.path !== path);
  if (next) suggest(`fiu predict ${next.after!.path}`, `it is the next step of "${next.name}" (UA)`);
  const dependency = own.imports.find((p) => !p.endsWith('/'));
  if (dependency) suggest(`fiu drill ${dependency}`, 'this file uses it');
  return debrief;
}

/**
 * The functions the Workout is about: those where its other versions differ from the Reference Solution
 * (a Drill's bug, a Kata's gap, a Prediction's or Diagnosis's Variants, as "Around this code" finds them),
 * kept when the source file has a function of that name. Otherwise, the `#symbol` and the functions the
 * Source Anchors overlap today.
 */
async function findTarget(paths: WorkspacePaths, record: WorkoutRecord, symbols: { name: string; callable: boolean; startLine: number; endLine: number }[], profiles: readonly LanguageProfile[]): Promise<string[]> {
  const callable = new Set(symbols.filter((s) => s.callable).map((s) => s.name));
  const dir = join(paths.workoutsDir, record.id);
  const read = (file: string | undefined) => (file ? readFile(join(dir, file), 'utf8').catch(() => undefined) : Promise.resolve(undefined));
  const solution = await read(record.files?.solution);
  if (solution !== undefined) {
    const others = otherVersions({
      kind: record.kind,
      referenceSolution: solution,
      startingCode: record.kind === 'drill' || record.kind === 'kata' ? await read(record.files.code) : undefined,
      previous: await read(record.files.previous),
      options: record.prediction?.options,
      causes: record.diagnosis?.causes,
    });
    const hunks = others.flatMap((other) => diffLines(solution, other));
    const names = targetNames({ referenceSolution: solution, profile: profileForFile(record.source.path, profiles), symbol: record.source.symbol }, hunks);
    const found = names.filter((name) => callable.has(name));
    if (found.length > 0) return innermost(found);
  }
  const names = new Set<string>(record.source.symbol ? [record.source.symbol] : []);
  for (const symbol of symbols) {
    if (symbol.callable && record.sourceAnchors.some((a) => a.path === record.source.path && symbol.startLine <= a.endLine && symbol.endLine >= a.startLine)) names.add(symbol.name);
  }
  return innermost([...names]);
}

/** A function enclosing another (a class around its method) is not the target when the method is. */
const innermost = (names: string[]) => names.filter((name) => !names.some((other) => other !== name && other.startsWith(`${name}.`)));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (paths: string[]) => paths.slice(0, LISTED).join(', ') + (paths.length > LISTED ? `, and ${paths.length - LISTED} more` : '');
const DESCRIPTIONS_NOTE = 'Descriptions are written by a model from the code, not Verified; links and signals are computed from imports and git history.';
const LINKS_NOTE = 'Links and signals are computed from imports and git history.';
const DESCRIPTIONS_NOTE_UA = `Descriptions are written by a model from the code, not Verified (those marked ${UA_MARK} by ${UA_LABEL}); links and signals are computed from imports and git history.`;
const FLOWS_NOTE = `Flows and rules are ${UA_LABEL}'s reading of the code (marked ${UA_MARK}), not Verified; Fiu locates rules by their words.`;
const ruleLine = (r: { text: string; domain?: string }) => `"${r.text}"${r.domain ? ` (${r.domain})` : ''} ${UA_MARK}`;
const hasDescriptions = (d: Debrief) => d.target.some((t) => t.text) || d.file !== undefined;
const note = (d: Debrief) =>
  [!hasDescriptions(d) ? LINKS_NOTE : d.fromUa ? DESCRIPTIONS_NOTE_UA : DESCRIPTIONS_NOTE, ...((d.flows.length > 0 || d.rules.length > 0) && !d.fromUa ? [FLOWS_NOTE] : [])].join(' ');
/** Which step of which flow this is: `This code is step 1 of 7, "Expire stale Workouts", in "Refill the Queue from a Commit"`. */
const flowHead = (f: DebriefFlow) =>
  `${f.where === 'code' ? 'This code is' : 'This file holds'} step ${f.step} of ${f.of}, "${f.stepName}", in "${f.name}"${f.domain ? ` (${f.domain})` : ''} ${UA_MARK}${f.stale ? ', read before the file last changed' : ''}`;
const flowSides = (f: DebriefFlow, code: (s: string) => string) => {
  const side = (s: { name: string; path?: string }) => `${s.name}${s.path ? ` (${code(s.path)})` : ''}`;
  return [
    ...(f.entry ? [`starts with: ${code(f.entry)}`] : []),
    ...(f.before ? [`before: ${side(f.before)}`] : []),
    ...(f.after ? [`after: ${side(f.after)}`] : []),
  ];
};
/** After a description from Understand-Anything. */
const ua = (d: Debrief) => (d.fromUa ? ` ${UA_MARK}` : '');
/** Which users call which target function: "all call x" when every user calls the one target. */
function calling(d: Debrief, code: (text: string) => string): string {
  if (d.callers.length === 0) return '';
  const names = [...new Set(d.callers.flatMap((c) => c.calls))];
  if (names.length === 1) {
    return d.callers.length === d.usedBy.length ? ` (all call ${code(names[0]!)})` : ` (calling ${code(names[0]!)}: ${listed(d.callers.map((c) => code(c.path)))})`;
  }
  return ` (calling ${listed(d.callers.map((c) => `${code(c.path)} → ${c.calls.map(code).join(', ')}`))})`;
}
const CHANGED_NOTE = 'The source has changed since this Workout was made: what follows is about today\'s code.';
const hasContext = (d: Debrief) =>
  d.target.some((t) => t.text) || d.file !== undefined || d.usedBy.length > 0 || d.signals.length > 0 || d.flows.length > 0 || d.rules.length > 0 || d.tryNext.length > 0;

/** The Debrief as the terminal shows it. */
export function renderDebriefText(d: Debrief): string {
  const lines = ['Debrief'];
  if (d.sourceChanged && hasContext(d)) lines.push(`  ${CHANGED_NOTE}`);
  if (d.anchors.length > 0) lines.push('  Where this lives:', ...d.anchors.map((a) => `    ${a.path}:${a.startLine}-${a.endLine}: ${a.explanation}`));
  const described = d.target.filter((t) => t.text);
  if (described.length > 0 || d.file) {
    lines.push('  What it is for:', ...described.map((t) => `    #${t.name}  ${t.text}${ua(d)}`), ...(d.file ? [`    This file: ${d.file.text}${d.file.stale ? ' (written before the code last changed)' : ''}${ua(d)}`] : []));
  }
  if (d.flows.length > 0) lines.push('  Where it runs:', ...d.flows.flatMap((f) => [`    ${flowHead(f)}`, ...flowSides(f, (s) => s).map((s) => `      ${s}`)]));
  if (d.rules.length > 0) lines.push('  Rules it may enforce:', ...d.rules.map((r) => `    ${ruleLine(r)}`));
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
    lines.push('## What it is for', '', ...described.map((t) => `- \`${t.name}\`: ${t.text}${ua(d)}`), ...(d.file ? [`- This file: ${d.file.text}${d.file.stale ? ' *(written before the code last changed)*' : ''}${ua(d)}`] : []), '');
  }
  if (d.flows.length > 0) {
    const code = (s: string) => `\`${s}\``;
    lines.push('## Where it runs', '', ...d.flows.flatMap((f) => [`- ${flowHead(f)}`, ...flowSides(f, code).map((s) => `  - ${s}`)]), '');
  }
  if (d.rules.length > 0) lines.push('## Rules it may enforce', '', ...d.rules.map((r) => `- ${ruleLine(r)}`), '');
  if (d.usedBy.length > 0) {
    lines.push('## Used by', '', `${d.usedBy.map((p) => `\`${p}\``).join(', ')}${calling(d, (s) => `\`${s}\``)}`, '');
  }
  if (d.signals.length > 0) lines.push('## Tensions', '', ...d.signals.map((s) => `- ${s}`), '');
  if (d.tryNext.length > 0) lines.push('## Try next', '', ...d.tryNext.map((t) => `- \`${t.command}\`: ${t.why}`), '');
  if (hasContext(d)) lines.push(`*${note(d)}*`, '');
  return lines.join('\n');
}
