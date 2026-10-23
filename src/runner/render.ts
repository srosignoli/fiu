import type { TestResult } from '../languages/profile.ts';
import type { SessionRun } from './session.ts';

const MARKS: Record<TestResult['outcome'], string> = { pass: '✓', 'assertion-failure': '✗', error: '!' };
const OUTPUT_TAIL_LINES = 25;
const MESSAGE_LINES = 12;

export function formatRun({ run, verdict, attempts }: SessionRun): string {
  const label = attempts === 0 ? 'Initial run' : `Run ${attempts}`;
  if (verdict.kind === 'not-run') {
    return [`${label}: the tests did not run.`, indent(tail(run.output))].join('\n');
  }
  const passed = run.tests.filter((t) => t.outcome === 'pass').length;
  const lines = [`${label}: ${passed}/${run.tests.length} passing`];
  for (const test of run.tests) {
    lines.push(`  ${MARKS[test.outcome]} ${test.name}`);
    if (test.message) lines.push(indent(head(test.message, MESSAGE_LINES)));
  }
  // A failure with nothing to show for it: fall back to the runner's own output.
  if (verdict.kind === 'failing' && run.tests.some((t) => t.outcome !== 'pass' && !t.message)) {
    lines.push('', indent(tail(run.output)));
  }
  if (verdict.kind === 'tests-edited') {
    lines.push('', 'Every test passes, but the test file was edited. Restore the original tests to complete this Workout.');
  }
  return lines.join('\n');
}

function head(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length > max ? [...lines.slice(0, max), '…'].join('\n') : text;
}

function tail(output: string): string {
  const lines = output.trimEnd().split('\n');
  return lines.length > OUTPUT_TAIL_LINES ? ['…', ...lines.slice(-OUTPUT_TAIL_LINES)].join('\n') : lines.join('\n');
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
