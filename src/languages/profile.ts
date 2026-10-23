import { z } from 'zod';

export type ResultFormat = 'tap' | 'junit-xml' | 'go-json' | 'unittest-verbose';

/** Everything Kintsugi needs to build and run Workouts in one language. Pure data: no language logic lives elsewhere. */
export interface LanguageProfile {
  id: string;
  /** Matched against the drilled source file. */
  extensions: string[];
  codeFilename: string;
  testFilename: string;
  /** Extra files every Workout in this language needs, e.g. Go's go.mod. */
  supportFiles: Record<string, string>;
  /** Language-specific generation constraints for the LLM prompt. */
  promptRules: string;
  /** Cheap toolchain check, run before any LLM call. */
  preflightCmd: string;
  /** Runs the tests once in the Workout directory. */
  testCmd: string;
  resultFormat: ResultFormat;
  /** Where the results are written, relative to the Workout directory; stdout when absent. */
  resultFile?: string;
  /** Added to the scrubbed environment. */
  env: Record<string, string>;
  /** Env vars pointed at persistent per-user cache directories, e.g. GOCACHE. */
  cacheDirs: string[];
  /** Sandbox allowances. There is deliberately no way to allow network access. */
  extraReadPaths: string[];
  extraWritePaths: string[];
}

export type TestOutcome = 'pass' | 'assertion-failure' | 'error';

export interface TestResult {
  name: string;
  outcome: TestOutcome;
}

/** A test run, normalised across languages. */
export interface TestRun {
  /** False when the tests never got to run: compile, syntax, or import failure, or a timeout. */
  ran: boolean;
  tests: TestResult[];
  /** The runner's combined output, for humans and for LLM retry feedback. */
  output: string;
}

const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'must be a path inside the Workout directory');

/** A profile declared in config. Only machine-readable, language-neutral result formats are allowed. */
export const UserProfileSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, and dashes'),
  extensions: z.array(z.string().regex(/^\.[\w.-]+$/, 'like ".rs"')).min(1),
  codeFilename: relativePath,
  testFilename: relativePath,
  supportFiles: z.record(relativePath, z.string()).default({}),
  promptRules: z.string().default(''),
  preflightCmd: z.string().min(1),
  testCmd: z.string().min(1),
  resultFormat: z.enum(['tap', 'junit-xml']),
  resultFile: relativePath.optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  cacheDirs: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  extraReadPaths: z.array(z.string().startsWith('/', 'must be absolute')).default([]),
  extraWritePaths: z.array(z.string().startsWith('/', 'must be absolute')).default([]),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;
