import type { LanguageProfile } from './profile.ts';

const SHARED_RULES = [
  'Use only the standard library and the built-in test runner: no third-party packages.',
  'Put the code under test in a single file and the tests in a single test file.',
].join('\n');

const NO_JSX = 'Do not use JSX: extract the logic under test into plain functions.';


const base = { supportFiles: {}, env: {}, cacheDirs: [], extraReadPaths: [], extraWritePaths: [] };

export const TYPESCRIPT: LanguageProfile = {
  ...base,
  id: 'typescript',
  extensions: ['.ts', '.mts', '.cts', '.tsx'],
  codeFilename: 'kata.ts',
  testFilename: 'kata.test.ts',
  lineComment: '//',
  importStyle: 'relative',
  promptRules: [
    SHARED_RULES,
    'Tests use `node:test` (`describe`, `it`) and `node:assert/strict`.',
    'Use only erasable TypeScript syntax: no `enum`, `namespace`, parameter properties, or decorators.',
    "Import with explicit `.ts` extensions (`import { x } from './kata.ts'`), and `import type` for types.",
    NO_JSX,
  ].join('\n'),
  preflightCmd:
    'node --experimental-strip-types --no-warnings=ExperimentalWarning --input-type=module-typescript --eval "const ok: boolean = true"',
  // `--experimental-strip-types` is a no-op from Node 22.18 / 23.6 (where stripping is on by default)
  // and lets Workouts run on older 22.x releases.
  testCmd: 'node --experimental-strip-types --no-warnings=ExperimentalWarning --test --test-reporter=tap kata.test.ts',
  resultFormat: 'tap',
};

export const JAVASCRIPT: LanguageProfile = {
  ...base,
  id: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'],
  codeFilename: 'kata.mjs',
  testFilename: 'kata.test.mjs',
  lineComment: '//',
  importStyle: 'relative',
  promptRules: [
    SHARED_RULES,
    'Use ES modules. Tests use `node:test` (`describe`, `it`) and `node:assert/strict`.',
    "Import with explicit extensions (`import { x } from './kata.mjs'`).",
    NO_JSX,
  ].join('\n'),
  preflightCmd: 'node --version',
  testCmd: 'node --test --test-reporter=tap kata.test.mjs',
  resultFormat: 'tap',
};

export const PYTHON: LanguageProfile = {
  ...base,
  id: 'python',
  extensions: ['.py'],
  codeFilename: 'kata.py',
  testFilename: 'test_kata.py',
  lineComment: '#',
  importStyle: 'python',
  promptRules: [
    SHARED_RULES,
    'Tests use `unittest` (`unittest.TestCase` subclasses with `test_*` methods) and `from kata import ...`.',
  ].join('\n'),
  preflightCmd: 'python3 --version',
  testCmd: 'python3 -m unittest -v test_kata',
  resultFormat: 'unittest-verbose',
  env: { PYTHONDONTWRITEBYTECODE: '1' },
};

export const GO: LanguageProfile = {
  ...base,
  id: 'go',
  extensions: ['.go'],
  codeFilename: 'kata.go',
  testFilename: 'kata_test.go',
  lineComment: '//',
  supportFiles: { 'go.mod': 'module kata\n\ngo 1.21\n' },
  importStyle: 'go',
  promptRules: [
    SHARED_RULES,
    'Both files use `package kata`. Tests use the `testing` package only, reporting failures with `t.Errorf` / `t.Fatalf`.',
    'Target Go 1.21: no range-over-int or range-over-func.',
  ].join('\n'),
  // A cold build of Go's testing package takes ~8 s, close to the 10 s run timeout: warm the cache first.
  preflightCmd: 'go test .',
  warmup: {
    'kata.go': 'package kata\n',
    'kata_test.go': 'package kata\n\nimport "testing"\n\nfunc TestWarmup(t *testing.T) {}\n',
  },
  testCmd: 'go test -json .',
  resultFormat: 'go-json',
  // Never reach for the network: no module proxy, no toolchain downloads, no workspace files.
  env: { GOPROXY: 'off', GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local', GOWORK: 'off' },
  cacheDirs: ['GOCACHE'],
};

export const BUILTIN_PROFILES: readonly LanguageProfile[] = [TYPESCRIPT, JAVASCRIPT, PYTHON, GO];
