import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parseTarget, repoRelative } from '../commands/drill.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { profileForFile } from '../languages/registry.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox, type Sandbox } from '../sandbox/sandbox.ts';
import { drillSystemPrompt, drillUserPrompt, MAX_SOURCE_LINES } from '../synthesis/prompt.ts';
import { checkDrillOutput, DrillOutputSchema, type DrillOutput } from '../synthesis/schema.ts';
import { MAX_ATTEMPTS, SourceTooLargeError } from '../synthesis/synthesize.ts';
import { describeFailures, verify } from '../verify/gate.ts';
import { saveDrill, sourceRevision, type Origin } from '../workouts/save.ts';
import { listPending, recordSpend, type Spend } from '../workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths, type WorkspacePaths } from '../workspace.ts';

/** At most this many queued Workouts from agent tasks, so an agent finishing many tasks can't flood the queue. */
export const AGENT_TASK_QUEUE_CAP = 3;

/** A refusal the agent should read and act on (as opposed to a bug in Kintsugi). */
export class AgentRequestError extends Error {}

interface Generation {
  paths: WorkspacePaths;
  profile: LanguageProfile;
  sourcePath: string;
  symbol?: string;
  sourceLines: number;
  quick: boolean;
  origin: Origin;
  submissions: number;
}

export interface PrepareRequest {
  target: string;
  quick?: boolean;
  origin?: Origin;
}

export interface Prepared {
  generationId: string;
  repository: string;
  target: string;
  language: string;
  quick: boolean;
  maxSubmissions: number;
  /** The rules for writing the Drill: the same system prompt Kintsugi's own generation uses. */
  instructions: string;
  /** The source file with numbered lines (for sourceAnchors), and the unit to build around if one was pinned. */
  source: string;
  /** The shape submit_drill expects, as JSON Schema. */
  workoutSchema: unknown;
}

export type Submitted =
  | { status: 'saved'; workoutId: string; title: string; workoutDir: string; submissions: number }
  | { status: 'rejected'; feedback: string; submissionsLeft: number }
  | { status: 'not-worth-practicing'; reason: string };

export interface AgentDrillsOptions {
  /** Where the agent works: Kintsugi only acts inside the git repository containing it. */
  cwd: string;
  configEnv?: ConfigEnv;
  cacheRoot?: string;
  now?: () => Date;
}

/**
 * Agent mode: the user's coding agent writes the Drill, Kintsugi verifies and saves it. The same
 * prompt, schema, Verified gate, and sandbox as Kintsugi's own generation; the retry loop runs in the
 * agent, capped at the same number of submissions. Workout code never runs unsandboxed here.
 */
export class AgentDrills {
  readonly #options: AgentDrillsOptions;
  readonly #generations = new Map<string, Generation>();
  #sandbox?: Promise<Sandbox>;

  constructor(options: AgentDrillsOptions) {
    this.#options = options;
  }

  async repository(): Promise<string> {
    return findRepoRoot(this.#options.cwd);
  }

  async prepare({ target, quick = false, origin = 'manual' }: PrepareRequest): Promise<Prepared> {
    const repoRoot = await this.repository();
    const { file, symbol } = parseTarget(repoRoot, target);
    const sourcePath = repoRelative(repoRoot, file);
    const paths = workspacePaths(repoRoot);
    // Every generation ends in the spend ledger, so the workspace must exist from the start.
    await ensureWorkspace(paths);
    await excludeWorkspaceFromGit(repoRoot);
    const config = resolveConfig(await loadRepoConfig(paths.configFile), await loadUserConfig(this.#configEnv()));
    const profile = profileForFile(file, config.profiles);
    const source = await readFile(file, 'utf8');
    const sourceLines = source.replace(/\n$/, '').split('\n').length;
    if (sourceLines > MAX_SOURCE_LINES) throw new SourceTooLargeError(sourcePath, sourceLines);
    if (origin === 'agent-task') await this.#checkAgentTaskQueue(paths, sourcePath);

    const generationId = randomUUID();
    this.#generations.set(generationId, { paths, profile, sourcePath, symbol, sourceLines, quick, origin, submissions: 0 });
    return {
      generationId,
      repository: repoRoot,
      target: sourcePath,
      language: profile.id,
      quick,
      maxSubmissions: MAX_ATTEMPTS,
      instructions: drillSystemPrompt(profile, { quick }),
      source: drillUserPrompt({ path: sourcePath, source, symbol }),
      workoutSchema: z.toJSONSchema(DrillOutputSchema),
    };
  }

  async submit(generationId: string, workout: DrillOutput): Promise<Submitted> {
    const generation = this.#generations.get(generationId);
    if (!generation) throw new AgentRequestError(`Unknown generation id "${generationId}". Call prepare_drill to start a new generation.`);
    // A missing sandbox is not the agent's fault, so it doesn't use up a submission.
    const sandbox = await this.#openSandbox();

    generation.submissions++;
    const finished = generation.submissions >= MAX_ATTEMPTS;
    const record = (result: Spend['result'], workoutId?: string) =>
      recordSpend(generation.paths, {
        at: this.#now().toISOString(),
        origin: generation.origin,
        generator: 'agent',
        source: generation.sourcePath,
        result,
        ...(workoutId ? { workoutId } : {}),
        generationAttempts: generation.submissions,
        cost: null,
      });

    if (!workout.worthPracticing) {
      this.#generations.delete(generationId);
      await record('not-worth-practicing');
      return { status: 'not-worth-practicing', reason: workout.notWorthReason || 'No reason given.' };
    }

    const reject = async (feedback: string): Promise<Submitted> => {
      if (finished) {
        this.#generations.delete(generationId);
        await record('not-verified');
      }
      return { status: 'rejected', feedback, submissionsLeft: MAX_ATTEMPTS - generation.submissions };
    };

    const problems = checkDrillOutput(workout, generation.sourceLines, { quick: generation.quick });
    if (problems.length > 0) return reject(problems.map((p) => `[schema] ${p}`).join('\n'));

    const verification = await verify(
      {
        kind: 'drill',
        startingCode: workout.startingCode,
        referenceSolution: workout.referenceSolution,
        testSuiteCode: workout.testSuiteCode,
        regressionTestName: workout.regressionTestName,
      },
      generation.profile,
      sandbox,
      { cacheRoot: this.#options.cacheRoot },
    );
    if (!verification.verified) return reject(describeFailures(verification.failures));

    // The queue may have filled while the agent was working.
    if (generation.origin === 'agent-task') await this.#checkAgentTaskQueue(generation.paths, generation.sourcePath);
    this.#generations.delete(generationId);
    const saved = await saveDrill({
      paths: generation.paths,
      profile: generation.profile,
      drill: workout,
      sourcePath: generation.sourcePath,
      symbol: generation.symbol,
      revision: await sourceRevision(generation.paths.repoRoot, generation.sourcePath),
      generationAttempts: generation.submissions,
      generator: 'agent',
      origin: generation.origin,
      now: this.#now(),
    });
    await record('verified', saved.id);
    return {
      status: 'saved',
      workoutId: saved.id,
      title: saved.title,
      workoutDir: join(generation.paths.workoutsDir, saved.id),
      submissions: generation.submissions,
    };
  }

  async list() {
    const paths = workspacePaths(await this.repository());
    return (await listPending(paths)).map(({ record }) => ({
      id: record.id,
      title: record.title,
      language: record.language,
      source: record.source.path,
      estimatedMinutes: record.estimatedMinutes,
      origin: record.origin ?? 'manual',
      generator: record.generator ?? 'kintsugi',
    }));
  }

  async close(): Promise<void> {
    const sandbox = this.#sandbox;
    this.#sandbox = undefined;
    if (sandbox) await (await sandbox).dispose();
  }

  async #checkAgentTaskQueue(paths: WorkspacePaths, sourcePath: string): Promise<void> {
    const queued = (await listPending(paths)).filter((w) => w.record.origin === 'agent-task');
    if (queued.length >= AGENT_TASK_QUEUE_CAP) {
      throw new AgentRequestError(`The queue already holds ${queued.length} Drills from agent tasks. Skip generating one this time.`);
    }
    if (queued.some((w) => w.record.source.path === sourcePath)) {
      throw new AgentRequestError(`${sourcePath} already has a queued Drill from an agent task. Skip generating one this time.`);
    }
  }

  /** Opened once and kept for the server's lifetime. Never unsandboxed: an agent must not be able to switch isolation off. */
  #openSandbox(): Promise<Sandbox> {
    this.#sandbox ??= (async () => {
      const repoRoot = await this.repository();
      const sandbox = await openSandbox({ repoRoot });
      try {
        await verifySandbox(sandbox, this.#options.cacheRoot ? { cacheDir: this.#options.cacheRoot } : {});
      } catch (error) {
        await sandbox.dispose();
        throw error;
      }
      return sandbox;
    })().catch((error) => {
      // Let a later call try again (e.g. after the user installs the missing dependency).
      this.#sandbox = undefined;
      throw error;
    });
    return this.#sandbox;
  }

  #configEnv(): ConfigEnv {
    return this.#options.configEnv ?? { env: process.env, home: homedir() };
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}
