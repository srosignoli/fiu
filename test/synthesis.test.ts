import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { APICallError } from 'ai';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import { drillSystemPrompt, drillUserPrompt, MAX_SOURCE_LINES } from '../src/synthesis/prompt.ts';
import { checkDrillOutput } from '../src/synthesis/schema.ts';
import { SourceTooLargeError, synthesizeDrill, type SynthesisEvent } from '../src/synthesis/synthesize.ts';
import { tempDir } from './helpers.ts';
import { goodDrill, scriptedModel, TS_REFERENCE } from './mock-model.ts';

describe('prompts', () => {
  it('number the source lines and name the pinned symbol', () => {
    const prompt = drillUserPrompt({ path: 'src/queue.ts', source: 'const a = 1;\nconst b = 2;\n', symbol: 'pickNext' });
    assert.match(prompt, /Source file: src\/queue\.ts/);
    assert.match(prompt, /`pickNext`/);
    assert.match(prompt, / {4}1 \| const a = 1;\n {4}2 \| const b = 2;\n<\/source>/);
  });

  it("include the profile's file names and rules", () => {
    const system = drillSystemPrompt(TYPESCRIPT);
    assert.match(system, /named kata\.ts and the test file kata\.test\.ts/);
    assert.match(system, /- Use only erasable TypeScript syntax/);
  });
});

describe('checkDrillOutput', () => {
  it('accepts a well-formed Drill', () => {
    assert.deepEqual(checkDrillOutput(goodDrill(), 10), []);
  });

  it('reports what the schema cannot enforce', () => {
    const problems = checkDrillOutput(
      goodDrill({ slug: 'Not A Slug', estimatedMinutes: 40, hints: ['only one'], sourceAnchors: [{ startLine: 5, endLine: 99, explanation: '' }], testSuiteCode: ' ' }),
      10,
    );
    assert.equal(problems.length, 5, problems.join('\n'));
  });
});

const sandbox = await openSandbox({ allowUnsandboxed: true });
after(() => sandbox.dispose());

async function synthesize(model: ReturnType<typeof scriptedModel>['model'], source = TS_REFERENCE) {
  const events: SynthesisEvent[] = [];
  const result = await synthesizeDrill({
    target: { path: 'src/queue.ts', source },
    profile: TYPESCRIPT,
    sandbox,
    model,
    modelId: 'mock-model-id',
    cacheRoot: await tempDir(),
    onEvent: (event) => events.push(event),
  });
  return {
    result,
    events: events.filter((e) => e.type !== 'usage').map((e) => `${e.type}:${e.attempt}`),
    usage: events.flatMap((e) => (e.type === 'usage' ? e.usage : [])),
  };
}

describe(`synthesizeDrill (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('returns a Drill that passes the Verified gate on the first attempt', async () => {
    const { model, prompts } = scriptedModel(goodDrill());
    const { result, events } = await synthesize(model);
    assert.equal(result.status, 'verified', JSON.stringify(result));
    assert.equal(prompts.length, 1);
    assert.deepEqual(events, ['generating:1', 'verifying:1']);
  });

  it('feeds verifier failures back and keeps the conversation append-only', async () => {
    const noBug = goodDrill({ startingCode: TS_REFERENCE });
    const { model, prompts } = scriptedModel(noBug, goodDrill());
    const { result, events } = await synthesize(model);
    assert.equal(result.status, 'verified');
    assert.equal(result.status === 'verified' && result.attempts, 2);
    assert.deepEqual(events, ['generating:1', 'verifying:1', 'rejected:1', 'generating:2', 'verifying:2']);
    // The retry sees its own first answer, then the verifier's findings.
    assert.ok(prompts[1]!.startsWith(prompts[0]!.slice(0, -1)));
    assert.match(prompts[1]!, /That Drill was not Verified/);
    assert.match(prompts[1]!, /\[minimal-diff\] The Starting Code is identical/);
    assert.match(prompts[1]!, /\[starting-code-fails\]/);
  });

  it('retries schema problems and malformed JSON without running anything', async () => {
    const { model, prompts } = scriptedModel('{ not json', goodDrill({ hints: ['just one'] }), goodDrill());
    const { result, events } = await synthesize(model);
    assert.equal(result.status, 'verified');
    assert.deepEqual(events, ['generating:1', 'rejected:1', 'generating:2', 'rejected:2', 'generating:3', 'verifying:3']);
    assert.match(prompts[1]!, /\[schema\] The response was not a valid Drill object/);
    assert.match(prompts[2]!, /\[schema\] hints must contain exactly 2/);
  });

  it('gives up after three unverified attempts', async () => {
    const { model, prompts } = scriptedModel(goodDrill({ startingCode: TS_REFERENCE }));
    const { result } = await synthesize(model);
    assert.equal(prompts.length, 3);
    assert.equal(result.status, 'failed');
    assert.match(result.status === 'failed' ? result.feedback : '', /identical/);
  });

  it('stops at once when the target is not worth practicing', async () => {
    const { model, prompts } = scriptedModel(goodDrill({ worthPracticing: false, notWorthReason: 'Only constants.' }));
    const { result } = await synthesize(model);
    assert.deepEqual(result, { status: 'not-worth-practicing', reason: 'Only constants.' });
    assert.equal(prompts.length, 1);
  });

  it('does not retry API errors', async () => {
    const error = new APICallError({ message: 'invalid x-api-key', url: 'https://api', requestBodyValues: {}, statusCode: 401, isRetryable: false });
    const { model, prompts } = scriptedModel(error);
    await assert.rejects(synthesize(model), APICallError);
    assert.equal(prompts.length, 1);
  });

  it('refuses source files too large to send whole', async () => {
    const { model, prompts } = scriptedModel(goodDrill());
    await assert.rejects(synthesize(model, 'x\n'.repeat(MAX_SOURCE_LINES + 1)), SourceTooLargeError);
    assert.equal(prompts.length, 0);
  });
});
