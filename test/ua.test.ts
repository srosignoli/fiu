import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execa } from 'execa';
import { buildSkeleton } from '../src/atlas/skeleton.ts';
import { firstSentence, foreignState, readForeignAtlas, resolveGraph } from '../src/atlas/ua.ts';
import { profiles } from '../src/languages/registry.ts';
import { tempGitRepo } from './helpers.ts';

const QUEUE = `export class Queue {
  push(job: string): void {
    if (job) this.items.push(job);
  }
  items: string[] = [];
}

export function retryWithBackoff(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(1000 * 2 ** attempt, 30000);
}
`;
const MAIN = `import { Queue } from './queue.ts';
export function main() {
  return new Queue();
}
`;

async function repo(): Promise<{ dir: string; commit: string }> {
  const dir = await tempGitRepo();
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/queue.ts'), QUEUE);
  await writeFile(join(dir, 'src/main.ts'), MAIN);
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return { dir, commit: stdout.trim() };
}

const graph = (commit: string) => ({
  version: '1.0.0',
  project: { name: 'x', description: 'A job queue with retries. It also has a CLI.', gitCommitHash: commit, analyzedAt: '2026-11-01T00:00:00Z' },
  nodes: [
    { id: 'file:src/queue.ts', type: 'file', name: 'queue.ts', filePath: 'src/queue.ts', summary: 'Holds pending jobs and decides when failed ones come back.  More detail here.', tags: ['queue', 'retries'], complexity: 'moderate' },
    { id: 'file:src/main.ts', type: 'file', name: 'main.ts', filePath: './src/main.ts', summary: 'Entry point.', tags: ['cli'] },
    { id: 'function:src/queue.ts:retryWithBackoff', type: 'function', name: 'retryWithBackoff', filePath: 'src/queue.ts', summary: 'Delay before the next attempt, doubling each time.', tags: [] },
    { id: 'function:src/queue.ts:push', type: 'function', name: 'push', filePath: 'src/queue.ts', summary: 'Adds a job.', tags: [] },
    { id: 'function:src/queue.ts:ghost', type: 'function', name: 'ghost', filePath: 'src/queue.ts', summary: 'Does not exist.', tags: [] },
    { id: 'config:package.json', type: 'config', name: 'package.json', filePath: 'package.json', summary: 'Config.', tags: [] },
    { id: 'concept:retries', type: 'concept', name: 'Retries', summary: 'Retries.', tags: [] },
    { id: 42 },
  ],
  edges: [{ source: 'file:src/main.ts', target: 'file:src/queue.ts', type: 'calls', direction: 'forward', weight: 0.8 }],
  layers: [
    { id: 'layer:core', name: 'Core', description: 'The queue itself.', nodeIds: ['file:src/queue.ts'] },
    { id: 'layer:cli', name: 'CLI', description: 'Command line.', nodeIds: ['file:src/main.ts', 'file:src/missing.ts'] },
  ],
  tour: [
    { order: 2, title: 'The queue', description: '…', nodeIds: ['file:src/queue.ts', 'function:src/queue.ts:retryWithBackoff'] },
    { order: 1, title: 'Start here', description: '…', nodeIds: ['file:src/main.ts'] },
    { order: 3, title: 'Docs', description: '…', nodeIds: ['document:README.md'] },
  ],
});

describe('readForeignAtlas', () => {
  it('is absent when no graph exists', async () => {
    const { dir } = await repo();
    assert.deepEqual(await readForeignAtlas(dir, await buildSkeleton(dir, profiles())), { status: 'absent' });
  });

  it('reads .ua and resolves everything against the skeleton', async () => {
    const { dir, commit } = await repo();
    await mkdir(join(dir, '.ua'));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph(commit)));
    const skeleton = await buildSkeleton(dir, profiles());
    const result = await readForeignAtlas(dir, skeleton);
    assert.equal(result.status, 'read');
    if (result.status !== 'read') return;
    const { atlas } = result;
    assert.equal(atlas.dir, '.ua');
    assert.equal(atlas.commit, commit);
    assert.equal(atlas.overview, 'A job queue with retries.');
    assert.equal(result.warning, undefined);

    const queue = atlas.files.get('src/queue.ts')!;
    assert.equal(queue.text, 'Holds pending jobs and decides when failed ones come back.');
    assert.deepEqual(queue.tags, ['queue', 'retries']);
    assert.equal(queue.layer, 'Core');
    // `push` resolves to the skeleton's `Queue.push`; `ghost` doesn't exist and is dropped.
    assert.deepEqual(queue.functions, { 'Queue.push': 'Adds a job.', retryWithBackoff: 'Delay before the next attempt, doubling each time.' });
    assert.equal(atlas.files.get('src/main.ts')?.text, 'Entry point.');
    assert.equal(atlas.files.has('package.json'), false);

    assert.deepEqual(atlas.layers, [
      { name: 'Core', description: 'The queue itself.', files: ['src/queue.ts'] },
      { name: 'CLI', description: 'Command line.', files: ['src/main.ts'] },
    ]);
    assert.deepEqual(atlas.tour, [
      { order: 1, title: 'Start here', files: ['src/main.ts'] },
      { order: 2, title: 'The queue', files: ['src/queue.ts'] },
    ]);
    // Code nodes: two files and three functions; `ghost` doesn't resolve; the bad node is skipped.
    assert.deepEqual(atlas.counts, { codeNodes: 5, matched: 4, skipped: 1 });

    assert.equal(foreignState(queue, skeleton.files.get('src/queue.ts')!), 'current');
    await writeFile(join(dir, 'src/queue.ts'), QUEUE + '\n// changed\n');
    const changed = await buildSkeleton(dir, profiles());
    assert.equal(foreignState(queue, changed.files.get('src/queue.ts')!), 'stale');
    assert.equal(foreignState(undefined, changed.files.get('src/queue.ts')!), 'missing');
  });

  it('prefers the legacy .understand-anything directory, as UA does', async () => {
    const { dir, commit } = await repo();
    await mkdir(join(dir, '.ua'));
    await mkdir(join(dir, '.understand-anything'));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph(commit)));
    await writeFile(join(dir, '.understand-anything/knowledge-graph.json'), JSON.stringify({ ...graph(commit), project: { description: 'Legacy.' } }));
    const result = await readForeignAtlas(dir, await buildSkeleton(dir, profiles()));
    assert.equal(result.status === 'read' && result.atlas.dir, '.understand-anything');
    assert.equal(result.status === 'read' && result.atlas.overview, 'Legacy.');
  });

  it('marks every entry stale when the analysed commit is not in this clone', async () => {
    const { dir } = await repo();
    await mkdir(join(dir, '.ua'));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph('0123456789abcdef0123456789abcdef01234567')));
    const skeleton = await buildSkeleton(dir, profiles());
    const result = await readForeignAtlas(dir, skeleton);
    assert.equal(result.status, 'read');
    if (result.status !== 'read') return;
    const queue = result.atlas.files.get('src/queue.ts')!;
    assert.equal(queue.hash, undefined);
    assert.equal(foreignState(queue, skeleton.files.get('src/queue.ts')!), 'stale');
  });

  it('reports an unreadable graph instead of failing', async () => {
    const { dir } = await repo();
    await mkdir(join(dir, '.ua'));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), '{ not json');
    const skeleton = await buildSkeleton(dir, profiles());
    assert.deepEqual(await readForeignAtlas(dir, skeleton), { status: 'unreadable', dir: '.ua', reason: 'not valid JSON' });
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify({ graph: { nodes: [] } }));
    assert.deepEqual(await readForeignAtlas(dir, skeleton), { status: 'unreadable', dir: '.ua', reason: 'no nodes list' });
  });
});

describe('resolveGraph', () => {
  it('survives fields of the wrong shape, keeping what it can read', async () => {
    const { dir } = await repo();
    const skeleton = await buildSkeleton(dir, profiles());
    const result = resolveGraph(
      { project: undefined, nodes: [{ id: 'file:src/queue.ts', summary: 'Queue.' }, 'nonsense'], layers: undefined, tour: undefined },
      { dir: '.ua', skeleton },
    );
    assert.equal(result.status, 'read');
    if (result.status !== 'read') return;
    // No `type`: the ID's prefix says it is a file.
    assert.equal(result.atlas.files.get('src/queue.ts')?.text, 'Queue.');
    assert.deepEqual(result.atlas.counts, { codeNodes: 1, matched: 1, skipped: 1 });
  });

  it('warns when few code nodes resolve: the format may have changed', async () => {
    const { dir } = await repo();
    const skeleton = await buildSkeleton(dir, profiles());
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `fn::src/queue.ts::f${i}`, type: 'function', summary: 'x' }));
    const result = resolveGraph({ nodes: [...nodes, { id: 'file:src/queue.ts', type: 'file', summary: 'Q.' }] }, { dir: '.ua', skeleton });
    assert.equal(result.status, 'read');
    assert.match(result.status === 'read' ? (result.warning ?? '') : '', /only 1 of 13 .* format may have changed/);
  });
});

describe('firstSentence', () => {
  it('cuts an overlong sentence at its last clause that fits, outside brackets', () => {
    const long = `Implements the install command: writes the stamped skill (and its slash commands, the end-of-task block) at user or project scope, registers the MCP server with the agent, and records what it wrote so that uninstall can remove exactly that.`;
    assert.equal(firstSentence(long), 'Implements the install command: writes the stamped skill (and its slash commands, the end-of-task block) at user or project scope, registers the MCP server with the agent…');
  });

  it('keeps the first sentence, on one line, within 200 characters', () => {
    assert.equal(firstSentence('Does a thing.\nThen more. And more.'), 'Does a thing.');
    assert.equal(firstSentence('Handles v1.2 configs without a full stop'), 'Handles v1.2 configs without a full stop');
    assert.equal(firstSentence('   '), undefined);
    const long = firstSentence(`${'word '.repeat(60)}end.`)!;
    assert.ok(long.length <= 200 && long.endsWith('…'));
  });
});

describe('the Atlas overlay', async () => {
  const { overlayAtlas, readAtlasOverlay, uaNotice } = await import('../src/atlas/overlay.ts');
  const { emptyAtlas, readAtlas, writeAtlas } = await import('../src/atlas/store.ts');
  const { ensureWorkspace, workspacePaths } = await import('../src/workspace.ts');
  const { searchAtlasCommand, atlasView } = await import('../src/commands/atlas.ts');
  const { renderAtlasText } = await import('../src/atlas/render.ts');
  const { buildMap } = await import('../src/map/map.ts');
  const { renderMap } = await import('../src/map/render.ts');
  const { tempDir } = await import('./helpers.ts');

  async function withGraph() {
    const { dir, commit } = await repo();
    const paths = workspacePaths(dir);
    await ensureWorkspace(paths);
    await mkdir(join(dir, '.ua'));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph(commit)));
    return { dir, commit, paths, skeleton: await buildSkeleton(dir, profiles()) };
  }

  it("keeps Fiu's current entries and fills in where Fiu has none or a stale one", async () => {
    const { skeleton, dir } = await withGraph();
    const read = await readForeignAtlas(dir, skeleton);
    assert.equal(read.status, 'read');
    if (read.status !== 'read') return;
    const own = emptyAtlas();
    own.files['src/main.ts'] = { hash: skeleton.files.get('src/main.ts')!.hash, text: "Fiu's own.", writtenAt: '', functions: {} };
    own.files['src/queue.ts'] = { hash: 'old', text: 'Stale Fiu entry.', writtenAt: '', functions: {} };
    const { atlas, extras } = overlayAtlas(own, read.atlas, skeleton);
    assert.equal(atlas.files['src/main.ts']?.text, "Fiu's own.");
    assert.equal(atlas.files['src/main.ts']?.source, undefined);
    // Fiu's is stale, UA's current: UA's, with its functions.
    assert.equal(atlas.files['src/queue.ts']?.text, 'Holds pending jobs and decides when failed ones come back.');
    assert.equal(atlas.files['src/queue.ts']?.source, 'understand-anything');
    assert.equal(atlas.files['src/queue.ts']?.functions.retryWithBackoff, 'Delay before the next attempt, doubling each time.');
    assert.equal(atlas.folders['']?.text, 'A job queue with retries.');
    assert.deepEqual(extras.get('src/queue.ts'), { tags: ['queue', 'retries'], layer: 'Core' });

    // Both stale: Fiu's stays.
    const stale = { ...read.atlas, files: new Map([...read.atlas.files].map(([p, f]) => [p, { ...f, hash: 'older' }])) };
    assert.equal(overlayAtlas(own, stale, skeleton).atlas.files['src/queue.ts']?.text, 'Stale Fiu entry.');
  });

  it("never saves UA's entries to .fiu/atlas.json", async () => {
    const { paths, skeleton } = await withGraph();
    const { atlas } = await readAtlasOverlay(paths, skeleton);
    assert.equal(atlas.files['src/queue.ts']?.source, 'understand-anything');
    atlas.files['src/main.ts'] = { hash: 'h', text: 'Written by Fiu.', writtenAt: '', functions: {} };
    await writeAtlas(paths, atlas);
    const saved = await readAtlas(paths);
    assert.deepEqual(Object.keys(saved.files), ['src/main.ts']);
    assert.deepEqual(saved.folders, {});
  });

  it('says it is in use, how far behind it is, and how to turn it off; and is off when the config says so', async () => {
    const { dir, commit, paths, skeleton } = await withGraph();
    await writeFile(join(dir, 'src/extra.ts'), 'export const x = 1;\n');
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'more'], { cwd: dir });
    const overlay = await readAtlasOverlay(paths, skeleton);
    assert.equal(uaNotice(overlay.ua), `Also using Understand-Anything's graph (.ua/, commit ${commit.slice(0, 7)}, 1 commit behind): entries marked (UA) are its model's word, not Verified. Turn it off with "understandAnything": false in .fiu/config.json.`);

    await writeFile(paths.configFile, JSON.stringify({ understandAnything: false }));
    const off = await readAtlasOverlay(paths, skeleton);
    assert.deepEqual(off.ua, { status: 'off' });
    assert.deepEqual(off.atlas, emptyAtlas());
    assert.equal(uaNotice(off.ua), undefined);
  });

  it('feeds search (tags and layers included), fiu atlas, and fiu map, marked as UA', async () => {
    const { dir } = await withGraph();
    const configEnv = { env: {}, home: await tempDir() };
    // "retries" is only a UA tag on queue.ts, and in the entry of retryWithBackoff.
    const search = await searchAtlasCommand(dir, 'core', { configEnv });
    assert.equal(search.results[0]?.path, 'src/queue.ts');
    assert.equal(search.results[0]?.source, 'understand-anything');
    assert.match(search.notice ?? '', /Also using Understand-Anything's graph/);

    const text = renderAtlasText(await atlasView(dir, undefined, { configEnv }), { color: false });
    assert.match(text, /A job queue with retries\. \(UA\)/);
    assert.match(text, /queue\.ts {2}Holds pending jobs and decides when failed ones come back\. \(UA\)/);
    assert.match(text, /entries marked \(UA\)/);

    const map = renderMap(await buildMap(dir, '', { configEnv }), { color: false });
    assert.match(map, /A job queue with retries\. \(UA\)/);
    assert.match(map, /Also using Understand-Anything's graph/);
  });
});

describe('prepare_atlas with Understand-Anything', async () => {
  const { prepareAtlas } = await import('../src/atlas/agent.ts');
  const { ensureWorkspace, workspacePaths } = await import('../src/workspace.ts');
  it('leaves out files whose UA entry is current', async () => {
    const { dir, commit } = await repo();
    const paths = workspacePaths(dir);
    await ensureWorkspace(paths);
    await mkdir(join(dir, '.ua'));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify(graph(commit)));
    const prepared = await prepareAtlas(dir, paths, profiles(), undefined);
    assert.equal(prepared.status, 'ready');
    assert.deepEqual(prepared.status === 'ready' && [prepared.folder, prepared.files], ['src', []]);
  });
});

describe("Understand-Anything's flows", async () => {
  const { readFile: read } = await import('node:fs/promises');
  const { flowsThrough, resolveFlows } = await import('../src/atlas/ua.ts');
  const FIXTURE = join(import.meta.dirname, 'fixtures/ua/refill-domain-graph.json');

  /** A repository holding the files the fixture's steps run in, with UA's graphs analysed at its commit. */
  async function refillRepo() {
    const dir = await tempGitRepo();
    for (const path of ['src/background/refill.ts', 'src/background/commits.ts', 'src/synthesis/generate.ts', 'src/background/log.ts']) {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), `export function f() {\n  return '${path}';\n}\n`);
    }
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
    const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const domain = JSON.parse(await read(FIXTURE, 'utf8'));
    domain.project.gitCommitHash = commit;
    await mkdir(join(dir, '.ua'));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify({ project: { gitCommitHash: commit }, nodes: [] }));
    await writeFile(join(dir, '.ua/domain-graph.json'), JSON.stringify(domain));
    return dir;
  }

  it('reads a real domain graph: steps in order, with their domain, entry point, files and lines', async () => {
    const dir = await refillRepo();
    const result = await readForeignAtlas(dir, await buildSkeleton(dir, profiles()));
    assert.equal(result.status, 'read');
    if (result.status !== 'read') return;
    assert.equal(result.atlas.flows.length, 1);
    const [flow] = result.atlas.flows;
    assert.equal(flow!.name, 'Refill the Queue from a Commit');
    assert.equal(flow!.domain, 'Background Generation');
    assert.match(flow!.entry ?? '', /fiu refill --background/);
    assert.deepEqual(
      flow!.steps.map((s) => [s.name, s.path, s.lineRange?.[0], s.current]),
      [
        ['Expire stale Workouts', 'src/background/refill.ts', 270, true],
        ['Acquire the repository lock', 'src/background/refill.ts', 301, true],
        ['Read and screen the commit', 'src/background/commits.ts', 22, true],
        ['Choose the target file', 'src/background/commits.ts', 66, true],
        ['Enforce queue and daily caps', 'src/background/refill.ts', 264, true],
        ['Generate a Quick Workout', 'src/synthesis/generate.ts', 59, true],
        ['Log the outcome', 'src/background/log.ts', 23, true],
      ],
    );

    // The domain's rules, each with the files of the domain's flows.
    assert.equal(result.atlas.rules.length, 7);
    assert.deepEqual(result.atlas.rules.find((r) => r.text.startsWith('Background Workouts')), {
      text: 'Background Workouts that sit in the queue past their expiry are discarded.',
      domain: 'Background Generation',
      files: ['src/background/refill.ts', 'src/background/commits.ts', 'src/synthesis/generate.ts', 'src/background/log.ts'],
    });

    // A step is matched by its lines while the file is as UA read it; once it changes, only by its file.
    assert.deepEqual(flowsThrough(result.atlas.flows, 'src/background/commits.ts', [{ startLine: 66, endLine: 98 }]).map((m) => [m.index, m.where]), [[3, 'code']]);
    assert.deepEqual(flowsThrough(result.atlas.flows, 'src/background/commits.ts', [{ startLine: 1, endLine: 5 }]).map((m) => [m.index, m.where]), [[2, 'file']]);
    assert.deepEqual(flowsThrough(result.atlas.flows, 'src/other.ts', [{ startLine: 1, endLine: 5 }]), []);
    await writeFile(join(dir, 'src/background/commits.ts'), 'export function changed() {}\n');
    const changed = await readForeignAtlas(dir, await buildSkeleton(dir, profiles()));
    const flows = changed.status === 'read' ? changed.atlas.flows : [];
    assert.deepEqual(flowsThrough(flows, 'src/background/commits.ts', [{ startLine: 66, endLine: 98 }]).map((m) => [m.index, m.where]), [[2, 'file']]);
  });

  it('orders tied weights as written, and skips what it cannot read', async () => {
    const dir = await refillRepo();
    const skeleton = await buildSkeleton(dir, profiles());
    const flows = resolveFlows(
      {
        nodes: [
          { id: 'flow:f', type: 'flow', name: 'F' },
          { id: 'step:a', type: 'step', name: 'A', filePath: './src/background/log.ts', lineRange: [9, 3] },
          { id: 'step:b', type: 'step', name: 'B', filePath: 'elsewhere.py' },
          { id: 'step:c', type: 'step', name: 'C' },
          'nonsense',
          { id: 'flow:empty', type: 'flow', name: 'Empty' },
        ],
        edges: [
          { source: 'flow:f', target: 'step:a', type: 'flow_step', weight: 0.1 },
          { source: 'flow:f', target: 'step:c', type: 'flow_step', weight: 0.1 },
          { source: 'flow:f', target: 'step:b', type: 'flow_step', weight: 0.05 },
          { source: 'flow:f', target: 'step:missing', type: 'flow_step', weight: 0.2 },
        ],
      },
      { skeleton },
    );
    assert.deepEqual(flows, [
      {
        name: 'F',
        steps: [
          { name: 'B', current: false },
          // An inverted range is dropped; without hashes, nothing is current.
          { name: 'A', path: 'src/background/log.ts', current: false },
          { name: 'C', current: false },
        ],
      },
    ]);
  });

  it('puts the flow in the Debrief: which step, the steps around it, and the next one to practise', async () => {
    const { buildDebrief, renderDebriefMarkdown, renderDebriefText } = await import('../src/workouts/debrief.ts');
    const { ensureWorkspace, workspacePaths } = await import('../src/workspace.ts');
    const dir = await refillRepo();
    const paths = workspacePaths(dir);
    await ensureWorkspace(paths);
    const lines = Array.from({ length: 280 }, (_, i) => (i === 269 ? 'export async function expireStaleWorkouts() {' : i === 277 ? '}' : ''));
    await writeFile(join(dir, 'src/background/refill.ts'), `${lines.join('\n')}\n`);
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'refill'], { cwd: dir });
    // UA analysed this commit.
    const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const domain = JSON.parse(await read(FIXTURE, 'utf8'));
    domain.project.gitCommitHash = commit;
    await writeFile(join(dir, '.ua/domain-graph.json'), JSON.stringify(domain));
    await writeFile(join(dir, '.ua/knowledge-graph.json'), JSON.stringify({ project: { gitCommitHash: commit }, nodes: [] }));

    const record = {
      id: 'drill_r',
      title: 'Old Workouts never leave',
      source: { path: 'src/background/refill.ts', dirty: false, symbol: 'expireStaleWorkouts' },
      sourceAnchors: [{ path: 'src/background/refill.ts', startLine: 270, endLine: 278, explanation: 'Stale Workouts are discarded here.' }],
    } as unknown as import('../src/workouts/save.ts').WorkoutRecord;
    const debrief = await buildDebrief({ paths, record, sourceChanged: false, profiles: profiles() });
    // The rule the target enforces, located by its words.
    assert.ok(debrief.rules.some((r) => r.text === 'Background Workouts that sit in the queue past their expiry are discarded.'));
    assert.match(renderDebriefText(debrief), /Rules it may enforce:\n {4}"Background Workouts that sit in the queue past their expiry are discarded\." \(Background Generation\) \(UA\)/);
    assert.deepEqual(debrief.flows, [
      {
        name: 'Refill the Queue from a Commit',
        domain: 'Background Generation',
        entry: debrief.flows[0]!.entry,
        step: 1,
        of: 7,
        stepName: 'Expire stale Workouts',
        where: 'code',
        stale: false,
        after: { name: 'Acquire the repository lock', path: 'src/background/refill.ts' },
      },
    ]);
    // The next step in another file: the lock is in this one, so none to suggest from this flow.
    assert.equal(debrief.tryNext.some((t) => t.why.includes('next step')), false);

    const text = renderDebriefText(debrief);
    assert.match(text, /Where it runs:\n {4}This code is step 1 of 7, "Expire stale Workouts", in "Refill the Queue from a Commit" \(Background Generation\) \(UA\)\n {6}starts with: .*fiu refill --background.*\n {6}after: Acquire the repository lock \(src\/background\/refill\.ts\)/);
    assert.match(text, /Flows and rules are Understand-Anything's reading of the code \(marked \(UA\)\), not Verified/);
    assert.match(renderDebriefMarkdown(debrief, record), /## Where it runs\n\n- This code is step 1 of 7/);

    // Turned off: no flows.
    await writeFile(paths.configFile, JSON.stringify({ understandAnything: false }));
    assert.deepEqual((await buildDebrief({ paths, record, sourceChanged: false, profiles: profiles() })).flows, []);
  });

  it('suggests the next step of the flow when it runs in another file', async () => {
    const { buildDebrief } = await import('../src/workouts/debrief.ts');
    const { ensureWorkspace, workspacePaths } = await import('../src/workspace.ts');
    const dir = await refillRepo();
    const paths = workspacePaths(dir);
    await ensureWorkspace(paths);
    // chooseTarget on lines 66-98, as the fixture's step 4 says; UA analysed this commit.
    const lines = Array.from({ length: 100 }, (_, i) => (i === 65 ? 'export async function chooseTarget() {' : i === 97 ? '}' : ''));
    await writeFile(join(dir, 'src/background/commits.ts'), `${lines.join('\n')}\n`);
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'commits'], { cwd: dir });
    const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const domain = JSON.parse(await read(FIXTURE, 'utf8'));
    domain.project.gitCommitHash = commit;
    await writeFile(join(dir, '.ua/domain-graph.json'), JSON.stringify(domain));

    const record = {
      id: 'drill_c',
      title: 'The wrong file gets a Workout',
      source: { path: 'src/background/commits.ts', dirty: false, symbol: 'chooseTarget' },
      sourceAnchors: [{ path: 'src/background/commits.ts', startLine: 66, endLine: 98, explanation: 'The target file is chosen here.' }],
    } as unknown as import('../src/workouts/save.ts').WorkoutRecord;
    const debrief = await buildDebrief({ paths, record, sourceChanged: false, profiles: profiles() });
    assert.deepEqual([debrief.flows[0]?.step, debrief.flows[0]?.where, debrief.flows[0]?.before?.name], [4, 'code', 'Read and screen the commit']);
    assert.ok(debrief.tryNext.some((t) => t.command === 'fiu predict src/background/refill.ts' && t.why === 'it is the next step of "Refill the Queue from a Commit" (UA)'));
  });
});

describe("Understand-Anything's business rules", async () => {
  const { findRule, locateRule } = await import('../src/atlas/rules.ts');
  const { emptyAtlas } = await import('../src/atlas/store.ts');
  const { resolveRules, resolveFlows } = await import('../src/atlas/ua.ts');

  async function rulesRepo() {
    const dir = await tempGitRepo();
    const files: Record<string, string> = {
      'src/queue/cap.ts': 'export const QUEUE_CAP = 3;\n\nexport function roomInQueue(waiting: number): boolean {\n  return waiting < QUEUE_CAP;\n}\n\nexport function describeQueue(waiting: number) {\n  return `${waiting} waiting`;\n}\n',
      'src/queue/expire.ts': 'export function expireStaleWorkouts(ages: number[], days: number) {\n  return ages.filter((age) => age > days);\n}\n',
      'src/other/expiry.ts': 'export function expiredCoupons(ages: number[]) {\n  return ages.filter((age) => age > 30);\n}\n',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    await execa('git', ['add', '.'], { cwd: dir });
    return { dir, skeleton: await buildSkeleton(dir, profiles()) };
  }

  it('reads rules on a domain, a flow, or a step, each with the files where it should hold', async () => {
    const { skeleton } = await rulesRepo();
    const graph = {
      nodes: [
        { id: 'domain:q', type: 'domain', name: 'Queue', domainMeta: { businessRules: ['The queue holds at most 3.'] } },
        { id: 'flow:f', type: 'flow', name: 'Fill', domainMeta: { businessRules: ['Stale ones go first.', '  '] } },
        { id: 'step:a', type: 'step', name: 'Check room', filePath: 'src/queue/cap.ts', domainMeta: { businessRules: ['Never more than the cap.'] } },
        { id: 'step:b', type: 'step', name: 'Expire', filePath: 'src/queue/expire.ts' },
      ],
      edges: [
        { source: 'domain:q', target: 'flow:f', type: 'contains_flow' },
        { source: 'flow:f', target: 'step:a', type: 'flow_step', weight: 0.5 },
        { source: 'flow:f', target: 'step:b', type: 'flow_step', weight: 1 },
      ],
    };
    const flows = resolveFlows(graph, { skeleton });
    assert.deepEqual(resolveRules(graph, flows), [
      { text: 'The queue holds at most 3.', domain: 'Queue', files: ['src/queue/cap.ts', 'src/queue/expire.ts'] },
      { text: 'Stale ones go first.', domain: 'Queue', flow: 'Fill', files: ['src/queue/cap.ts', 'src/queue/expire.ts'] },
      { text: 'Never more than the cap.', domain: 'Queue', flow: 'Fill', files: ['src/queue/cap.ts'] },
    ]);
  });

  it('locates a rule by the names it gives, a constant through the functions using it, else by its words among its files', async () => {
    const { dir, skeleton } = await rulesRepo();
    const locate = (text: string, files: string[] = ['src/queue/cap.ts', 'src/queue/expire.ts']) => locateRule({ text, files }, dir, skeleton, emptyAtlas()).then((ts) => ts.map((t) => `${t.path}#${t.symbol} ${t.evidence}`));
    assert.deepEqual(await locate('The queue holds at most 3 (QUEUE_CAP).'), ['src/queue/cap.ts#roomInQueue names']);
    assert.deepEqual(await locate('Workouts are dropped by expireStaleWorkouts after their expiry.'), ['src/queue/expire.ts#expireStaleWorkouts names']);
    // By words: the coupon expiry outside the rule's files is never proposed.
    assert.deepEqual(await locate('Stale Workouts past their expiry are discarded.'), ['src/queue/expire.ts#expireStaleWorkouts search']);
    // A number alone points nowhere.
    assert.deepEqual(await locate('At most 3.'), []);
    // Go: an exported PascalCase constant in a const block leads to the functions using it.
    await writeFile(join(dir, 'src/queue/trust.go'), 'package queue\n\nconst (\n\tTrustStreak = 10\n\tother       = 1\n)\n\nfunc autoAcceptable(streak int) bool {\n\treturn streak >= TrustStreak\n}\n\nfunc eligible(kind int) bool {\n\treturn kind == 3\n}\n');
    await execa('git', ['add', '.'], { cwd: dir });
    const goSkeleton = await buildSkeleton(dir, profiles());
    assert.deepEqual(
      (await locateRule({ text: 'Links are accepted alone after 10 accepts in a row (TrustStreak).', files: [] }, dir, goSkeleton, emptyAtlas())).map((t) => `${t.symbol} ${t.evidence}`),
      ['autoAcceptable names'],
    );
  });

  it('finds a rule by its words, and lists the rules when the words match none or several', () => {
    const rules = [
      { text: 'The queue holds at most 3.', files: [] },
      { text: 'Stale Workouts expire after 14 days.', files: [] },
      { text: 'Stale entries are shown with a mark.', files: [] },
    ];
    assert.equal(findRule(rules, 'the queue holds at most 3.').text, 'The queue holds at most 3.');
    assert.equal(findRule(rules, 'expire days').text, 'Stale Workouts expire after 14 days.');
    assert.throws(() => findRule(rules, 'stale'), /"stale" matches 2 rules; use more of their words/);
    assert.throws(() => findRule(rules, 'payments'), /No rule matches "payments"/);
  });
});

describe('the rule in the reveal', async () => {
  const { ruleLines } = await import('../src/workouts/save.ts');
  it("shows the rule as written and whether the code follows it, as the model's reading", () => {
    assert.deepEqual(ruleLines({ text: 'Jobs are kept for 7 days.', domain: 'Scheduling', agrees: false, note: 'They are kept for 14.' }), [
      'The rule this was about (Understand-Anything, Scheduling): "Jobs are kept for 7 days."',
      "The code does NOT follow it: They are kept for 14. (as measured; the comparison is the model's reading)",
    ]);
  });
});

describe('when a rule check goes out of date', async () => {
  const { changedSinceCheck } = await import('../src/workouts/rulechecks.ts');
  it('compares the measured function, else the file, with the code at the checked commit', async () => {
    const dir = await tempGitRepo();
    await mkdir(join(dir, 'src'));
    const code = 'export function cap(n: number) {\n  return Math.min(n, 3);\n}\n\nexport function other() {\n  return 1;\n}\n';
    await writeFile(join(dir, 'src/cap.ts'), code);
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'cap'], { cwd: dir });
    const commit = (await execa('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const check = (symbol?: string) => changedSinceCheck(dir, 'src/cap.ts', symbol, commit, profiles());

    assert.equal(await check('cap'), undefined);
    await writeFile(join(dir, 'src/cap.ts'), code.replace('return 1;', 'return 2;'));
    assert.equal(await check('cap'), undefined, 'another function changing leaves it standing');
    await writeFile(join(dir, 'src/cap.ts'), code.replace('3', '5'));
    assert.equal(await check('cap'), 'cap changed');
    await writeFile(join(dir, 'src/cap.ts'), 'export function other() {\n  return 1;\n}\n');
    assert.equal(await check('cap'), 'cap is gone');
    // No function: the file must change by 20 lines or more.
    assert.equal(await check(), undefined);
    await writeFile(join(dir, 'src/cap.ts'), Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
    assert.match((await check()) ?? '', /^src\/cap\.ts changed by \d+ lines$/);
    // Checked with uncommitted changes: nothing to compare with.
    assert.equal(await changedSinceCheck(dir, 'src/cap.ts', 'cap', undefined, profiles()), undefined);
    await (await import('node:fs/promises')).rm(join(dir, 'src/cap.ts'));
    assert.equal(await check('cap'), 'its file is gone');
  });
});

describe('a graph of a codebase partly in languages Fiu does not read', () => {
  it('does not warn of a format change for entries in those languages', async () => {
    const dir = await tempGitRepo();
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/tool.py'), 'def run():\n    return 1\n');
    await execa('git', ['add', '.'], { cwd: dir });
    const skeleton = await buildSkeleton(dir, profiles());
    const rust = Array.from({ length: 20 }, (_, i) => ({ id: `function:crates/core/src/m${i}.rs:f${i}`, type: 'function', filePath: `crates/core/src/m${i}.rs`, summary: 'x' }));
    const result = resolveGraph({ nodes: [...rust, { id: 'file:src/tool.py', type: 'file', filePath: 'src/tool.py', summary: 'Runs.' }] }, { dir: '.ua', skeleton });
    assert.equal(result.status, 'read');
    if (result.status !== 'read') return;
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.atlas.counts, { codeNodes: 1, matched: 1, skipped: 0 });
  });
});

describe('a struct and a method sharing a name', () => {
  it('gives each its own description', async () => {
    const dir = await tempGitRepo();
    await mkdir(join(dir, 'w'));
    await writeFile(join(dir, 'w/snap.go'), 'package w\n\ntype ItemHistory struct {\n\tID string\n}\n\nfunc (e *Engine) ItemHistory(id string) ItemHistory {\n\treturn ItemHistory{ID: id}\n}\n');
    await execa('git', ['add', '.'], { cwd: dir });
    const skeleton = await buildSkeleton(dir, profiles());
    const result = resolveGraph(
      {
        nodes: [
          { id: 'class:w/snap.go:ItemHistory', type: 'class', name: 'ItemHistory', filePath: 'w/snap.go', summary: 'An item and its versions.' },
          { id: 'function:w/snap.go:ItemHistory', type: 'function', name: 'ItemHistory', filePath: 'w/snap.go', summary: 'Lists the versions of an item.' },
        ],
      },
      { dir: '.ua', skeleton },
    );
    assert.equal(result.status, 'read');
    assert.deepEqual(result.status === 'read' && result.atlas.files.get('w/snap.go')?.functions, { ItemHistory: 'An item and its versions.', 'Engine.ItemHistory': 'Lists the versions of an item.' });
  });
});
