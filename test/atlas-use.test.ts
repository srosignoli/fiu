import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { renderAtlasMarkdown, renderAtlasText, type AtlasView } from '../src/atlas/render.ts';
import { searchAtlas, targetOf, words } from '../src/atlas/search.ts';
import { buildSkeleton } from '../src/atlas/skeleton.ts';
import { emptyAtlas, writeAtlas, type Atlas } from '../src/atlas/store.ts';
import { atlasView, searchAtlasCommand } from '../src/commands/atlas.ts';
import { profiles } from '../src/languages/registry.ts';
import { buildMap, type FileState } from '../src/map/map.ts';
import { renderMap } from '../src/map/render.ts';
import { ensureWorkspace, workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';

const fn = (name: string, body = 'return x;') => `export function ${name}(x: number) {\n  if (x > 1) return 1;\n  if (x > 2) return 2;\n  ${body}\n}\n`;

async function repo() {
  const dir = await tempGitRepo();
  const files: Record<string, string> = {
    'src/queue/retry.ts': fn('retryWithBackoff') + fn('jitter'),
    'src/queue/worker.ts': fn('runJob'),
    'src/db/store.ts': fn('saveRecord') + 'export interface RetryPolicy {\n  max: number;\n}\n',
    'src/db/store.test.ts': fn('testRetry'),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  const paths = workspacePaths(dir);
  await ensureWorkspace(paths);
  return { dir, paths };
}

/** An Atlas describing everything as of now. */
async function describe_(dir: string): Promise<Atlas> {
  const skeleton = await buildSkeleton(dir, profiles());
  const atlas = emptyAtlas();
  const entry = (hash: string, text: string) => ({ hash, text, writtenAt: '2026-10-30T00:00:00.000Z' });
  const folder = (path: string, text: string) => (atlas.folders[path] = entry(skeleton.folders.get(path)!.hash, text));
  const file = (path: string, text: string, functions: Record<string, string> = {}) => (atlas.files[path] = { ...entry(skeleton.files.get(path)!.hash, text), functions });
  folder('', 'A job runner.\nsrc holds everything.');
  folder('src', 'The application.');
  folder('src/queue', 'Runs jobs and tries failed ones again.');
  folder('src/db', 'Where records are kept.');
  file('src/queue/retry.ts', 'Tries a failed job again, waiting longer each time.', { retryWithBackoff: 'Waits longer after each failure before trying again.', jitter: 'Spreads waits out at random.' });
  file('src/queue/worker.ts', 'Takes jobs off the queue and runs them.', { runJob: 'Runs one job and records whether it failed.' });
  file('src/db/store.ts', 'Saves records.', { saveRecord: 'Writes one record.' });
  return atlas;
}

describe('searchAtlas', () => {
  it('stems words and splits names', () => {
    assert.deepEqual(words('How do retries work in retryWithBackoff?'), ['retry', 'retry', 'backoff']);
    assert.deepEqual(words('verified, retried'), ['verify', 'retry']);
  });

  it('ranks names over entries, functions over types, then never-practised code first', async () => {
    const { dir } = await repo();
    const skeleton = await buildSkeleton(dir, profiles());
    const states = new Map<string, FileState>([['src/queue/retry.ts', 'green'], ['src/db/store.ts', 'red']]);
    const namesOnly = searchAtlas('how retries work', skeleton, emptyAtlas(), states).map(targetOf);
    // A test file is never a target; a function beats a type with the same score.
    assert.deepEqual(namesOnly, ['src/queue/retry.ts', 'src/queue/retry.ts#retryWithBackoff', 'src/db/store.ts#RetryPolicy']);

    const atlas = await describe_(dir);
    const results = searchAtlas('retrying failed jobs', skeleton, atlas, states);
    // retry.ts: its name, and "failed job" in its entry. runJob: its name and "failed"; retryWithBackoff
    // ties it, but runJob was never practised. (Each word's weight is scaled by how rare it is.)
    assert.deepEqual(results.slice(0, 3).map(targetOf), ['src/queue/retry.ts', 'src/queue/worker.ts#runJob', 'src/queue/retry.ts#retryWithBackoff']);
    assert.ok(results[0]!.score > results[1]!.score);
    assert.equal(results[1]!.score, results[2]!.score);
    assert.equal(results[2]!.text, 'Waits longer after each failure before trying again.');
  });

  it('weights a rare word over a common one', async () => {
    const dir = await tempGitRepo();
    const files: Record<string, string> = {
      'src/drill/a.ts': 'export function drillA() {\n  return 1;\n}\n',
      'src/drill/b.ts': 'export function drillB() {\n  return 1;\n}\n',
      'src/drill/c.ts': 'export function drillC() {\n  return 1;\n}\n',
      'src/verify/gate.ts': 'export function verify() {\n  return 1;\n}\n',
    };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(dir, name, '..'), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    await execa('git', ['add', '.'], { cwd: dir });
    // "drill" names three files of four, "verify" one: the gate comes first.
    const results = searchAtlas('how a drill is verified', await buildSkeleton(dir, profiles()), emptyAtlas(), new Map());
    assert.equal(results[0]!.path, 'src/verify/gate.ts');
  });

  it('matches a word to its longer forms', async () => {
    const { dir } = await repo();
    const skeleton = await buildSkeleton(dir, profiles());
    assert.deepEqual(searchAtlas('jobs', skeleton, emptyAtlas(), new Map()).map(targetOf), ['src/queue/worker.ts#runJob']);
  });

  it('finds nothing in stopwords alone', async () => {
    const { dir } = await repo();
    assert.deepEqual(searchAtlas('how does it work', await buildSkeleton(dir, profiles()), emptyAtlas(), new Map()), []);
  });

  it('runs from the command with map states', async () => {
    const { dir } = await repo();
    const { results, described } = await searchAtlasCommand(dir, 'backoff', { configEnv: { env: {}, home: await tempDir() } });
    assert.equal(described, false);
    assert.deepEqual(results.map(targetOf), ['src/queue/retry.ts#retryWithBackoff']);
  });
});

describe('the Atlas in fiu map', () => {
  it('shows the overview and what each directory and file is for, and what changed since', async () => {
    const { dir, paths } = await repo();
    const configEnv = { env: {}, home: await tempDir() };
    let text = renderMap(await buildMap(dir, '', { configEnv }), { color: false });
    assert.doesNotMatch(text, /A job runner/);

    await writeAtlas(paths, await describe_(dir));
    const report = await buildMap(dir, '', { configEnv });
    assert.deepEqual(report.atlas, { overview: { text: 'A job runner.\nsrc holds everything.', stale: false }, staleFiles: 0, staleFolders: 0 });
    text = renderMap(report, { color: false });
    assert.match(text, /^Comprehension map\nA job runner\.\nsrc holds everything\.\n/);
    assert.match(text, /src\/queue\n {6}Runs jobs and tries failed ones again\./);
    assert.match(text, /src\/db\n {6}Where records are kept\./, 'every directory is shown once there is an Atlas');

    await writeFile(join(dir, 'src/queue/worker.ts'), fn('runJob', 'return 0;'));
    text = renderMap(await buildMap(dir, 'src/queue', { configEnv }), { color: false });
    assert.match(text, /worker\.ts.*\n {6}≈ Takes jobs off the queue and runs them\./);
    assert.match(text, /Atlas: 1 file\(s\) changed since described \(≈\): `fiu atlas build` to refresh\./);
  });
});

describe('fiu atlas', () => {
  it('prints the Atlas as text, and as Markdown', async () => {
    const { dir, paths } = await repo();
    await writeAtlas(paths, await describe_(dir));
    const view: AtlasView = await atlasView(dir, undefined, { configEnv: { env: {}, home: await tempDir() } });
    const text = renderAtlasText(view, { color: false });
    assert.match(text, /^Atlas of fiu-test-\w+\nWritten by a model from the code; not Verified\.\n\nA job runner\./);
    assert.match(text, /src\/queue\/ {2}Runs jobs and tries failed ones again\.\n {2}retry\.ts {2}Tries a failed job again, waiting longer each time\.\n {6}#retryWithBackoff {2}Waits longer/);
    assert.match(text, /store\.test\.ts \(test or generated\)\n/);

    const markdown = renderAtlasMarkdown({ ...view, scope: 'src/db' }, new Date('2026-10-30T12:00:00Z'));
    assert.equal(
      markdown,
      '# Atlas of `src/db`\n\n> Written by a model from the code; not Verified. Generated by Fiu on 2026-10-30.\n\n## `src/db/`\n\nWhere records are kept.\n\n- **`store.test.ts`** (test or generated)\n- **`store.ts`**: Saves records.\n  - `saveRecord`: Writes one record.\n',
    );
  });

  it('says how to build an empty Atlas', async () => {
    const { dir } = await repo();
    const text = renderAtlasText(await atlasView(dir, 'src', { configEnv: { env: {}, home: await tempDir() } }), { color: false });
    assert.match(text, /Nothing described yet: `fiu atlas build`, or ask your agent: \/fiu-atlas$/);
  });
});
