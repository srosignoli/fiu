import { homedir } from 'node:os';
import { readAtlasOverlay, uaNotice } from '../atlas/overlay.ts';
import { buildSkeleton } from '../atlas/skeleton.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { ruleChecks } from '../workouts/rulechecks.ts';
import { findRepoRoot, workspacePaths } from '../workspace.ts';
import { buildMap, type FileState } from './map.ts';

/**
 * `fiu map --flows` (ADR 0010): comprehension by business flow instead of by directory, for people who
 * think in what the product does. Practice per file comes from the map; flows and rules are
 * Understand-Anything's; each rule's status is what a Prediction measured, if one did.
 */
export interface FlowMapReport {
  repository: string;
  domains: FlowMapDomain[];
  suggestions: { command: string; why: string }[];
  /** Understand-Anything's graph in use, and how far behind it is. */
  notice?: string;
}

export interface FlowMapDomain {
  name: string;
  /** Rules of the domain and its flows, with what their latest check found. */
  rules: { text: string; status: RuleStatus; target?: string; staleReason?: string }[];
  flows: FlowMapFlow[];
}

/** `follows`/`breaks`: a Prediction measured it; `stale`: the measured code changed since; `unchecked`: never measured. */
export type RuleStatus = 'follows' | 'breaks' | 'stale' | 'unchecked';

export interface FlowMapFlow {
  name: string;
  entry?: string;
  /** Its files in the order the flow reaches them, with their map state. */
  files: { path: string; state: FileState; practised: boolean; blindSpot: boolean }[];
  practised: number;
}

/** At most this many suggestions. */
const SUGGESTIONS = 3;
/** A Track needs this many files. */
const TRACK_FILES = 3;

export async function buildFlowMap(cwd: string, { configEnv = { env: process.env, home: homedir() } }: { configEnv?: ConfigEnv } = {}): Promise<FlowMapReport> {
  const repoRoot = await findRepoRoot(cwd);
  const paths = workspacePaths(repoRoot);
  const config = resolveConfig(await loadRepoConfig(paths.configFile), await loadUserConfig(configEnv));
  const skeleton = await buildSkeleton(repoRoot, config.profiles);
  const { ua } = await readAtlasOverlay(paths, skeleton);
  const notice = uaNotice(ua);
  const report: FlowMapReport = { repository: repoRoot, domains: [], suggestions: [], ...(notice ? { notice } : {}) };
  if (ua.status !== 'read' || ua.atlas.flows.length === 0) return report;

  const map = await buildMap(repoRoot, '', { configEnv });
  const files = new Map(map.dirs.flatMap((d) => d.files.map((f) => [f.path, f] as const)));
  const checks = await ruleChecks(paths, config.profiles);

  const byDomain = new Map<string, FlowMapDomain>();
  const domainOf = (name: string) => {
    let domain = byDomain.get(name);
    if (!domain) {
      domain = { name, rules: [], flows: [] };
      byDomain.set(name, domain);
    }
    return domain;
  };
  for (const flow of ua.atlas.flows) {
    const paths = [...new Set(flow.steps.flatMap((s) => (s.path ? [s.path] : [])))];
    const rows = paths.map((path) => {
      const file = files.get(path);
      return { path, state: file?.state ?? ('grey' as const), practised: file?.practice !== undefined, blindSpot: file?.blindSpot !== undefined };
    });
    domainOf(flow.domain ?? '(no domain)').flows.push({ name: flow.name, ...(flow.entry ? { entry: flow.entry } : {}), files: rows, practised: rows.filter((r) => r.practised).length });
  }
  for (const rule of ua.atlas.rules) {
    const check = checks.get(rule.text);
    const status: RuleStatus = !check ? 'unchecked' : check.stale ? 'stale' : check.agrees ? 'follows' : 'breaks';
    domainOf(rule.domain ?? '(no domain)').rules.push({ text: rule.text, status, ...(check ? { target: check.target } : {}), ...(check?.staleReason ? { staleReason: check.staleReason } : {}) });
  }
  report.domains = [...byDomain.values()];

  // Next: re-check what broke or went out of date, then the least-practised flow a Track can follow, then the unchecked rules.
  const suggest = (command: string, why: string) => {
    if (report.suggestions.length < SUGGESTIONS) report.suggestions.push({ command, why });
  };
  const rules = report.domains.flatMap((d) => d.rules);
  for (const rule of rules.filter((r) => r.status === 'breaks')) suggest(`fiu predict ${rule.target} --rule "${rule.text}"`, 'the code did not follow this rule: check whether it still doesn\'t');
  for (const rule of rules.filter((r) => r.status === 'stale')) suggest(`fiu predict ${rule.target} --rule "${rule.text}"`, `checked before ${rule.staleReason}`);
  const flows = report.domains.flatMap((d) => d.flows).filter((f) => f.files.length >= TRACK_FILES && f.practised < f.files.length);
  const least = flows.sort((a, b) => a.practised / a.files.length - b.practised / b.files.length || b.files.length - a.files.length)[0];
  if (least) suggest(`fiu explore --flow "${least.name}"`, `${least.practised} of its ${least.files.length} files practised`);
  const unchecked = rules.filter((r) => r.status === 'unchecked').length;
  if (unchecked > 0) suggest('fiu predict --rule', `${unchecked} rule${unchecked === 1 ? '' : 's'} never checked against the code`);
  return report;
}

const MARKS: Record<FileState, string> = { red: '●', amber: '◐', green: '✓', grey: '·' };
const CODES: Record<FileState, string> = { red: '31', amber: '33', green: '32', grey: '2' };
const RULE_MARKS: Record<RuleStatus, string> = { follows: '✓', breaks: '✗', stale: '◐', unchecked: '·' };

export function renderFlowMap(report: FlowMapReport, { color }: { color: boolean }): string {
  const paint = (state: FileState, text: string) => (color ? `\x1b[${CODES[state]}m${text}\x1b[0m` : text);
  const dim = (text: string) => paint('grey', text);
  if (report.domains.length === 0) {
    return report.notice ?? 'No Understand-Anything flows here: run /understand and then /understand-domain in Claude Code, or use `fiu map` for directories.';
  }
  const lines = [
    'Comprehension map of flows (UA)',
    `${paint('red', '●')} complex, never practised   ${paint('amber', '◐')} out of date or AI-changed   ${paint('green', '✓')} practised   ${paint('red', '⚠')} Blind Spot`,
    dim('Rules: ✓ the code follows it  ✗ it does not  ◐ that code changed since  · never checked (as Predictions measured)'),
    '',
  ];
  for (const domain of report.domains) {
    const count = (status: RuleStatus) => domain.rules.filter((r) => r.status === status).length;
    const tally = domain.rules.length === 0 ? '' : dim(`   rules: ${count('follows')} ✓  ${count('breaks')} ✗  ${count('stale')} ◐  ${count('unchecked')} ·`);
    lines.push(`${domain.name}${tally}`);
    for (const flow of domain.flows) {
      lines.push(`  ${flow.name}  ${dim(`${flow.practised} of ${flow.files.length} file${flow.files.length === 1 ? '' : 's'} practised`)}`);
      if (flow.files.length > 0) lines.push(`    ${flow.files.map((f) => `${paint(f.state, MARKS[f.state])}${f.blindSpot ? paint('red', '⚠') : ''} ${f.path}`).join('  ')}`);
    }
    // Rules worth a look are named; the ones that hold are only counted.
    for (const rule of domain.rules.filter((r) => r.status === 'breaks' || r.status === 'stale')) {
      lines.push(`  ${RULE_MARKS[rule.status]} "${rule.text}" ${dim(`→ ${rule.target}${rule.staleReason ? ` (${rule.staleReason})` : ''}`)}`);
    }
    lines.push('');
  }
  if (report.suggestions.length > 0) lines.push('Next:', ...report.suggestions.map((s) => `  ${s.command}  ${dim(s.why)}`));
  if (report.notice) lines.push('', dim(report.notice));
  return lines.join('\n').trimEnd();
}
