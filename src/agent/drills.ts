import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { parseTarget, repoRelative } from '../commands/drill.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { profileForFile } from '../languages/registry.ts';
import { preflight } from '../languages/run.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { MAX_STEPS, MIN_STEPS, TRACK_RULES } from '../explore/plan.ts';
import { repoRelativeDir, shortlist } from '../explore/shortlist.ts';
import { saveTrack, trackId, type TrackStep } from '../explore/tracks.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox, type Sandbox } from '../sandbox/sandbox.ts';
import { drillUserPrompt, MAX_SOURCE_LINES, systemPromptFor } from '../synthesis/prompt.ts';
import { checkWorkoutOutput, outputSchemaFor, type AnyWorkoutOutput, type WorkoutKind } from '../synthesis/schema.ts';
import { MAX_ATTEMPTS, SourceTooLargeError } from '../synthesis/synthesize.ts';
import { describeFailures, verify } from '../verify/gate.ts';
import { saveDrill, sourceRevision, type Origin } from '../workouts/save.ts';
import { listWorkouts, recordSpend, type Spend } from '../workouts/store.ts';
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
  /** The source as sent to the agent: a saved Drill's bug is looked for in it. */
  source: string;
  sourceLines: number;
  kind: WorkoutKind;
  quick: boolean;
  origin: Origin;
  submissions: number;
  /** Set when this Drill is a step of a Track being built. */
  track?: { id: string; why: string };
}

/** A Track an agent is building: its shortlist, and the steps saved so far, in order. */
interface PendingTrack {
  id: string;
  module: string;
  paths: WorkspacePaths;
  candidates: Set<string>;
  steps: TrackStep[];
  dropped: string[];
}

export interface PreparedTrack {
  trackId: string;
  repository: string;
  module: string;
  minSteps: number;
  maxSteps: number;
  /** How to choose and order the steps: the same rules Kintsugi's own planning uses. */
  rules: string;
  candidates: { path: string; lines: number; outline: string[] }[];
}

export type FinishedTrack =
  | { status: 'saved'; trackId: string; title: string; steps: TrackStep[]; dropped: string[]; next: string }
  | { status: 'not-enough'; workoutIds: string[]; dropped: string[]; message: string };

export interface PrepareRequest {
  target: string;
  /** A Drill (find the bug, the default) or a Kata (fill the gap). */
  kind?: WorkoutKind;
  quick?: boolean;
  origin?: Origin;
  /** Makes this Drill the next step of a Track started with prepareTrack. */
  trackId?: string;
  /** For a Track step: one line on why this file matters for the module. */
  why?: string;
}

export interface Prepared {
  generationId: string;
  repository: string;
  target: string;
  language: string;
  kind: WorkoutKind;
  quick: boolean;
  maxSubmissions: number;
  /** The rules for writing the Workout: the same system prompt Kintsugi's own generation uses. */
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
  readonly #tracks = new Map<string, PendingTrack>();
  #sandbox?: Promise<Sandbox>;

  constructor(options: AgentDrillsOptions) {
    this.#options = options;
  }

  async repository(): Promise<string> {
    return findRepoRoot(this.#options.cwd);
  }

  /** Starts a Track for a module: the shortlist and the ordering rules. The agent then prepares each step with its trackId. */
  async prepareTrack(modulePath: string): Promise<PreparedTrack> {
    const repoRoot = await this.repository();
    const module = repoRelativeDir(repoRoot, resolve(repoRoot, modulePath));
    if (module.startsWith('..')) throw new AgentRequestError(`${modulePath} is outside the repository at ${repoRoot}.`);
    if (module.split('/')[0] === '.kintsugi') throw new AgentRequestError('Explore the repository\'s own code, not the Kintsugi workspace.');
    const paths = workspacePaths(repoRoot);
    await ensureWorkspace(paths);
    await excludeWorkspaceFromGit(repoRoot);
    const config = resolveConfig(await loadRepoConfig(paths.configFile), await loadUserConfig(this.#configEnv()));
    const candidates = await shortlist(repoRoot, module, config.profiles);
    if (candidates.length < MIN_STEPS) {
      throw new AgentRequestError(`${module || 'The repository'} has ${candidates.length} source file(s) worth drilling; a Track needs at least ${MIN_STEPS}.`);
    }
    const id = await trackId(paths, module, this.#now());
    this.#tracks.set(id, { id, module, paths, candidates: new Set(candidates.map((c) => c.path)), steps: [], dropped: [] });
    return {
      trackId: id,
      repository: repoRoot,
      module,
      minSteps: MIN_STEPS,
      maxSteps: MAX_STEPS,
      rules: TRACK_RULES,
      candidates: candidates.map(({ path, lines, outline }) => ({ path, lines, outline })),
    };
  }

  /** Saves the Track once at least MIN_STEPS of its steps are Verified; otherwise its Drills stay ordinary Workouts. */
  async finishTrack(id: string, title: string): Promise<FinishedTrack> {
    const pending = this.#tracks.get(id);
    if (!pending) throw new AgentRequestError(`Unknown track id "${id}". Call prepare_track to start a Track.`);
    if (title.trim() === '') throw new AgentRequestError('Give the Track a short title naming what the module does.');
    this.#tracks.delete(id);
    if (pending.steps.length < MIN_STEPS) {
      return {
        status: 'not-enough',
        workoutIds: pending.steps.map((s) => s.workoutId),
        dropped: pending.dropped,
        message: `Only ${pending.steps.length} step(s) were Verified; a Track needs ${MIN_STEPS}. The Verified Drills stay as ordinary Workouts.`,
      };
    }
    await saveTrack(pending.paths, { id, title: title.trim(), module: pending.module, createdAt: this.#now().toISOString(), generator: 'agent', steps: pending.steps });
    return { status: 'saved', trackId: id, title: title.trim(), steps: pending.steps, dropped: pending.dropped, next: `The user starts it with: kin track ${id}` };
  }

  async prepare({ target, kind = 'drill', quick = false, origin = 'manual', trackId: forTrack, why }: PrepareRequest): Promise<Prepared> {
    const repoRoot = await this.repository();
    const { file, symbol } = parseTarget(repoRoot, target);
    const sourcePath = repoRelative(repoRoot, file);
    let pendingTrack: PendingTrack | undefined;
    if (forTrack) {
      if (kind !== 'drill') throw new AgentRequestError('Track steps are Drills: leave out `kind`, or prepare the Kata on its own.');
      pendingTrack = this.#tracks.get(forTrack);
      if (!pendingTrack) throw new AgentRequestError(`Unknown track id "${forTrack}". Call prepare_track to start a Track.`);
      if (!why?.trim()) throw new AgentRequestError('A Track step needs `why`: one line on why this file matters for the module.');
      if (!pendingTrack.candidates.has(sourcePath)) throw new AgentRequestError(`${sourcePath} is not one of the Track's candidate files.`);
      if (pendingTrack.steps.some((s) => s.path === sourcePath)) throw new AgentRequestError(`${sourcePath} is already a step of this Track: each step is a different file.`);
      if (pendingTrack.steps.length >= MAX_STEPS) throw new AgentRequestError(`The Track already has ${MAX_STEPS} steps: call finish_track.`);
      // Track steps are a curriculum, never Quick.
      origin = 'explore';
      quick = false;
    }
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
    // Check the sandbox and toolchain (and warm its cache) before the agent spends effort on a Drill.
    await preflight(await this.#openSandbox(), profile, this.#options.cacheRoot);

    const generationId = randomUUID();
    this.#generations.set(generationId, {
      paths,
      profile,
      sourcePath,
      symbol,
      source,
      sourceLines,
      kind,
      quick,
      origin,
      submissions: 0,
      ...(pendingTrack ? { track: { id: pendingTrack.id, why: why!.trim() } } : {}),
    });
    return {
      generationId,
      repository: repoRoot,
      target: sourcePath,
      language: profile.id,
      kind,
      quick,
      maxSubmissions: MAX_ATTEMPTS,
      instructions: systemPromptFor(kind, profile, { quick }),
      source: drillUserPrompt({
        path: sourcePath,
        source,
        symbol,
        ...(pendingTrack ? { track: { module: pendingTrack.module, step: pendingTrack.steps.length + 1, why: why!.trim() } } : {}),
      }, kind),
      workoutSchema: z.toJSONSchema(outputSchemaFor(kind)),
    };
  }

  async submit(generationId: string, workout: AnyWorkoutOutput): Promise<Submitted> {
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

    const dropFromTrack = (reason: string) => {
      if (generation.track) this.#tracks.get(generation.track.id)?.dropped.push(`${generation.sourcePath}: ${reason}`);
    };
    if (!workout.worthPracticing) {
      this.#generations.delete(generationId);
      dropFromTrack('not worth practicing');
      await record('not-worth-practicing');
      return { status: 'not-worth-practicing', reason: workout.notWorthReason || 'No reason given.' };
    }

    const reject = async (feedback: string): Promise<Submitted> => {
      if (finished) {
        this.#generations.delete(generationId);
        dropFromTrack('no Verified Drill');
        await record('not-verified');
      }
      return { status: 'rejected', feedback, submissionsLeft: MAX_ATTEMPTS - generation.submissions };
    };

    const problems = checkWorkoutOutput(generation.kind, workout, generation.sourceLines, { quick: generation.quick, lineComment: generation.profile.lineComment });
    if (problems.length > 0) return reject(problems.map((p) => `[schema] ${p}`).join('\n'));

    const verification = await verify(
      {
        kind: generation.kind,
        quick: generation.quick,
        startingCode: workout.startingCode,
        referenceSolution: workout.referenceSolution,
        testSuiteCode: workout.testSuiteCode,
        regressionTestName: workout.regressionTestName,
        options: workout.options,
        source: generation.source,
        lineComment: generation.profile.lineComment,
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
      kind: generation.kind,
      sourcePath: generation.sourcePath,
      symbol: generation.symbol,
      source: generation.source,
      revision: await sourceRevision(generation.paths.repoRoot, generation.sourcePath),
      generationAttempts: generation.submissions,
      generator: 'agent',
      origin: generation.origin,
      ...(generation.track ? { track: { id: generation.track.id, module: this.#tracks.get(generation.track.id)?.module ?? '', why: generation.track.why } } : {}),
      now: this.#now(),
    });
    await record('verified', saved.id);
    if (generation.track) {
      this.#tracks.get(generation.track.id)?.steps.push({ workoutId: saved.id, path: generation.sourcePath, pillar: workout.pillar, why: generation.track.why });
    }
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
    return (await listWorkouts(paths)).map(({ record, status }) => ({
      id: record.id,
      status,
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
    // The queue is Workouts nobody has attempted yet (and that aren't discarded).
    const queued = (await listWorkouts(paths)).filter((w) => w.status === 'queued' && w.record.origin === 'agent-task');
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
