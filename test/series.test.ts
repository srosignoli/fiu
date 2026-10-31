import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { preflight } from '../src/languages/run.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import { expandSeries, seriesOverlaps } from '../src/synthesis/schema.ts';
import { synthesizeSeries } from '../src/synthesis/synthesize.ts';
import { tempDir } from './helpers.ts';
import { goodSeries, scriptedModel, tieQuestion, TS_REFERENCE, urgentQuestion } from './mock-model.ts';

const sandbox = await openSandbox({ allowUnsandboxed: true });
const cacheRoot = await tempDir();
after(() => sandbox.dispose());
const target = { path: 'src/queue.ts', source: TS_REFERENCE };

async function series(...replies: Parameters<typeof scriptedModel>) {
  await preflight(sandbox, TYPESCRIPT, cacheRoot);
  const scripted = scriptedModel(...replies);
  const events: string[] = [];
  const result = await synthesizeSeries({
    target,
    profile: TYPESCRIPT,
    sandbox,
    model: scripted.model,
    modelId: 'test',
    cacheRoot,
    count: 2,
    onEvent: (e) => events.push(e.type),
  });
  return { result, prompts: scripted.prompts, events };
}

describe('seriesOverlaps', () => {
  it('finds questions asking the same thing: Scenario, true outcome, or Variant', () => {
    const [tie, urgent] = expandSeries(goodSeries([tieQuestion(), urgentQuestion()]));
    assert.deepEqual([...seriesOverlaps([tie!, urgent!]).keys()], []);
    const sameScenario = expandSeries(goodSeries([tieQuestion({ slug: 'again' })]))[0]!;
    assert.match(seriesOverlaps([tie!, sameScenario]).get(1)![0]!, /same Scenario as question 1/);
    const sameTruth = expandSeries(goodSeries([urgentQuestion({ scenario: 'Another situation.', options: urgentQuestion().options.map((o, i) => (i === 0 ? { ...o, text: 'The "early" job runs next.' } : o)) })]))[0]!;
    assert.match(seriesOverlaps([sameTruth], [tie!]).get(0)![0]!, /true outcome is the same as the saved question "Who goes first on a tie"/);
    const sameVariant = expandSeries(goodSeries([urgentQuestion({ scenario: 'Yet another.', options: urgentQuestion().options.map((o, i) => (i === 1 ? { ...o, variant: tie!.options[1]!.variant } : o)) })]))[0]!;
    assert.match(seriesOverlaps([tie!, sameVariant]).get(1)![0]!, /repeats a Variant of question 1/);
  });
});

describe(`synthesizeSeries (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('Verifies each question against the shared Reference Solution', async () => {
    const { result, prompts } = await series(goodSeries([tieQuestion(), urgentQuestion()]));
    assert.equal(result.status, 'verified');
    if (result.status !== 'verified') return;
    assert.deepEqual(result.questions.map((q) => q.workout.slug), ['tied-priorities', 'urgent-first']);
    assert.equal(result.attempts, 1);
    assert.equal(result.questions[1]!.workout.referenceSolution, TS_REFERENCE);
    assert.match(prompts[0]!, /This is a Series: 2 Predictions about the same unit/);
  });

  it('keeps what passes and asks for replacements of the rest only', async () => {
    const repeat = tieQuestion({ slug: 'again', title: 'Again' });
    const { result, prompts } = await series(goodSeries([tieQuestion(), repeat]), goodSeries([urgentQuestion()]));
    assert.match(prompts[1]!, /1 question\(s\) of the Series were Verified and are saved/);
    assert.match(prompts[1]!, /Question 2 \(\\"Again\\"\):\\n\[schema\] it asks the same Scenario as question 1/);
    assert.match(prompts[1]!, /Write 1 replacement question\(s\)/);
    assert.equal(result.status, 'verified');
    if (result.status !== 'verified') return;
    assert.deepEqual(result.questions.map((q) => [q.workout.slug, q.attempt]), [['tied-priorities', 1], ['urgent-first', 2]]);
    assert.equal(result.attempts, 2);
  });

  it('saves what it has when the retry fails too', async () => {
    const broken = urgentQuestion({ options: urgentQuestion().options.map((o, i) => (i === 3 ? { ...o, testName: 'no such test' } : o)) });
    const { result } = await series(goodSeries([tieQuestion(), broken]), goodSeries([broken]));
    assert.equal(result.status, 'verified');
    if (result.status !== 'verified') return;
    assert.equal(result.questions.length, 1);
    assert.equal(result.requested, 2);
  });

  it('fails when no question Verifies, and stops when the unit is not worth it', async () => {
    const broken = goodSeries([tieQuestion({ options: [] })]);
    assert.equal((await series(broken, broken)).result.status, 'failed');
    const notWorth = { ...goodSeries([]), worthPracticing: false, notWorthReason: 'Plumbing only.' };
    assert.deepEqual((await series(notWorth)).result, { status: 'not-worth-practicing', reason: 'Plumbing only.' });
  });
});
