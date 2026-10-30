import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { checkAtlasOutput, type AtlasOutput } from '../src/atlas/describe.ts';
import { AtlasTargetError, buildSkeleton } from '../src/atlas/skeleton.ts';
import { emptyAtlas, readAtlas } from '../src/atlas/store.ts';
import { buildAtlas, planAtlasCalls } from '../src/commands/atlas.ts';
import { costReport } from '../src/commands/cost.ts';
import { profiles } from '../src/languages/registry.ts';
import { readState } from '../src/workouts/store.ts';
import { workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo } from './helpers.ts';
import { scriptedModel } from './mock-model.ts';

const GET = 'export function get(id: string) {\n  if (!id) return undefined;\n  if (id === "x") return 1;\n  return id;\n}\n';

async function repo(extra: Record<string, string> = {}) {
  const dir = await tempGitRepo();
  const files: Record<string, string> = {
    'src/db/store.ts': GET,
    'src/db/store.test.ts': 'test("get", () => {});\n',
    'src/ui/view.ts': 'export const view = () => 1;\n',
    'main.ts': 'console.log(1);\n',
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const DB: AtlasOutput = { folder: 'Data access.', files: [{ path: 'src/db/store.ts', text: 'Reads records by id.', functions: [{ name: 'get', text: 'Looks a record up.' }] }] };
const UI: AtlasOutput = { folder: 'What the user sees.', files: [{ path: 'src/ui/view.ts', text: 'Renders the page.', functions: [] }] };
const SRC: AtlasOutput = { folder: 'The application.', files: [] };
const ROOT: AtlasOutput = { folder: 'A small app.\nsrc holds the code.', files: [{ path: 'main.ts', text: 'Starts the app.', functions: [] }] };

async function build(dir: string, replies: (AtlasOutput | string)[], { path, yes = true, confirm }: { path?: string; yes?: boolean; confirm?: (m: string) => Promise<boolean> } = {}) {
  const scripted = scriptedModel(...(replies.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))));
  const steps: string[] = [];
  const result = await buildAtlas(
    dir,
    path,
    { yes },
    { step: (m) => steps.push(m), warn: () => {}, confirm },
    { createModel: () => ({ model: scripted.model, providerOptions: {} }), configEnv: { env: { ANTHROPIC_API_KEY: 'k' }, home: await tempDir() } },
  );
  return { result, prompts: scripted.prompts, steps };
}

describe('kin atlas build', () => {
  it('describes every folder bottom up, saves entries tied to the content, and records the cost', async () => {
    const dir = await repo();
    const { result, prompts, steps } = await build(dir, [DB, UI, SRC, ROOT]);
    assert.equal(result.status, 'built');
    assert.deepEqual(steps, ['Describing src/db (1 file(s))', 'Describing src/ui (1 file(s))', 'Describing src', 'Describing the repository overview (1 file(s))']);
    // The code of key functions is sent; tests are named, not described; children's entries reach the parent.
    assert.match(prompts[0]!, /Key functions to describe: get/);
    assert.match(prompts[0]!, /if \(id === \\"x\\"\) return 1/);
    assert.match(prompts[0]!, /store\.test\.ts \(a test or generated file: not described\)/);
    assert.match(prompts[2]!, /src\/db: Data access\./);
    assert.match(prompts[3]!, /Write the overview of the repository/);

    const atlas = await readAtlas(workspacePaths(dir));
    assert.equal(atlas.folders['']!.text, 'A small app.\nsrc holds the code.');
    assert.deepEqual(atlas.files['src/db/store.ts']!.functions, { get: 'Looks a record up.' });
    assert.equal(atlas.files['src/db/store.ts']!.hash, (await execa('git', ['hash-object', 'src/db/store.ts'], { cwd: dir })).stdout);
    assert.equal(atlas.files['src/db/store.test.ts'], undefined);

    const spend = (await readState(workspacePaths(dir))).spend;
    assert.deepEqual(spend.map((s) => [s.result, s.source]), [['atlas', 'src/db'], ['atlas', 'src/ui'], ['atlas', 'src'], ['atlas', '.']]);
    const report = await costReport(dir);
    assert.equal(report.atlas.count, 4);
    assert.deepEqual(report.byOrigin, {});

    assert.deepEqual((await build(dir, [])).result, { status: 'up-to-date' });
  });

  it('re-describes only what changed', async () => {
    const dir = await repo();
    await build(dir, [DB, UI, SRC, ROOT]);
    await writeFile(join(dir, 'src/ui/view.ts'), 'export const view = () => 2;\n');
    const { steps } = await build(dir, [UI]);
    assert.deepEqual(steps, ['Describing src/ui (1 file(s))']);
  });

  it('retries with feedback, and moves on when a folder still fails', async () => {
    const dir = await repo();
    const wrong: AtlasOutput = { ...DB, files: [{ ...DB.files[0]!, functions: [{ name: 'fetch', text: 'Fetches.' }] }] };
    const { result, prompts } = await build(dir, [wrong, wrong, UI, SRC, ROOT]);
    assert.match(prompts[1]!, /src\/db\/store\.ts declares no fetch/);
    assert.equal(result.status, 'built');
    if (result.status !== 'built') return;
    assert.deepEqual(result.failed.map((f) => f.folder), ['src/db']);
    assert.equal(result.files, 2);
    assert.equal((await readAtlas(workspacePaths(dir))).files['src/db/store.ts'], undefined);
  });

  it('builds one folder, and refuses a file', async () => {
    const dir = await repo();
    const { steps } = await build(dir, [DB], { path: 'src/db' });
    assert.deepEqual(steps, ['Describing src/db (1 file(s))']);
    await assert.rejects(build(dir, [], { path: 'src/db/store.ts' }), AtlasTargetError);
  });

  it('asks before spending, with the counts and an estimate', async () => {
    const dir = await repo();
    const questions: string[] = [];
    const { result, prompts } = await build(dir, [], { yes: false, confirm: async (m) => (questions.push(m), !m.startsWith('Describe')) });
    assert.deepEqual(result, { status: 'declined', calls: 4 });
    assert.equal(prompts.length, 0);
    assert.match(questions.at(-1)!, /^Describe 4 folder\(s\) and 3 file\(s\) in the repository: 4 call\(s\) to .*, estimated ≈ \$/);
  });
});

describe('planAtlasCalls', () => {
  it('splits a big folder into batches and writes the folder entry with the last', async () => {
    const extra = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`big/f${i}.ts`, `export const f${i} = ${i};\n`]));
    const dir = await repo(extra);
    const skeleton = await buildSkeleton(dir, profiles());
    const calls = planAtlasCalls(emptyAtlas(), skeleton, 'big');
    assert.deepEqual(calls.map((c) => [c.files.length, c.wantFolder]), [[10, false], [2, true]]);
  });
});

describe('checkAtlasOutput', () => {
  it('holds entries to their length limits and the listed files', async () => {
    const dir = await repo();
    const skeleton = await buildSkeleton(dir, profiles());
    const db = skeleton.folders.get('src/db')!;
    const check = (output: AtlasOutput) => checkAtlasOutput(skeleton, db, ['src/db/store.ts'], output);
    assert.deepEqual(check(DB), []);
    assert.deepEqual(check({ ...DB, folder: 'One.\nTwo.' }), ['The entry for the folder src/db has 2 lines; at most 1.']);
    assert.deepEqual(check({ ...DB, files: [] }), ['src/db/store.ts is not described.']);
    assert.deepEqual(check({ ...DB, files: [{ ...DB.files[0]!, functions: [] }] }), ['src/db/store.ts: describe its key function(s) get.']);
    assert.deepEqual(check({ ...DB, files: [...DB.files, { path: 'main.ts', text: 'x', functions: [] }] }), ['main.ts is not one of the files to describe here.']);
    assert.match(check({ ...DB, files: [{ ...DB.files[0]!, text: 'x'.repeat(201) }] })[0]!, /201 characters; at most 200/);
    const root = skeleton.folders.get('')!;
    assert.deepEqual(checkAtlasOutput(skeleton, root, [], { folder: 'a\nb\nc\nd\ne', files: [] }), []);
  });
});
