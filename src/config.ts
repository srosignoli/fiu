import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_SERIES_QUESTIONS } from './synthesis/schema.ts';
import { ModelPriceSchema, type ModelPrice } from './cost/prices.ts';
import { UserProfileSchema, type LanguageProfile } from './languages/profile.ts';
import { profiles } from './languages/registry.ts';

export const PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

/** Background generation's caps when config doesn't set them (§11.2.4). */
export const AUTO_DEFAULTS = { queueCap: 3, dailyLimit: 5, aiOnly: false, expiryDays: 14 };

export const DEFAULTS = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
} as const satisfies Partial<ResolvedConfig>;

/** The kinds `fiu quick` can favour and commits can become (Katas are made on request only; commits never become Diagnoses). */
export const KindsSchema = z.array(z.enum(['drill', 'prediction', 'diagnosis'])).min(1);
export type PreferredKind = z.infer<typeof KindsSchema>[number];

/** `.fiu/config.json`: lives inside the repo, so it must never hold secrets. */
export const RepoConfigSchema = z.strictObject({
  provider: ProviderSchema.optional(),
  model: z.string().min(1).optional(),
  consent: z
    .strictObject({
      provider: ProviderSchema,
      grantedAt: z.iso.datetime(),
    })
    .optional(),
  profiles: z.array(UserProfileSchema).optional(),
  prices: z.record(z.string(), ModelPriceSchema).optional(),
  /** Overrides the user's `kinds` for this repository. */
  kinds: KindsSchema.optional(),
  /** False turns off "Around this code" in new Workouts' READMEs (default on, §11.15). */
  context: z.boolean().optional(),
  /** False stops Fiu reading Understand-Anything's knowledge graph when the repository has one (default on, ADR 0010). */
  understandAnything: z.boolean().optional(),
  /** Team sharing: the remote the `fiu/workouts` branch lives on (default `origin`). */
  share: z.strictObject({ remote: z.string().min(1).optional() }).optional(),
  /** Background generation from commits (`fiu auto on`): its consent and caps. */
  auto: z
    .strictObject({
      enabled: z.boolean(),
      /** When the user consented to background spending with these caps. */
      consentedAt: z.iso.datetime().optional(),
      queueCap: z.number().int().positive().optional(),
      dailyLimit: z.number().int().positive().optional(),
      aiOnly: z.boolean().optional(),
      expiryDays: z.number().int().positive().optional(),
    })
    .optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/** `~/.config/fiu/config.json`: the only file allowed to hold API keys. */
export const UserConfigSchema = z.strictObject({
  provider: ProviderSchema.optional(),
  model: z.string().min(1).optional(),
  apiKeys: z.partialRecord(ProviderSchema, z.string().min(1)).optional(),
  profiles: z.array(UserProfileSchema).optional(),
  prices: z.record(z.string(), ModelPriceSchema).optional(),
  /** What you'd rather practise, first choice first: commits become the first kind that fits, and `fiu quick` serves it first. */
  kinds: KindsSchema.optional(),
  /** How many questions `fiu predict` asks about a unit: a Series (§11.11). */
  predictionQuestions: z.number().int().min(1).max(MAX_SERIES_QUESTIONS).optional(),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

export interface ResolvedConfig {
  provider: Provider;
  model: string;
  /** Built-in Language Profiles plus those declared in either config. */
  profiles: LanguageProfile[];
  /** Per-model price overrides (US dollars per million tokens), repo over user. */
  prices: Record<string, ModelPrice>;
  /** Preferred kinds, first choice first: a preference with fallbacks, never a filter. Repo over user. */
  kinds: PreferredKind[];
  /** Questions per `fiu predict`: the user's setting, else DEFAULT_PREDICTION_QUESTIONS. */
  predictionQuestions: number;
  /** Whether new Drills and Katas get "Around this code" (§11.15): the repository's setting, else on. */
  context: boolean;
}

/** Three questions cost about 1.5 to 1.7 times one: past that, Scenarios on one unit start to repeat. */
export const DEFAULT_PREDICTION_QUESTIONS = 3;

export class ConfigError extends Error {}

export interface ConfigEnv {
  env: NodeJS.ProcessEnv;
  home: string;
}

const processConfigEnv = (): ConfigEnv => ({ env: process.env, home: homedir() });

export function userConfigPath({ env, home }: ConfigEnv = processConfigEnv()): string {
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'fiu', 'config.json');
}

export function userCacheDir({ env, home }: ConfigEnv = processConfigEnv()): string {
  const base = env.XDG_CACHE_HOME || join(home, '.cache');
  return join(base, 'fiu');
}

export async function loadRepoConfig(configFile: string): Promise<RepoConfig> {
  const raw = await readJson(configFile);
  if (raw === undefined) return {};
  if (typeof raw === 'object' && raw !== null && 'apiKeys' in raw) {
    throw new ConfigError(
      `${configFile} must not contain API keys: it lives inside your repository. ` +
        `Use an environment variable or ${userConfigPath()} instead.`,
    );
  }
  return parse(RepoConfigSchema, raw, configFile);
}

export async function loadUserConfig(configEnv: ConfigEnv = processConfigEnv()): Promise<UserConfig> {
  const path = userConfigPath(configEnv);
  const raw = await readJson(path);
  return raw === undefined ? {} : parse(UserConfigSchema, raw, path);
}

/** Non-secret settings: repo config wins over user config, which wins over defaults. */
export function resolveConfig(repo: RepoConfig, user: UserConfig): ResolvedConfig {
  return {
    provider: repo.provider ?? user.provider ?? DEFAULTS.provider,
    model: repo.model ?? user.model ?? DEFAULTS.model,
    profiles: profiles(repo.profiles, user.profiles),
    prices: { ...user.prices, ...repo.prices },
    kinds: repo.kinds ?? user.kinds ?? ['drill'],
    predictionQuestions: user.predictionQuestions ?? DEFAULT_PREDICTION_QUESTIONS,
    context: repo.context ?? true,
  };
}

async function readJson(path: string): Promise<unknown> {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function parse<T>(schema: z.ZodType<T>, raw: unknown, path: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`${path} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
