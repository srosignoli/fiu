import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

export const DEFAULTS = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
} as const satisfies ResolvedConfig;

/** `.kintsugi/config.json`: lives inside the repo, so it must never hold secrets. */
export const RepoConfigSchema = z.strictObject({
  provider: ProviderSchema.optional(),
  model: z.string().min(1).optional(),
  consent: z
    .strictObject({
      provider: ProviderSchema,
      grantedAt: z.iso.datetime(),
    })
    .optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/** `~/.config/kintsugi/config.json`: the only file allowed to hold API keys. */
export const UserConfigSchema = z.strictObject({
  provider: ProviderSchema.optional(),
  model: z.string().min(1).optional(),
  apiKeys: z.partialRecord(ProviderSchema, z.string().min(1)).optional(),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

export interface ResolvedConfig {
  provider: Provider;
  model: string;
}

export class ConfigError extends Error {}

export interface ConfigEnv {
  env: NodeJS.ProcessEnv;
  home: string;
}

const processConfigEnv = (): ConfigEnv => ({ env: process.env, home: homedir() });

export function userConfigPath({ env, home }: ConfigEnv = processConfigEnv()): string {
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'kintsugi', 'config.json');
}

export function userCacheDir({ env, home }: ConfigEnv = processConfigEnv()): string {
  const base = env.XDG_CACHE_HOME || join(home, '.cache');
  return join(base, 'kintsugi');
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
