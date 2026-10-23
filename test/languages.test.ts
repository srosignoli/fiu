import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BUILTIN_PROFILES, GO, JAVASCRIPT, PYTHON, TYPESCRIPT } from '../src/languages/builtin.ts';
import { UserProfileSchema, type LanguageProfile, type UserProfile } from '../src/languages/profile.ts';
import { profileForFile, profiles, UnsupportedLanguageError } from '../src/languages/registry.ts';
import { preflight, runTests, ToolchainMissingError } from '../src/languages/run.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import { tempDir } from './helpers.ts';

const userProfile = (fields: Partial<UserProfile>): UserProfile =>
  UserProfileSchema.parse({
    id: 'rust',
    extensions: ['.rs'],
    codeFilename: 'src/lib.rs',
    testFilename: 'tests/kata.rs',
    preflightCmd: 'cargo --version',
    testCmd: 'cargo test',
    resultFormat: 'junit-xml',
    ...fields,
  });

describe('profiles', () => {
  it('picks the profile by file extension', () => {
    const all = profiles();
    assert.equal(profileForFile('src/queue.ts', all).id, 'typescript');
    assert.equal(profileForFile('web/App.JSX', all).id, 'javascript');
    assert.equal(profileForFile('api/scheduler.go', all).id, 'go');
    assert.equal(profileForFile('jobs/retry.py', all).id, 'python');
    assert.throws(() => profileForFile('Main.java', all), UnsupportedLanguageError);
  });

  it('adds declared profiles for new languages', () => {
    assert.equal(profileForFile('src/lib.rs', profiles([userProfile({})])).id, 'rust');
  });

  it('lets a declared profile take over a built-in one or one of its extensions', () => {
    const replacement = userProfile({ id: 'python', extensions: ['.py'], resultFormat: 'tap' });
    const all = profiles([], [replacement]);
    assert.equal(profileForFile('a.py', all).resultFormat, 'tap');
    assert.equal(all.filter((p) => p.id === 'python').length, 1);

    const deno = userProfile({ id: 'deno', extensions: ['.ts'] });
    assert.equal(profileForFile('a.ts', profiles([deno])).id, 'deno');
    assert.equal(profileForFile('a.mts', profiles([deno])).id, 'typescript');
  });

  it('prefers repo-level over user-level declarations', () => {
    const repo = userProfile({ testCmd: 'repo' });
    const user = userProfile({ testCmd: 'user' });
    assert.equal(profileForFile('a.rs', profiles([repo], [user])).testCmd, 'repo');
  });

  it('rejects declared profiles that ask for network access or escape the Workout directory', () => {
    assert.throws(() => userProfile({ network: true } as Partial<UserProfile>));
    assert.throws(() => userProfile({ resultFile: '../report.xml' }));
    assert.throws(() => userProfile({ resultFormat: 'go-json' as 'tap' }));
  });
});

// The real toolchains, run through the sandbox (or without one where it isn't installed).
const sandbox = await openSandbox({ allowUnsandboxed: true });
after(() => sandbox.dispose());
// One persistent toolchain cache for the whole file, as in real use; the preflight warms it.
const cacheRoot = await tempDir();

interface Sample {
  profile: LanguageProfile;
  code: string;
  tests: string;
  buggy: string;
}

const SAMPLES: Sample[] = [
  {
    profile: TYPESCRIPT,
    code: 'export function clamp(n: number, max: number): number { return n > max ? max : n; }\n',
    buggy: 'export function clamp(n: number, max: number): number { return n >= max ? n : max; }\n',
    tests: `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './kata.ts';
it('keeps small values', () => assert.equal(clamp(1, 5), 1));
it('caps large values', () => assert.equal(clamp(9, 5), 5));
`,
  },
  {
    profile: JAVASCRIPT,
    code: 'export const clamp = (n, max) => (n > max ? max : n);\n',
    buggy: 'export const clamp = (n, max) => (n >= max ? n : max);\n',
    tests: `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './kata.mjs';
it('keeps small values', () => assert.equal(clamp(1, 5), 1));
it('caps large values', () => assert.equal(clamp(9, 5), 5));
`,
  },
  {
    profile: PYTHON,
    code: 'def clamp(n, max_):\n    return max_ if n > max_ else n\n',
    buggy: 'def clamp(n, max_):\n    return n if n >= max_ else max_\n',
    tests: `import unittest
from kata import clamp

class ClampTest(unittest.TestCase):
    def test_keeps_small_values(self):
        self.assertEqual(clamp(1, 5), 1)

    def test_caps_large_values(self):
        self.assertEqual(clamp(9, 5), 5)
`,
  },
  {
    profile: GO,
    code: 'package kata\n\nfunc Clamp(n, max int) int {\n\tif n > max {\n\t\treturn max\n\t}\n\treturn n\n}\n',
    buggy: 'package kata\n\nfunc Clamp(n, max int) int {\n\tif n >= max {\n\t\treturn n\n\t}\n\treturn max\n}\n',
    tests: `package kata

import "testing"

func TestKeepsSmallValues(t *testing.T) {
	if got := Clamp(1, 5); got != 1 {
		t.Errorf("Clamp(1, 5) = %d, want 1", got)
	}
}

func TestCapsLargeValues(t *testing.T) {
	if got := Clamp(9, 5); got != 5 {
		t.Errorf("Clamp(9, 5) = %d, want 5", got)
	}
}
`,
  },
];

async function workout(profile: LanguageProfile, files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, content] of Object.entries({ ...profile.supportFiles, ...files })) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe(`built-in profiles (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('covers every built-in profile', () => {
    assert.deepEqual(SAMPLES.map((s) => s.profile.id), BUILTIN_PROFILES.map((p) => p.id));
  });

  for (const { profile, code, buggy, tests } of SAMPLES) {
    describe(profile.id, () => {
      it('passes preflight', async () => {
        await preflight(sandbox, profile, cacheRoot);
      });

      it('reports passing tests', async () => {
        const dir = await workout(profile, { [profile.codeFilename]: code, [profile.testFilename]: tests });
        const run = await runTests(sandbox, profile, dir, cacheRoot);
        assert.equal(run.ran, true, run.output);
        assert.deepEqual(run.tests.map((t) => t.outcome), ['pass', 'pass'], run.output);
      });

      it('reports the failing test as an assertion failure', async () => {
        const dir = await workout(profile, { [profile.codeFilename]: buggy, [profile.testFilename]: tests });
        const run = await runTests(sandbox, profile, dir, cacheRoot);
        assert.equal(run.ran, true, run.output);
        assert.deepEqual(
          run.tests.map((t) => t.outcome).sort(),
          ['assertion-failure', 'assertion-failure'],
          run.output,
        );
      });

      it('reports code that does not compile as not run', async () => {
        const dir = await workout(profile, { [profile.codeFilename]: `${code}\n)(\n`, [profile.testFilename]: tests });
        const run = await runTests(sandbox, profile, dir, cacheRoot);
        assert.equal(run.ran, false, run.output);
        assert.notEqual(run.output, '');
      });
    });
  }
});

describe('declared profiles', () => {
  it('report a missing toolchain', async () => {
    const missing = profiles([userProfile({ preflightCmd: 'definitely-not-a-toolchain --version' })])[0]!;
    await assert.rejects(preflight(sandbox, missing, await tempDir()), ToolchainMissingError);
  });

  it('read JUnit XML from their result file', async () => {
    const profile = profiles([
      userProfile({ testCmd: 'sh run.sh', resultFile: 'out/report.xml', codeFilename: 'run.sh', testFilename: 'unused' }),
    ])[0]!;
    const dir = await workout(profile, {
      'run.sh':
        'mkdir -p out && printf \'<testsuite><testcase name="a"/><testcase name="b"><failure/></testcase></testsuite>\' > out/report.xml\n',
    });
    const run = await runTests(sandbox, profile, dir, await tempDir());
    assert.equal(run.ran, true, run.output);
    assert.deepEqual(run.tests, [
      { name: 'a', outcome: 'pass' },
      { name: 'b', outcome: 'assertion-failure' },
    ]);
  });

  it('treat a missing result file as not run, even if a stale one existed', async () => {
    const profile = profiles([userProfile({ testCmd: 'true', resultFile: 'report.xml' })])[0]!;
    const dir = await workout(profile, { 'report.xml': '<testcase name="stale"/>' });
    assert.equal((await runTests(sandbox, profile, dir, await tempDir())).ran, false);
  });

  it('get persistent cache directories and their env', async () => {
    const profile = profiles([userProfile({ testCmd: 'sh t.sh', resultFormat: 'tap', cacheDirs: ['MY_CACHE'], env: { GREETING: 'hi' } })])[0]!;
    const dir = await workout(profile, { 't.sh': 'echo "$GREETING" > "$MY_CACHE/seen" && echo "ok 1 - cached"\n' });
    const cacheRoot = await tempDir();
    const run = await runTests(sandbox, profile, dir, cacheRoot);
    assert.deepEqual(run.tests, [{ name: 'cached', outcome: 'pass' }], run.output);
    assert.equal(await readFile(join(cacheRoot, 'rust', 'MY_CACHE', 'seen'), 'utf8'), 'hi\n');
  });
});

describe('resource limits on test runs', () => {
  it('report a run that hits a limit as stopped, with a reason', async () => {
    // A test that keeps 20 children alive for 2 s: long enough for the watchdog's 250 ms sampling to see.
    const spawning = `import { it } from 'node:test';
import { spawn } from 'node:child_process';
it('spawns', async () => {
  const children = Array.from({ length: 20 }, () => spawn('sleep', ['2']));
  await Promise.all(children.map((c) => new Promise((resolve) => c.on('exit', resolve))));
});
`;
    const profile: LanguageProfile = { ...TYPESCRIPT, limits: { processes: 10 } };
    const dir = await workout(profile, { [profile.codeFilename]: SAMPLES[0]!.code, [profile.testFilename]: spawning });
    const run = await runTests(sandbox, profile, dir, await tempDir());
    assert.equal(run.ran, false, run.output);
    assert.equal(run.stopped, 'processes');
    assert.match(run.output, /Stopped: the tests started more than 10 processes\. Look for runaway forking or spawning\.$/);
  });

  it('can be raised by declared profiles, but not switched off', () => {
    assert.deepEqual(userProfile({ limits: { memoryMiB: 4096 } }).limits, { memoryMiB: 4096 });
    assert.throws(() => userProfile({ limits: { processes: 0 } }));
    assert.throws(() => userProfile({ limits: { unlimited: true } as never }));
  });
});
