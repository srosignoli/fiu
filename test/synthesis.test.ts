import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { APICallError } from 'ai';
import { TYPESCRIPT } from '../src/languages/builtin.ts';
import { openSandbox } from '../src/sandbox/sandbox.ts';
import { drillSystemPrompt, drillUserPrompt, kataSystemPrompt, MAX_SOURCE_LINES } from '../src/synthesis/prompt.ts';
import { checkDrillOutput, checkWorkoutOutput } from '../src/synthesis/schema.ts';
import { SourceTooLargeError, synthesizeDrill, type SynthesisEvent } from '../src/synthesis/synthesize.ts';
import { tempDir } from './helpers.ts';
import { goodDrill, goodKata, scriptedModel, TS_REFERENCE } from './mock-model.ts';

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

  it('ask for a report, not a silent fix, when the original looks wrong', () => {
    for (const system of [drillSystemPrompt(TYPESCRIPT), kataSystemPrompt(TYPESCRIPT)]) {
      assert.match(system, /If the original itself looks wrong, don't fix it silently: say where and why in originalDefect/);
    }
  });

  it('keep Hints to nudges in plain words', () => {
    assert.match(drillSystemPrompt(TYPESCRIPT), /Hints name no expression, operator, or value from the fix\./);
    assert.match(kataSystemPrompt(TYPESCRIPT), /Hints name no expression, call sequence, or index arithmetic from the missing code\./);
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

  // Anchor explanations from the first dogfooding run (2026-10-23).
  const anchors = (...explanations: string[]) => explanations.map((explanation) => ({ startLine: 1, endLine: 3, explanation }));

  it('catches anchor explanations that give the bug away', () => {
    const spoilers = [
      "LCS table and the walk that groups edits into contiguous hunks; the bug is in the walk's matching-line branch.",
      'toFloat64 and toDuration kept verbatim; the bug is injected into toDuration\'s string branch.',
      'parseN4L is the unit under test; the bug is injected in the _sequence_ context cleanup (lines 102-106).',
      'Equirectangular distance and initial great-circle bearing are reproduced verbatim (bug injected in the bearing normalization).',
      'maskSpecial: blanks LaTeX and single-quoted regions with the apostrophe opening/closing rules; the bug is in the closing-quote rule.',
      'parseGoJson and its GoEvent shape are extracted nearly verbatim; the bug is injected into the leaf-test filter at lines 125-127.',
    ];
    const problems = checkDrillOutput(goodDrill({ sourceAnchors: anchors(...spoilers) }), 10);
    assert.equal(problems.length, spoilers.length, problems.join('\n'));
    assert.match(problems[0]!, /gives the bug away/);
  });

  it('accepts neutral anchor explanations', () => {
    const neutral = [
      'Hunk type and line normalisation copied verbatim.',
      'withMessage is inlined so failure messages attach the same way.',
      'buildSchedule kept verbatim, with ScheduleConfig defined inline.',
      'stripLineComment: finds the first unmasked // that is not a URL scheme separator and cuts the line there.',
      'Hint reveal counting, kept as is.',
    ];
    assert.deepEqual(checkDrillOutput(goodDrill({ sourceAnchors: anchors(...neutral) }), 10), []);
  });

  it('catches a README that mentions the injected change', () => {
    const readmeMarkdown = '## Symptom\nJobs run out of order.\n\n## Mission\nFind the injected bug.';
    assert.match(checkDrillOutput(goodDrill({ readmeMarkdown }), 10).join(), /mentions the injected change/);
  });
});

describe('checkWorkoutOutput for Katas', () => {
  it('accepts a well-formed Kata', () => {
    assert.deepEqual(checkWorkoutOutput('kata', goodKata(), 10), []);
  });

  it('catches a brief or hint that gives the missing code away', () => {
    const leakyReadme = goodKata({ readmeMarkdown: `${goodKata().readmeMarkdown}\n\nStart with: for (const job of jobs) {` });
    assert.match(checkWorkoutOutput('kata', leakyReadme, 10).join(), /contain the missing code verbatim \("for \(const job of jobs\) \{"\)/);
    const fragment = goodKata({ hints: ['Keep the best job seen so far.', 'In the end, return its id.'] });
    assert.deepEqual(checkWorkoutOutput('kata', fragment, 10), [], 'naming a fragment of the code is fine');
    const sharper = goodKata({ hints: ['Keep the best job seen so far.', 'Use let best: Job | undefined; and a loop.'] });
    assert.match(checkWorkoutOutput('kata', sharper, 10).join(), /missing code verbatim/);
  });

  it('needs a gapSummary, not a Regression Test', () => {
    assert.match(checkWorkoutOutput('kata', goodKata({ gapSummary: ' ' }), 10).join(), /gapSummary is empty/);
    assert.match(checkWorkoutOutput('drill', { ...goodKata(), regressionTestName: undefined }, 10).join(), /regressionTestName is empty/);
  });
});

const sandbox = await openSandbox({ allowUnsandboxed: true });
after(() => sandbox.dispose());

async function synthesize(model: ReturnType<typeof scriptedModel>['model'], source = TS_REFERENCE, options: { kind?: 'drill' | 'kata'; quick?: boolean } = {}) {
  const events: SynthesisEvent[] = [];
  const result = await synthesizeDrill({
    target: { path: 'src/queue.ts', source },
    profile: TYPESCRIPT,
    sandbox,
    model,
    modelId: 'mock-model-id',
    cacheRoot: await tempDir(),
    onEvent: (event) => events.push(event),
    ...options,
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

describe(`synthesizing Katas (${sandbox.isolated ? 'sandboxed' : 'UNSANDBOXED'})`, () => {
  it('asks for a Kata and verifies its gap', async () => {
    const { model, prompts } = scriptedModel(goodKata());
    const { result } = await synthesize(model, TS_REFERENCE, { kind: 'kata' });
    assert.equal(result.status, 'verified', JSON.stringify(result));
    assert.equal(result.status === 'verified' && result.workout.gapSummary, goodKata().gapSummary);
    assert.match(prompts[0]!, /You create Katas/);
    assert.match(prompts[0]!, /Remove one contiguous region of 5 to 25 lines/);
    assert.match(prompts[0]!, /Pick the unit in this file whose logic is most worth practicing/);
  });

  it('sends a Drill-sized gap back as too small for a Kata', async () => {
    const tooSmall = goodKata({ startingCode: TS_REFERENCE.replace('job.at < best.at', 'false') });
    const { model, prompts } = scriptedModel(tooSmall, goodKata());
    const { result } = await synthesize(model, TS_REFERENCE, { kind: 'kata' });
    assert.equal(result.status === 'verified' && result.attempts, 2);
    assert.match(prompts[1]!, /That Kata was not Verified/);
    assert.match(prompts[1]!, /\[minimal-diff\] The gap removes 1 lines; a Kata removes 5 to 25\./);
  });

  it('holds a Quick Kata to a gap of 12 lines at most', async () => {
    const { model, prompts } = scriptedModel(goodKata());
    await synthesize(model, TS_REFERENCE, { kind: 'kata', quick: true });
    assert.match(prompts[0]!, /This is a Quick Kata/);
    assert.match(prompts[0]!, /5 to 12 lines/);
  });
});
