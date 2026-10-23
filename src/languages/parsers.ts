import type { ResultFormat, TestResult } from './profile.ts';

/** What a parser extracts; `undefined` means the tests never got to run. */
export type ParsedTests = TestResult[] | undefined;

export interface RawRun {
  stdout: string;
  stderr: string;
  /** Contents of the profile's result file, when it declares one. */
  resultFile?: string;
}

export const PARSERS: Record<ResultFormat, (raw: RawRun) => ParsedTests> = {
  tap: ({ stdout, resultFile }) => parseTap(resultFile ?? stdout),
  'junit-xml': ({ stdout, resultFile }) => parseJunitXml(resultFile ?? stdout),
  'go-json': ({ stdout }) => parseGoJson(stdout),
  'unittest-verbose': ({ stderr }) => parseUnittestVerbose(stderr),
};

const TAP_RESULT = /^(\s*)(not ok|ok) \d+(?: - (.*?))?(?: # (SKIP|TODO)\b.*)?$/i;
const TAP_SUBTEST = /^(\s*)# Subtest: (.*)$/;

/**
 * TAP 13 as emitted by `node --test`: nested subtests are indented by four spaces and suites are
 * marked `type: 'suite'`. Leaf tests are named by their path, e.g. `add > handles zero`.
 */
export function parseTap(text: string): ParsedTests {
  const lines = text.split('\n');
  const path: string[] = [];
  const tests: TestResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const subtest = TAP_SUBTEST.exec(lines[i]!);
    if (subtest) {
      const depth = subtest[1]!.length / 4;
      path.length = depth;
      path[depth] = subtest[2]!.trim();
      continue;
    }
    const result = TAP_RESULT.exec(lines[i]!);
    if (!result) continue;
    const [, indent, status, name = '', directive] = result;
    const depth = indent!.length / 4;
    const yaml = yamlBlock(lines, i + 1, indent!.length);
    // A file that fails to load is reported as one synthetic test carrying the process's exit code.
    if (yaml.exitCode !== undefined) return undefined;
    if (yaml.type === 'suite' || directive) continue;
    tests.push({
      name: [...path.slice(0, depth), name.trim()].join(' > '),
      outcome: status === 'ok' ? 'pass' : yaml.code === 'ERR_ASSERTION' ? 'assertion-failure' : 'error',
    });
  }
  return tests.length > 0 ? tests : undefined;
}

/** The top-level keys of the `---` … `...` YAML block that may follow a TAP result line. */
function yamlBlock(lines: string[], start: number, indent: number): Record<string, string> {
  const fields: Record<string, string> = {};
  if (lines[start]?.trim() !== '---') return fields;
  const keyIndent = ' '.repeat(indent + 2);
  for (let i = start + 1; i < lines.length && lines[i]!.trim() !== '...'; i++) {
    const line = lines[i]!;
    if (!line.startsWith(keyIndent) || line[keyIndent.length] === ' ') continue;
    const match = /^(\w+): ?(.*)$/.exec(line.slice(keyIndent.length));
    if (match) fields[match[1]!] = match[2]!.replace(/^'(.*)'$/, '$1');
  }
  return fields;
}

interface GoEvent {
  Action: string;
  Test?: string;
  Output?: string;
}

/**
 * `go test -json`: subtests are named `Parent/child`, and only leaf tests are reported. Go has no
 * assertion library, so `t.Error`/`t.Fatal` failures count as assertion failures and panics as errors.
 * A build failure produces no test events at all.
 */
export function parseGoJson(stdout: string): ParsedTests {
  const outcomes = new Map<string, 'pass' | 'fail'>();
  const panicked = new Set<string>();
  for (const line of stdout.split('\n')) {
    let event: GoEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event.Test) continue;
    if (event.Action === 'pass' || event.Action === 'fail') outcomes.set(event.Test, event.Action);
    if (event.Action === 'output' && /^panic: /m.test(event.Output ?? '')) panicked.add(event.Test);
  }
  const names = [...outcomes.keys()];
  const tests = names
    .filter((name) => !names.some((other) => other.startsWith(`${name}/`)))
    .map((name): TestResult => ({
      name,
      outcome: outcomes.get(name) === 'pass' ? 'pass' : panicked.has(name) ? 'error' : 'assertion-failure',
    }));
  return tests.length > 0 ? tests : undefined;
}

const UNITTEST_TEST = /^(\w+) \((?:[\w.]+\.)?(\w+\.\w+)\)/;
const UNITTEST_FAILURE = /^(FAIL|ERROR): (\w+) \((?:[\w.]+\.)?(\w+\.\w+)\)/;
const UNITTEST_SKIP = /^(\w+) \((?:[\w.]+\.)?(\w+\.\w+)\) \.\.\. skipped/;

/**
 * `python -m unittest -v` (on stderr). Verbose progress lines are fragile (docstrings and anything the
 * tests print can split them), so they only supply test names; outcomes come from the `FAIL:` /
 * `ERROR:` blocks of the final report. Tests are named `Class.method`.
 */
export function parseUnittestVerbose(stderr: string): ParsedTests {
  // Without the closing "Ran N tests" line the run crashed, e.g. on an import or syntax error.
  if (!/^Ran \d+ tests? in /m.test(stderr) || /unittest\.loader\._FailedTest/.test(stderr)) return undefined;
  const outcomes = new Map<string, TestResult['outcome']>();
  const skipped = new Set<string>();
  for (const line of stderr.split('\n')) {
    const failure = UNITTEST_FAILURE.exec(line);
    if (failure) {
      // A test with several failing subTests is reported once per subTest; an error outranks a failure.
      const name = failure[3]!;
      if (failure[1] === 'ERROR' || outcomes.get(name) !== 'error') {
        outcomes.set(name, failure[1] === 'ERROR' ? 'error' : 'assertion-failure');
      }
      continue;
    }
    const skip = UNITTEST_SKIP.exec(line);
    if (skip) skipped.add(skip[2]!);
    const test = UNITTEST_TEST.exec(line);
    if (test && !outcomes.has(test[2]!)) outcomes.set(test[2]!, 'pass');
  }
  const tests = [...outcomes]
    .filter(([name]) => !skipped.has(name))
    .map(([name, outcome]) => ({ name, outcome }));
  return tests.length > 0 ? tests : undefined;
}

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;

/** JUnit XML: `<failure>` is an assertion failure, `<error>` an error; skipped tests are left out. */
export function parseJunitXml(xml: string): ParsedTests {
  const tests: TestResult[] = [];
  for (const [, attributes = '', body = ''] of xml.matchAll(TESTCASE)) {
    if (/<skipped\b/.test(body)) continue;
    const name = attribute(attributes, 'name');
    const classname = attribute(attributes, 'classname');
    tests.push({
      name: classname ? `${classname}.${name}` : name,
      outcome: /<error\b/.test(body) ? 'error' : /<failure\b/.test(body) ? 'assertion-failure' : 'pass',
    });
  }
  return tests.length > 0 ? tests : undefined;
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return decodeXml(match?.[1] ?? match?.[2] ?? '');
}

function decodeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[entity]!);
}
