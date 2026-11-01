import { MockLanguageModelV4 } from 'ai/test';
import type { AnyWorkoutOutput, CommitPredictionOutput, DiagnosisOutput, DrillOutput, KataOutput, PredictionOutput, PredictionSeriesOutput, SeriesQuestion, WhatIfOutput } from '../src/synthesis/schema.ts';

export interface ScriptedModel {
  model: MockLanguageModelV4;
  /** Each call's full prompt, serialised, for asserting on what the model was told. */
  prompts: string[];
}

/** A model that answers successive calls with the given replies (objects are sent as JSON; Errors are thrown). */
export function scriptedModel(...replies: (Partial<AnyWorkoutOutput> | PredictionSeriesOutput | string | Error)[]): ScriptedModel {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const reply = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

export const TS_TESTS = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext } from './kata.ts';

describe('pickNext', () => {
  it('picks the highest priority', () => assert.equal(pickNext([{ id: 'a', priority: 1, at: 0 }, { id: 'b', priority: 5, at: 1 }]), 'b'));
  it('returns nothing when the queue is empty', () => assert.equal(pickNext([]), undefined));
  it('serves equal priorities first come, first served', () =>
    assert.equal(pickNext([{ id: 'early', priority: 3, at: 1 }, { id: 'late', priority: 3, at: 2 }]), 'early'));
});
`;

export const TS_REFERENCE = `export interface Job { id: string; priority: number; at: number }

export function pickNext(jobs: Job[]): string | undefined {
  let best: Job | undefined;
  for (const job of jobs) {
    if (!best || job.priority > best.priority || (job.priority === best.priority && job.at < best.at)) best = job;
  }
  return best?.id;
}
`;

/** A Drill that passes the Verified gate with the TypeScript profile. */
/** What the model reports when the original looks right. */
export const NO_DEFECT = { startLine: 0, endLine: 0, description: '' };

export function goodDrill(overrides: Partial<DrillOutput> = {}): DrillOutput {
  return {
    worthPracticing: true,
    notWorthReason: '',
    slug: 'tie-breaker',
    title: 'Late jobs jump the queue',
    pillar: 'algorithm',
    estimatedMinutes: 5,
    sourceAnchors: [{ startLine: 1, endLine: 3, explanation: 'The scheduler picks the next job here.' }],
    readmeMarkdown: '## Symptom\nJobs submitted later run first when priorities tie.\n\n## Mission\nMake all tests pass.',
    hints: ['Look at how ties are broken.', 'Which job arrived first?'],
    startingCode: TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at'),
    referenceSolution: TS_REFERENCE,
    testSuiteCode: TS_TESTS,
    regressionTestName: 'serves equal priorities first come, first served',
    injectedBugDescription: 'The tie-breaker compares arrival times the wrong way round.',
    originalDefect: NO_DEFECT,
    ...overrides,
  };
}

/** The body of pickNext: the five lines a Kata removes. */
const PICK_NEXT_BODY = `  let best: Job | undefined;
  for (const job of jobs) {
    if (!best || job.priority > best.priority || (job.priority === best.priority && job.at < best.at)) best = job;
  }
  return best?.id;
`;

/** A Kata that passes the Verified gate with the TypeScript profile: pickNext's body is the gap. */
export function goodKata(overrides: Partial<KataOutput> = {}): KataOutput {
  return {
    worthPracticing: true,
    notWorthReason: '',
    slug: 'pick-next',
    title: 'Choose the next job',
    pillar: 'algorithm',
    estimatedMinutes: 5,
    sourceAnchors: [{ startLine: 3, endLine: 9, explanation: 'The scheduler picks the next job here.' }],
    readmeMarkdown:
      '## What it must do\npickNext returns the id of the job with the highest priority; ties go to the job that arrived first (lowest `at`). An empty queue gives undefined.\n\n## Where it fits\nThe scheduler calls it to choose what runs next.\n\n## Mission\nFill in pickNext until every test passes.',
    hints: ['Keep the best job seen so far.', 'A tie on priority is decided by arrival time.'],
    startingCode: TS_REFERENCE.replace(PICK_NEXT_BODY, '  // TODO: choose the next job.\n  return undefined;\n'),
    referenceSolution: TS_REFERENCE,
    testSuiteCode: TS_TESTS,
    gapSummary: 'The whole body of pickNext: a single pass keeping the best job, ties broken by earliest arrival.',
    originalDefect: NO_DEFECT,
    ...overrides,
  };
}

/** Tests pinning each of a Prediction's four outcomes, one per option. */
export const TS_PREDICTION_TESTS = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext } from './kata.ts';

const jobs = [{ id: 'late', priority: 3, at: 2 }, { id: 'low', priority: 1, at: 0 }, { id: 'early', priority: 3, at: 1 }];

describe('what runs next', () => {
  it('runs the early job', () => assert.equal(pickNext(jobs), 'early'));
  it('runs the late job', () => assert.equal(pickNext(jobs), 'late'));
  it('runs the low-priority job', () => assert.equal(pickNext(jobs), 'low'));
  it('runs no job', () => assert.equal(pickNext(jobs), undefined));
});
`;

/** A Prediction that passes the Verified gate with the TypeScript profile: which job pickNext serves on a tie. */
export function goodPrediction(overrides: Partial<PredictionOutput> = {}): PredictionOutput {
  const none = { original: '', changed: '' };
  return {
    worthPracticing: true,
    notWorthReason: '',
    slug: 'tied-priorities',
    title: 'Who goes first on a tie',
    pillar: 'algorithm',
    estimatedMinutes: 3,
    sourceAnchors: [{ startLine: 3, endLine: 9, explanation: 'The scheduler picks the next job here.' }],
    scenario:
      'Three jobs are waiting. "late" has priority 3 and arrived at 2 o\'clock, "low" has priority 1 and arrived at midnight, and "early" has priority 3 and arrived at 1 o\'clock. Which job runs next?',
    options: [
      { text: 'The "early" job runs next.', testName: 'runs the early job', correct: true, variant: none, misunderstanding: '' },
      {
        text: 'The "late" job runs next.',
        testName: 'runs the late job',
        correct: false,
        variant: { original: 'job.at < best.at', changed: 'job.at > best.at' },
        misunderstanding: 'You were picturing a system where the newest job wins a tie.',
      },
      {
        text: 'The "low" job runs next.',
        testName: 'runs the low-priority job',
        correct: false,
        variant: { original: 'job.priority > best.priority', changed: 'job.priority < best.priority' },
        misunderstanding: 'You were picturing a system where a lower number means more urgent.',
      },
      {
        text: 'No job runs until the tie is resolved.',
        testName: 'runs no job',
        correct: false,
        variant: { original: ' best = job;', changed: ' best = best && job.priority === best.priority ? undefined : job;' },
        misunderstanding: 'You were picturing a system where a tie holds the queue.',
      },
    ],
    explanation: 'The highest priority wins, and between equal priorities the job that arrived first runs: first come, first served.',
    referenceSolution: TS_REFERENCE,
    testSuiteCode: TS_PREDICTION_TESTS,
    originalDefect: NO_DEFECT,
    ...overrides,
  };
}

/** pickNext before a commit that made ties first come, first served: the newest job used to win. */
export const TS_BEFORE_COMMIT = TS_REFERENCE.replace('job.at < best.at', 'job.at > best.at');

/** A Prediction from that commit: the old behaviour ("late" wins) is the Previous Version, not a Variant. */
export function goodCommitPrediction(overrides: Partial<CommitPredictionOutput> = {}): CommitPredictionOutput {
  const base = goodPrediction();
  return {
    ...base,
    slug: 'tie-goes-to-first',
    options: base.options.map((option, i) =>
      i === 1
        ? { ...option, variant: { original: '', changed: '' }, misunderstanding: '', previous: true }
        : { ...option, previous: false },
    ),
    previous: TS_BEFORE_COMMIT,
    ...overrides,
  };
}

/** Tests for a second question about pickNext: which of three jobs with different priorities runs. */
export const TS_URGENT_TESTS = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext } from './kata.ts';

const jobs = [{ id: 'first', priority: 1, at: 0 }, { id: 'urgent', priority: 5, at: 9 }, { id: 'last', priority: 3, at: 5 }];

describe('what runs next', () => {
  it('runs the urgent job', () => assert.equal(pickNext(jobs), 'urgent'));
  it('runs the first job submitted', () => assert.equal(pickNext(jobs), 'first'));
  it('runs the last job submitted', () => assert.equal(pickNext(jobs), 'last'));
  it('runs nothing', () => assert.equal(pickNext(jobs), undefined));
});
`;

/** A Series question that Verifies against TS_REFERENCE and asks something goodPrediction doesn't. */
export function urgentQuestion(overrides: Partial<SeriesQuestion> = {}): SeriesQuestion {
  const none = { original: '', changed: '' };
  return {
    slug: 'urgent-first',
    title: 'Does urgency beat arrival?',
    estimatedMinutes: 2,
    scenario: 'Three jobs are waiting: "first" (priority 1, submitted at midnight), "urgent" (priority 5, submitted at 9 o\'clock), and "last" (priority 3, submitted at 5 o\'clock). Which runs next?',
    options: [
      { text: 'The "urgent" job runs next.', testName: 'runs the urgent job', correct: true, variant: none, misunderstanding: '' },
      { text: 'The "first" job runs next.', testName: 'runs the first job submitted', correct: false, variant: { original: 'return best?.id;', changed: 'return jobs[0]?.id;' }, misunderstanding: 'You were picturing a plain first-come queue.' },
      { text: 'The "last" job runs next.', testName: 'runs the last job submitted', correct: false, variant: { original: 'return best?.id;', changed: 'return jobs[jobs.length - 1]?.id;' }, misunderstanding: 'You were picturing a stack: newest first.' },
      { text: 'Nothing runs.', testName: 'runs nothing', correct: false, variant: { original: 'return best?.id;', changed: 'return undefined;' }, misunderstanding: 'You were picturing a queue that waits for equal priorities.' },
    ],
    explanation: 'The highest priority always runs first, whenever it arrived.',
    testSuiteCode: TS_URGENT_TESTS,
    ...overrides,
  };
}

/** A Series about pickNext, sharing goodPrediction's unit, with the given questions. */
export function goodSeries(questions: SeriesQuestion[]): PredictionSeriesOutput {
  const { worthPracticing, notWorthReason, pillar, sourceAnchors, referenceSolution, originalDefect } = goodPrediction();
  return { worthPracticing, notWorthReason, pillar, sourceAnchors, referenceSolution, originalDefect, questions };
}

/** goodPrediction's question, as a Series question. */
export function tieQuestion(overrides: Partial<SeriesQuestion> = {}): SeriesQuestion {
  const { slug, title, estimatedMinutes, scenario, options, explanation, testSuiteCode } = goodPrediction();
  return { slug, title, estimatedMinutes, scenario, options, explanation, testSuiteCode, ...overrides };
}

/** Tests pinning each Cause's Symptom on one queue; the healthy code runs "early", so none passes against it. */
export const TS_DIAGNOSIS_TESTS = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext } from './kata.ts';

const jobs = [{ id: 'late', priority: 3, at: 2 }, { id: 'low', priority: 1, at: 0 }, { id: 'early', priority: 3, at: 1 }];

describe('what users see', () => {
  it('runs the late job', () => assert.equal(pickNext(jobs), 'late'));
  it('runs the low-priority job', () => assert.equal(pickNext(jobs), 'low'));
  it('runs no job', () => assert.equal(pickNext(jobs), undefined));
  it('reports the queue as full', () => assert.equal(pickNext(jobs), 'queue-full'));
});
`;

/** A Diagnosis that passes the Verified gate with the TypeScript profile: why a later job went first. */
export function goodDiagnosis(overrides: Partial<DiagnosisOutput> = {}): DiagnosisOutput {
  return {
    worthPracticing: true,
    notWorthReason: '',
    slug: 'late-job-first',
    title: 'A later job went first',
    pillar: 'algorithm',
    estimatedMinutes: 3,
    sourceAnchors: [{ startLine: 3, endLine: 9, explanation: 'The scheduler picks the next job here.' }],
    causes: [
      { text: 'Ties in priority go to the most recently submitted job.', symptom: 'Two jobs had the same priority, and the one submitted later ran first.', testName: 'runs the late job', correct: true, variant: { original: 'job.at < best.at', changed: 'job.at > best.at' } },
      { text: 'A lower priority number is treated as more urgent.', symptom: 'The job with the lowest priority of three ran first.', testName: 'runs the low-priority job', correct: false, variant: { original: 'job.priority > best.priority', changed: 'job.priority < best.priority' } },
      { text: 'A tie in priority clears the choice of job.', symptom: 'With three jobs waiting, nothing ran at all.', testName: 'runs no job', correct: false, variant: { original: ' best = job;', changed: ' best = best && job.priority === best.priority ? undefined : job;' } },
      { text: 'Queues of more than two jobs are refused.', symptom: 'With three jobs waiting, users were told the queue is full.', testName: 'reports the queue as full', correct: false, variant: { original: 'return best?.id;', changed: "return jobs.length > 2 ? 'queue-full' : best?.id;" } },
    ],
    explanation: 'When priorities tie, the arrival times decide; compared the wrong way round, the newest job wins.',
    referenceSolution: TS_REFERENCE,
    testSuiteCode: TS_DIAGNOSIS_TESTS,
    originalDefect: NO_DEFECT,
    ...overrides,
  };
}

/** A What-if on code whose ties go to the newest job (TS_BEFORE_COMMIT): what if the first job won them instead? */
export function goodWhatIf(overrides: Partial<WhatIfOutput> = {}): WhatIfOutput {
  return { ...goodCommitPrediction(), slug: 'ties-to-first', modelledAs: 'When two jobs tie on priority, the one that arrived first runs.', ...overrides };
}
