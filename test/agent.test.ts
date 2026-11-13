import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execa } from 'execa';
import { AgentDrills } from '../src/agent/drills.ts';
import { installClaude, TrackedFileError, uninstallClaude, type ClaudeInstallOptions } from '../src/agent/install.ts';
import { createMcpServer } from '../src/agent/mcp.ts';
import { costReport } from '../src/commands/cost.ts';
import { openSandbox, SandboxUnavailableError } from '../src/sandbox/sandbox.ts';
import type { AnyWorkoutOutput } from '../src/synthesis/schema.ts';
import type { WorkoutRecord } from '../src/workouts/save.ts';
import { workspacePaths } from '../src/workspace.ts';
import { tempDir, tempGitRepo, writeUaFlows } from './helpers.ts';
import { goodDrill, goodKata, goodPrediction, TS_REFERENCE } from './mock-model.ts';
import { goodDiagnosis, goodSeries, goodWhatIf, tieQuestion, TS_BEFORE_COMMIT, urgentQuestion } from './mock-model.ts';

const sandboxWorks = await openSandbox().then(
  async (s) => (await s.dispose(), true),
  (error) => {
    if (error instanceof SandboxUnavailableError) return false;
    throw error;
  },
);

async function repoWithSources(...names: string[]): Promise<string> {
  const repo = await tempGitRepo();
  await mkdir(join(repo, 'src'));
  for (const name of names) await writeFile(join(repo, 'src', name), TS_REFERENCE);
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

/** An MCP client talking to Fiu's server in-process, as a coding agent would. */
async function connect(repo: string, home?: string) {
  home ??= await tempDir();
  const drills = new AgentDrills({ cwd: repo, cacheRoot: await tempDir(), configEnv: { env: {}, home } });
  const server = createMcpServer(drills, { version: '1.2.0', home });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-agent', version: '0' });
  await client.connect(clientTransport);
  after(async () => {
    await client.close();
    await drills.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]!.text;
    return { isError: result.isError ?? false, text, json: result.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe('the Atlas in agent mode', () => {
  const entries = (folder: string, files: { path: string; text: string; functions: { name: string; text: string }[] }[] = []) => ({ folder, files });

  it('hands out folders deepest first, checks each submission, and reports what remains', async () => {
    const repo = await repoWithSources('queue.ts');
    const { call } = await connect(repo);
    const first = (await call('prepare_atlas')).json;
    assert.equal(first.status, 'ready');
    assert.equal(first.folder, 'src');
    assert.deepEqual(first.pending, ['src', '']);
    assert.deepEqual(first.files, ['src/queue.ts']);
    assert.match(first.rules, /You write the Atlas of a codebase/);
    assert.match(first.prompt, /Key functions to describe: pickNext/);

    const wrong = await call('submit_atlas', { folder: 'src', entries: entries('The job queue.', [{ path: 'src/queue.ts', text: 'Picks jobs.', functions: [] }]), scope: '' });
    assert.equal(wrong.json.status, 'rejected');
    assert.match(wrong.json.feedback, /describe its key function\(s\) pickNext/);

    const saved = await call('submit_atlas', {
      folder: 'src',
      entries: entries('The job queue.', [{ path: 'src/queue.ts', text: 'Picks jobs.', functions: [{ name: 'pickNext', text: 'Chooses the next job.' }] }]),
      scope: '',
    });
    assert.deepEqual(saved.json, { status: 'saved', folder: 'src', pending: [''] });
    const root = (await call('prepare_atlas')).json;
    assert.equal(root.folder, '');
    assert.match(root.prompt, /- src: The job queue\./);
    assert.deepEqual((await call('submit_atlas', { folder: '', entries: entries('A job scheduler.\nsrc holds it.'), scope: '' })).json.pending, []);
    assert.deepEqual((await call('prepare_atlas')).json, { status: 'up-to-date', scope: '' });

    const atlas = await readJson(join(repo, '.fiu', 'atlas.json'));
    assert.equal(atlas.files['src/queue.ts'].functions.pickNext, 'Chooses the next job.');
  });

  it('searches the Atlas for what the user wants to learn', async () => {
    const repo = await repoWithSources('queue.ts');
    const { call } = await connect(repo);
    await call('submit_atlas', { folder: 'src', entries: entries('The job queue.', [{ path: 'src/queue.ts', text: 'Picks jobs.', functions: [{ name: 'pickNext', text: 'Chooses which waiting job runs next.' }] }]) });
    const { json } = await call('search_atlas', { goal: 'which job runs next' });
    assert.equal(json.described, true);
    assert.deepEqual(json.results[0], { target: 'src/queue.ts#pickNext', atlas: 'Chooses which waiting job runs next.', practice: 'never practised' });
  });

  it('refuses a folder outside the repository, or a file', async () => {
    const { call } = await connect(await repoWithSources('queue.ts'));
    assert.match((await call('prepare_atlas', { dir: 'src/queue.ts' })).text, /is a file/);
    assert.match((await call('prepare_atlas', { dir: '../elsewhere' })).text, /outside the repository/);
  });
});

describe('fiu mcp', () => {
  it('offers its tools and the rules for using them', async () => {
    const { client } = await connect(await repoWithSources('queue.ts'));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['finish_track', 'list_workouts', 'prepare_atlas', 'prepare_drill', 'prepare_track', 'search_atlas', 'submit_atlas', 'submit_drill']);
    assert.match(client.getInstructions() ?? '', /^Fiu turns code in this repository into Drills/);
    // The submit schema is the Workout schema itself (or a Series), so the client checks the shape.
    const submit = tools.find((t) => t.name === 'submit_drill')!;
    const workout = (submit.inputSchema.properties as Record<string, { anyOf?: { properties?: Record<string, unknown> }[] }>).workout!;
    assert.ok(workout.anyOf?.[0]?.properties?.startingCode);
    assert.ok(workout.anyOf?.[1]?.properties?.questions);
  });

  it('prepares a Drill with the same prompt and numbered source as API mode', async () => {
    const repo = await repoWithSources('queue.ts');
    const { call } = await connect(repo);
    const { json } = await call('prepare_drill', { target: 'src/queue.ts#pickNext' });
    assert.equal(json.target, 'src/queue.ts');
    assert.equal(json.language, 'typescript');
    assert.equal(json.maxSubmissions, 3);
    assert.match(json.instructions, /named kata\.ts and the test file kata\.test\.ts/);
    assert.match(json.source, /Build the Drill around `pickNext`/);
    assert.match(json.source, / {4}1 \| export interface Job/);
    assert.equal(json.workoutSchema.type, 'object');
    assert.equal(json.notice, undefined);
  });

  it('refuses targets outside the repository or inside the workspace, as tool errors', async () => {
    const repo = await repoWithSources('queue.ts');
    const { call } = await connect(repo);
    const outside = join(await tempDir(), 'x.ts');
    await writeFile(outside, '');
    assert.match((await call('prepare_drill', { target: outside })).text, /outside the repository/);
    await mkdir(join(repo, '.fiu', 'workouts', 'w'), { recursive: true });
    await writeFile(join(repo, '.fiu', 'workouts', 'w', 'kata.ts'), '');
    assert.match((await call('prepare_drill', { target: '.fiu/workouts/w/kata.ts' })).text, /not a Workout/);
    assert.equal((await call('prepare_drill', { target: 'nope.ts' })).isError, true);
    assert.match((await call('submit_drill', { generationId: 'made-up', workout: goodDrill() })).text, /Unknown generation id/);
  });

  it('warns when the installed skill is older than Fiu', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.claude', 'skills', 'fiu'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'fiu', 'SKILL.md'), '<!-- fiu-version: 1.1.9 -->');
    const { call } = await connect(await repoWithSources('queue.ts'), home);
    const { json } = await call('prepare_drill', { target: 'src/queue.ts' });
    assert.match(json.notice, /from version 1\.1\.9; Fiu is now 1\.2\.0\. Tell the user to run `fiu agent install claude` again\./);
  });
});

describe(`fiu mcp submissions (${sandboxWorks ? 'sandboxed' : 'skipped: no sandbox'})`, { skip: !sandboxWorks }, () => {
  async function prepareAndSubmit(call: Awaited<ReturnType<typeof connect>>['call'], target: string, workouts: AnyWorkoutOutput[], extra = {}) {
    const { json: prepared } = await call('prepare_drill', { target, ...extra });
    const results = [];
    for (const workout of workouts) results.push(await call('submit_drill', { generationId: prepared.generationId, workout }));
    return results;
  }

  it('verifies and saves a Drill the agent wrote, recording it as agent-generated', async () => {
    const repo = await repoWithSources('queue.ts');
    const { call } = await connect(repo);
    const [result] = await prepareAndSubmit(call, 'src/queue.ts', [goodDrill()]);
    assert.equal(result!.json.status, 'saved', result!.text);
    assert.match(result!.json.next, /^The user starts it with: fiu train drill_\d{8}_tie-breaker$/);

    const record: WorkoutRecord = await readJson(join(result!.json.workoutDir, 'workout.json'));
    assert.equal(record.generator, 'agent');
    assert.equal(record.origin, 'manual');
    assert.equal(record.cost, undefined);
    assert.match(await readFile(join(result!.json.workoutDir, 'README.md'), 'utf8'), /Generated by your coding agent \(cost not measured/);

    const [entry] = (await readJson(join(repo, '.fiu', 'state.json'))).spend;
    assert.equal(entry.generator, 'agent');
    assert.equal(entry.cost, null);
    assert.deepEqual((await costReport(repo)).byAgent, { requests: 1, workouts: 1 });
    assert.equal((await call('list_workouts')).json.workouts[0].generator, 'agent');
    assert.equal((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
  });

  it('returns the gate feedback for the agent to fix, up to three submissions', async () => {
    const repo = await repoWithSources('queue.ts');
    const { call } = await connect(repo);
    const noBug = goodDrill({ startingCode: TS_REFERENCE });
    const results = await prepareAndSubmit(call, 'src/queue.ts', [noBug, goodDrill({ hints: ['only one'] }), noBug, goodDrill()]);
    assert.deepEqual(
      results.slice(0, 3).map((r) => [r.json.status, r.json.submissionsLeft]),
      [
        ['rejected', 2],
        ['rejected', 1],
        ['rejected', 0],
      ],
    );
    assert.match(results[0]!.json.feedback, /\[minimal-diff\] The Starting Code is identical/);
    assert.match(results[1]!.json.feedback, /\[schema\] hints must contain exactly 2/);
    assert.match(results[3]!.text, /Unknown generation id/, 'a fourth submission must start over');
    const [entry] = (await readJson(join(repo, '.fiu', 'state.json'))).spend;
    assert.deepEqual([entry.result, entry.generationAttempts, entry.cost], ['not-verified', 3, null]);
  });

  it('enforces Quick rules when asked for a Quick Drill', async () => {
    const { call } = await connect(await repoWithSources('queue.ts'));
    const { json: prepared } = await call('prepare_drill', { target: 'src/queue.ts', quick: true });
    assert.match(prepared.instructions, /This is a Quick Drill/);
    const { json } = await call('submit_drill', { generationId: prepared.generationId, workout: goodDrill({ estimatedMinutes: 9 }) });
    assert.match(json.feedback, /\[schema\] a Quick Drill takes at most 5 minutes, not 9\./);
  });

  it('verifies and saves a Kata when asked for one', async () => {
    const { call } = await connect(await repoWithSources('queue.ts'));
    const { json: prepared } = await call('prepare_drill', { target: 'src/queue.ts', kind: 'kata' });
    assert.equal(prepared.kind, 'kata');
    assert.match(prepared.instructions, /You create Katas/);
    assert.ok(prepared.workoutSchema.properties.gapSummary, 'the schema asks for a gapSummary');
    assert.equal(prepared.workoutSchema.properties.regressionTestName, undefined);

    const leaky = goodKata({ hints: ['Keep the best job.', 'Start with let best: Job | undefined;'] });
    const { json: rejected } = await call('submit_drill', { generationId: prepared.generationId, workout: leaky });
    assert.match(rejected.feedback, /\[schema\] the brief or hints contain the missing code verbatim/);
    const { json: saved } = await call('submit_drill', { generationId: prepared.generationId, workout: goodKata() });
    assert.equal(saved.status, 'saved', JSON.stringify(saved));
    assert.match(saved.workoutId, /^kata_\d{8}_pick-next$/);
    assert.equal((await readJson(join(saved.workoutDir, 'workout.json'))).kind, 'kata');
  });

  it('verifies and saves a Prediction when asked for one', async () => {
    const { call } = await connect(await repoWithSources('queue.ts'));
    const { json: prepared } = await call('prepare_drill', { target: 'src/queue.ts', kind: 'prediction', quick: true });
    assert.equal(prepared.kind, 'prediction');
    assert.equal(prepared.quick, false, 'Predictions are Quick by their own rules');
    assert.match(prepared.instructions, /You create Predictions/);
    assert.ok(prepared.workoutSchema.properties.options, 'the schema asks for options');
    assert.equal(prepared.workoutSchema.properties.startingCode, undefined);

    const leaky = goodPrediction({ scenario: 'What does pickNext return for three jobs?' });
    const { json: rejected } = await call('submit_drill', { generationId: prepared.generationId, workout: leaky });
    assert.match(rejected.feedback, /\[schema\] the scenario uses names from the code \(pickNext\)/);
    const { json: saved } = await call('submit_drill', { generationId: prepared.generationId, workout: goodPrediction() });
    assert.equal(saved.status, 'saved', JSON.stringify(saved));
    assert.match(saved.workoutId, /^prediction_\d{8}_tied-priorities$/);
    assert.equal((await readJson(join(saved.workoutDir, 'workout.json'))).prediction.options.length, 4);
  });

  it('keeps the questions of a Series that Verify, and saves them together', async () => {
    const repo = await repoWithSources('queue.ts');
    const { call } = await connect(repo);
    const { json: prepared } = await call('prepare_drill', { target: 'src/queue.ts', kind: 'prediction', questions: 2 });
    assert.match(prepared.instructions, /This is a Series: 2 Predictions/);
    assert.ok(prepared.workoutSchema.properties.questions, 'the schema asks for questions');

    const first = await call('submit_drill', { generationId: prepared.generationId, workout: goodSeries([tieQuestion(), tieQuestion({ slug: 'again', title: 'Again' })]) });
    assert.equal(first.isError, false, first.text);
    assert.equal(first.json.status, 'rejected');
    assert.equal(first.json.savedQuestions, 1);
    assert.match(first.json.feedback, /Question 2 \("Again"\):\n\[schema\] it asks the same Scenario as question 1/);

    const { json: saved } = await call('submit_drill', { generationId: prepared.generationId, workout: goodSeries([urgentQuestion()]) });
    assert.equal(saved.status, 'saved', JSON.stringify(saved));
    assert.deepEqual(saved.series.requested, 2);
    assert.equal(saved.series.workoutIds.length, 2);
    const second = await readJson(join(repo, '.fiu', 'workouts', saved.series.workoutIds[1], 'workout.json'));
    assert.deepEqual(second.series, { id: saved.series.id, index: 2, of: 2 });
    assert.equal(second.generator, 'agent');
  });

  it('verifies and saves a Diagnosis when asked for one', async () => {
    const { call } = await connect(await repoWithSources('queue.ts'));
    const { json: prepared } = await call('prepare_drill', { target: 'src/queue.ts', kind: 'diagnosis' });
    assert.equal(prepared.kind, 'diagnosis');
    assert.match(prepared.instructions, /You create Diagnoses/);
    assert.ok(prepared.workoutSchema.properties.causes, 'the schema asks for Causes');
    const { json: saved } = await call('submit_drill', { generationId: prepared.generationId, workout: goodDiagnosis() });
    assert.equal(saved.status, 'saved', JSON.stringify(saved));
    assert.match(saved.workoutId, /^diagnosis_\d{8}_late-job-first$/);
    assert.equal((await readJson(join(saved.workoutDir, 'workout.json'))).diagnosis.causes.length, 4);
  });

  it('makes a What-if about the user\'s sentence, anchored to the source', async () => {
    const repo = await repoWithSources('queue.ts');
    await writeFile(join(repo, 'src', 'queue.ts'), TS_BEFORE_COMMIT);
    const { call } = await connect(repo);
    assert.match((await call('prepare_drill', { target: 'src/queue.ts', kind: 'drill', whatIf: 'x' })).text, /A What-if is one Prediction on request/);
    const { json: prepared } = await call('prepare_drill', { target: 'src/queue.ts', kind: 'prediction', whatIf: 'let the first job win a tie' });
    assert.match(prepared.instructions, /This is a What-if/);
    assert.match(prepared.source, /The Proposed Change, in the human's words: "let the first job win a tie"/);
    assert.ok(prepared.workoutSchema.properties.modelledAs);
    const invented = goodWhatIf({ previous: TS_BEFORE_COMMIT.replace('job.at > best.at', 'best.at < job.at') });
    const { json: rejected } = await call('submit_drill', { generationId: prepared.generationId, workout: invented });
    assert.match(rejected.feedback, /is not in the source file/);
    const { json: saved } = await call('submit_drill', { generationId: prepared.generationId, workout: goodWhatIf() });
    assert.equal(saved.status, 'saved', JSON.stringify(saved));
    const record = await readJson(join(saved.workoutDir, 'workout.json'));
    assert.deepEqual(record.whatIf, { sentence: 'let the first job win a tie', modelled: goodWhatIf().modelledAs });
  });

  it('asks several questions of Predictions only', async () => {
    const { call } = await connect(await repoWithSources('queue.ts'));
    assert.match((await call('prepare_drill', { target: 'src/queue.ts', questions: 3 })).text, /Only a Prediction can ask several questions/);
    assert.match((await call('prepare_drill', { target: 'src/queue.ts', kind: 'prediction', questions: 9 })).text, /from 1 to 5/);
  });

  it('ends a generation the agent judges not worth practicing', async () => {
    const { call } = await connect(await repoWithSources('queue.ts'));
    const [result] = await prepareAndSubmit(call, 'src/queue.ts', [goodDrill({ worthPracticing: false, notWorthReason: 'Constants only.' })]);
    assert.deepEqual(result!.json, { status: 'not-worth-practicing', reason: 'Constants only.' }, result!.text);
  });

  it('caps Drills from agent tasks: three in the queue, one per source file', async () => {
    const repo = await repoWithSources('a.ts', 'b.ts', 'c.ts', 'd.ts');
    const { call } = await connect(repo);
    const [first] = await prepareAndSubmit(call, 'src/a.ts', [goodDrill({ slug: 'a' })], { afterTask: true });
    assert.equal(first!.json.status, 'saved', first!.text);
    assert.match((await call('prepare_drill', { target: 'src/a.ts', afterTask: true })).text, /already has a queued Drill/);
    // A manual request for the same file is still fine.
    assert.equal((await call('prepare_drill', { target: 'src/a.ts' })).isError, false);

    await prepareAndSubmit(call, 'src/b.ts', [goodDrill({ slug: 'b' })], { afterTask: true });
    await prepareAndSubmit(call, 'src/c.ts', [goodDrill({ slug: 'c' })], { afterTask: true });
    assert.match((await call('prepare_drill', { target: 'src/d.ts', afterTask: true })).text, /queue already holds 3 Drills from agent tasks/);
    const origins = (await call('list_workouts')).json.workouts.map((w: { origin: string }) => w.origin);
    assert.deepEqual(origins, ['agent-task', 'agent-task', 'agent-task']);
  });
});

describe('fiu agent install claude', () => {
  function fakeClaude(available = true) {
    const calls: string[][] = [];
    const runClaude: ClaudeInstallOptions['runClaude'] = async (args) => {
      calls.push(args);
      return available ? { exitCode: 0, output: '' } : undefined;
    };
    return { calls, runClaude };
  }
  const base = { version: '1.2.0', fiuCommand: ['/usr/bin/node', '/opt/fiu/dist/cli.js'] };

  it('installs the skill, the command, and the MCP server at user level', async () => {
    const home = await tempDir();
    const { calls, runClaude } = fakeClaude();
    const report = await installClaude({ ...base, scope: 'user', afterTasks: false, home, cwd: home, runClaude });

    const skill = await readFile(join(home, '.claude', 'skills', 'fiu', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: fiu\ndescription: Creates Fiu Drills/);
    assert.match(skill, /<!-- fiu-version: 1\.2\.0 -->/);
    assert.match(await readFile(join(home, '.claude', 'commands', 'fiu-drill.md'), 'utf8'), /Use the fiu skill to create a Drill for: \$ARGUMENTS/);
    assert.match(await readFile(join(home, '.claude', 'commands', 'fiu-atlas.md'), 'utf8'), /Use the fiu skill to build the Atlas for: \$ARGUMENTS/);
    assert.match(skill, /# Building the Fiu Atlas/);
    assert.ok(!existsSync(join(home, '.claude', 'CLAUDE.md')), 'no end-of-task block unless asked');
    assert.deepEqual(calls, [
      ['mcp', 'remove', '--scope', 'user', 'fiu'],
      ['mcp', 'add', '--scope', 'user', 'fiu', '--', '/usr/bin/node', '/opt/fiu/dist/cli.js', 'mcp'],
    ]);
    assert.equal(report.manualMcpCommand, undefined);
  });

  it("replaces a Kintsugi installation: its stamped files, its block, and its MCP registration", async () => {
    const home = await tempDir();
    const claude = join(home, '.claude');
    await mkdir(join(claude, 'skills', 'kintsugi'), { recursive: true });
    await mkdir(join(claude, 'commands'), { recursive: true });
    await writeFile(join(claude, 'skills', 'kintsugi', 'SKILL.md'), '<!-- kintsugi-version: 5.1.0 -->');
    await writeFile(join(claude, 'commands', 'kin-drill.md'), '<!-- kintsugi-version: 5.1.0 -->');
    await writeFile(join(claude, 'commands', 'kin-atlas.md'), 'my own command, no stamp');
    await writeFile(join(claude, 'CLAUDE.md'), 'Mine.\n\n<!-- kintsugi:begin -->\nold\n<!-- kintsugi:end -->\n');
    const { calls, runClaude } = fakeClaude();
    await installClaude({ ...base, scope: 'user', afterTasks: false, home, cwd: home, runClaude });

    assert.ok(!existsSync(join(claude, 'skills', 'kintsugi')));
    assert.ok(!existsSync(join(claude, 'commands', 'kin-drill.md')));
    assert.ok(existsSync(join(claude, 'commands', 'kin-atlas.md')), 'only files carrying the stamp');
    assert.equal(await readFile(join(claude, 'CLAUDE.md'), 'utf8'), 'Mine.\n');
    assert.deepEqual(calls[0], ['mcp', 'remove', '--scope', 'user', 'kintsugi']);
    assert.ok(existsSync(join(claude, 'skills', 'fiu', 'SKILL.md')));
  });

  it("replaces a Fiutsu installation, rewriting its same-named commands with Fiu's stamp", async () => {
    const home = await tempDir();
    const claude = join(home, '.claude');
    await mkdir(join(claude, 'skills', 'fiutsu'), { recursive: true });
    await mkdir(join(claude, 'commands'), { recursive: true });
    await writeFile(join(claude, 'skills', 'fiutsu', 'SKILL.md'), '<!-- fiutsu-version: 6.0.0 -->');
    await writeFile(join(claude, 'commands', 'fiu-drill.md'), '<!-- fiutsu-version: 6.0.0 -->');
    await writeFile(join(claude, 'CLAUDE.md'), 'Mine.\n\n<!-- fiutsu:begin -->\nold\n<!-- fiutsu:end -->\n');
    const { calls, runClaude } = fakeClaude();
    await installClaude({ ...base, scope: 'user', afterTasks: false, home, cwd: home, runClaude });

    assert.ok(!existsSync(join(claude, 'skills', 'fiutsu')));
    assert.equal(await readFile(join(claude, 'CLAUDE.md'), 'utf8'), 'Mine.\n');
    assert.match(await readFile(join(claude, 'commands', 'fiu-drill.md'), 'utf8'), /<!-- fiu-version: /);
    assert.deepEqual(calls[0], ['mcp', 'remove', '--scope', 'user', 'fiutsu']);
    assert.deepEqual(calls.at(-1)?.slice(0, 5), ['mcp', 'add', '--scope', 'user', 'fiu']);
    assert.ok(existsSync(join(claude, 'skills', 'fiu', 'SKILL.md')));
  });

  it("adds the end-of-task block to the user's CLAUDE.md once, and removes only that block", async () => {
    const home = await tempDir();
    await mkdir(join(home, '.claude'));
    const memory = join(home, '.claude', 'CLAUDE.md');
    await writeFile(memory, '# My rules\n\nUse tabs.\n');
    const { runClaude } = fakeClaude();

    await installClaude({ ...base, scope: 'user', afterTasks: true, home, cwd: home, runClaude });
    await installClaude({ ...base, scope: 'user', afterTasks: true, home, cwd: home, runClaude });
    const installed = await readFile(memory, 'utf8');
    assert.equal(installed.match(/fiu:begin/g)?.length, 1);
    assert.match(installed, /^# My rules\n\nUse tabs\.\n\n<!-- fiu:begin -->\n[\s\S]*afterTask: true[\s\S]*<!-- fiu:end -->\n$/);

    await uninstallClaude({ scope: 'user', home, cwd: home, runClaude });
    assert.equal(await readFile(memory, 'utf8'), '# My rules\n\nUse tabs.\n');
    assert.ok(!existsSync(join(home, '.claude', 'skills', 'fiu')));
    assert.ok(!existsSync(join(home, '.claude', 'commands', 'fiu-drill.md')));
    assert.ok(!existsSync(join(home, '.claude', 'commands', 'fiu-atlas.md')));
  });

  it('prints the registration command when the claude CLI is missing', async () => {
    const home = await tempDir();
    const report = await installClaude({ ...base, scope: 'user', afterTasks: false, home, cwd: home, runClaude: fakeClaude(false).runClaude });
    assert.equal(report.manualMcpCommand, 'claude mcp add --scope user fiu -- /usr/bin/node /opt/fiu/dist/cli.js mcp');
  });

  it('installs into one repository untracked, registering the server for that project only', async () => {
    const repo = await repoWithSources('queue.ts');
    const { calls, runClaude } = fakeClaude();
    await installClaude({ ...base, scope: 'project', afterTasks: true, home: await tempDir(), cwd: join(repo, 'src'), runClaude });
    assert.ok(existsSync(join(repo, '.claude', 'skills', 'fiu', 'SKILL.md')));
    assert.match(await readFile(join(repo, 'CLAUDE.local.md'), 'utf8'), /fiu:begin/);
    assert.equal((await execa('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo })).stdout, '');
    assert.deepEqual(calls[1]!.slice(0, 5), ['mcp', 'add', '--scope', 'local', 'fiu']);
  });

  it('never modifies a tracked file', async () => {
    const repo = await repoWithSources('queue.ts');
    await mkdir(join(repo, '.claude', 'commands'), { recursive: true });
    await writeFile(join(repo, '.claude', 'commands', 'fiu-drill.md'), 'team version\n');
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'team command'], { cwd: repo });
    await assert.rejects(
      installClaude({ ...base, scope: 'project', afterTasks: false, home: await tempDir(), cwd: repo, runClaude: fakeClaude().runClaude }),
      TrackedFileError,
    );
    assert.equal(await readFile(join(repo, '.claude', 'commands', 'fiu-drill.md'), 'utf8'), 'team version\n');
  });
});

describe(`Tracks in agent mode (${sandboxWorks ? 'sandboxed' : 'skipped: no sandbox'})`, { skip: !sandboxWorks }, () => {
  /** A module of four logic-bearing files, long enough to be candidates. */
  async function repoWithModule(): Promise<string> {
    const repo = await tempGitRepo();
    const file = (name: string, n: number) =>
      `${TS_REFERENCE}\n${Array.from({ length: n }, (_, i) => `export const ${name}${i} = (x: number) => (x > ${i} ? x : ${i});`).join('\n')}\n${'// note\n'.repeat(8)}`;
    await mkdir(join(repo, 'src', 'core'), { recursive: true });
    for (const [name, n] of [['store', 9], ['queue', 7], ['worker', 5], ['extra', 3]] as const) {
      await writeFile(join(repo, 'src', 'core', `${name}.ts`), file(name, n));
    }
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'module'], { cwd: repo });
    return repo;
  }

  async function step(call: Awaited<ReturnType<typeof connect>>['call'], trackId: string, target: string, workouts: AnyWorkoutOutput[]) {
    const prepared = await call('prepare_drill', { target, trackId, why: `${target} matters.` });
    assert.equal(prepared.isError, false, prepared.text);
    let last;
    for (const workout of workouts) last = await call('submit_drill', { generationId: prepared.json.generationId, workout });
    return { prepared: prepared.json, last: last! };
  }

  it('builds a Track step by step and saves it in order', async () => {
    const repo = await repoWithModule();
    const { call } = await connect(repo);
    const { json: track } = await call('prepare_track', { module: 'src/core' });
    assert.match(track.trackId, /^track_\d{8}_src-core$/);
    assert.deepEqual(track.candidates.map((c: { path: string }) => c.path), ['src/core/store.ts', 'src/core/queue.ts', 'src/core/worker.ts', 'src/core/extra.ts']);
    assert.match(track.rules, /foundations first/);

    const first = await step(call, track.trackId, 'src/core/worker.ts', [goodDrill({ slug: 'w' })]);
    assert.match(first.prepared.source, /step 1 in a Track teaching a newcomer the module src\/core\. This file matters because: src\/core\/worker\.ts matters\./);
    // A step that can't be Verified is dropped; another candidate takes its place.
    const noBug = goodDrill({ startingCode: TS_REFERENCE });
    await step(call, track.trackId, 'src/core/extra.ts', [noBug, noBug, noBug]);
    await step(call, track.trackId, 'src/core/store.ts', [goodDrill({ slug: 's' })]);
    await step(call, track.trackId, 'src/core/queue.ts', [goodDrill({ slug: 'q' })]);

    const { json: finished } = await call('finish_track', { trackId: track.trackId, title: 'The job scheduler' });
    assert.equal(finished.status, 'saved', JSON.stringify(finished));
    assert.deepEqual(finished.steps.map((s: { path: string }) => s.path), ['src/core/worker.ts', 'src/core/store.ts', 'src/core/queue.ts']);
    assert.deepEqual(finished.dropped, ['src/core/extra.ts: no Verified Drill']);
    assert.equal(finished.next, `The user starts it with: fiu track ${track.trackId}`);

    const paths = workspacePaths(repo);
    const saved = JSON.parse(await readFile(join(paths.root, 'tracks', `${track.trackId}.json`), 'utf8'));
    assert.equal(saved.generator, 'agent');
    const firstWorkout = finished.steps[0].workoutId;
    const record = JSON.parse(await readFile(join(paths.workoutsDir, firstWorkout, 'workout.json'), 'utf8'));
    assert.deepEqual([record.origin, record.generator, record.track.module], ['explore', 'agent', 'src/core']);
    assert.match(await readFile(join(paths.workoutsDir, firstWorkout, 'README.md'), 'utf8'), /^\*Part of a Track on src\/core: src\/core\/worker\.ts matters\.\*$/m);
  });

  it("builds a Track along Understand-Anything's flow, in the flow's order", async () => {
    const repo = await repoWithModule();
    await writeUaFlows(repo, [
      {
        name: 'Run a Job',
        domain: 'Scheduling',
        entry: 'fiu run <job>',
        steps: [
          { name: 'Pick the job', path: 'src/core/worker.ts' },
          { name: 'Queue the next', path: 'src/core/queue.ts' },
          { name: 'Save the result', path: 'src/core/store.ts' },
        ],
      },
    ]);
    const { call } = await connect(repo);
    assert.match((await call('prepare_track', {})).text, /a module directory, or a flow name to follow \(one of them\)/);
    assert.match((await call('prepare_track', { flow: 'payments' })).text, /No flow matches "payments"/);
    const { json: track } = await call('prepare_track', { flow: 'run a job' });
    assert.match(track.trackId, /^track_\d{8}_run-a-job$/);
    assert.deepEqual(track.flow, { name: 'Run a Job', domain: 'Scheduling', entry: 'fiu run <job>' });
    assert.deepEqual(
      track.candidates.map((c: { path: string; flowSteps: string }) => [c.path, c.flowSteps]),
      [
        ['src/core/worker.ts', 'step 1 of 3: Pick the job'],
        ['src/core/queue.ts', 'step 2 of 3: Queue the next'],
        ['src/core/store.ts', 'step 3 of 3: Save the result'],
      ],
    );
    assert.match(track.rules, /keep them in the order listed/);

    const first = await step(call, track.trackId, 'src/core/worker.ts', [goodDrill({ slug: 'w' })]);
    assert.match(first.prepared.source, /step 1 in a Track following the business flow "Run a Job" through the code/);
    await step(call, track.trackId, 'src/core/queue.ts', [goodDrill({ slug: 'q' })]);
    await step(call, track.trackId, 'src/core/store.ts', [goodDrill({ slug: 's' })]);
    const { json: finished } = await call('finish_track', { trackId: track.trackId, title: 'Running a job' });
    assert.equal(finished.status, 'saved', JSON.stringify(finished));
    const saved = JSON.parse(await readFile(join(workspacePaths(repo).root, 'tracks', `${track.trackId}.json`), 'utf8'));
    assert.deepEqual([saved.flow, saved.module], ['Run a Job', 'src/core']);
    const firstWorkout = finished.steps[0].workoutId;
    assert.match(await readFile(join(workspacePaths(repo).workoutsDir, firstWorkout, 'README.md'), 'utf8'), /^\*Part of a Track following the flow "Run a Job": src\/core\/worker\.ts matters\.\*$/m);
  });

  it('keeps Track steps to the shortlist, one per file, each with a why', async () => {
    const repo = await repoWithModule();
    const { call } = await connect(repo);
    const { json: track } = await call('prepare_track', { module: 'src/core' });
    assert.match((await call('prepare_drill', { target: 'src/core/store.ts', trackId: track.trackId })).text, /needs `why`/);
    assert.match((await call('prepare_drill', { target: 'src/core/store.ts', trackId: 'track_nope', why: 'x' })).text, /Unknown track id/);
    assert.deepEqual(track.kinds, ['prediction', 'diagnosis', 'drill', 'kata']);
    assert.match(track.rules, /Use at least two different kinds/);
    assert.equal((await call('prepare_drill', { target: 'src/core/store.ts', trackId: track.trackId, why: 'x', kind: 'kata' })).json.kind, 'kata');
    await writeFile(join(repo, 'src', 'core', 'new.ts'), TS_REFERENCE);
    assert.match((await call('prepare_drill', { target: 'src/core/new.ts', trackId: track.trackId, why: 'x' })).text, /not one of the Track's candidate files/);
    await step(call, track.trackId, 'src/core/store.ts', [goodDrill({ slug: 's' })]);
    assert.match((await call('prepare_drill', { target: 'src/core/store.ts', trackId: track.trackId, why: 'x' })).text, /already a step of this Track/);
    assert.match((await call('prepare_track', { module: 'src/core/store.ts' })).text, /is a file: explore a module directory/);
  });

  it('makes every step a Prediction for someone who reads no code', async () => {
    const repo = await repoWithModule();
    const home = await tempDir();
    await mkdir(join(home, '.config', 'fiu'), { recursive: true });
    await writeFile(join(home, '.config', 'fiu', 'config.json'), JSON.stringify({ kinds: ['prediction'] }));
    const { call } = await connect(repo, home);
    const { json: track } = await call('prepare_track', { module: 'src/core' });
    assert.deepEqual(track.kinds, ['prediction']);
    assert.match((await call('prepare_drill', { target: 'src/core/store.ts', trackId: track.trackId, why: 'x' })).text, /This Track's steps are Prediction: a Drill isn't one of them/);
  });

  it('saves no Track with fewer than 3 Verified steps', async () => {
    const repo = await repoWithModule();
    const { call } = await connect(repo);
    const { json: track } = await call('prepare_track', { module: 'src/core' });
    await step(call, track.trackId, 'src/core/store.ts', [goodDrill({ slug: 's' })]);
    await step(call, track.trackId, 'src/core/queue.ts', [goodDrill({ slug: 'q' })]);
    const { json: finished } = await call('finish_track', { trackId: track.trackId, title: 'Too short' });
    assert.equal(finished.status, 'not-enough');
    assert.equal(finished.workoutIds.length, 2);
    assert.ok(!existsSync(join(repo, '.fiu', 'tracks', `${track.trackId}.json`)));
  });
});

