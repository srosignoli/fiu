/** The \`auto\` setting in the repository's config: background generation, with any limits the team set. */
export interface AutoSettings {
  enabled: boolean;
  queueCap?: number;
  dailyLimit?: number;
  aiOnly?: boolean;
  expiryDays?: number;
}

export interface RepoConfig {
  auto?: AutoSettings;
}

/** Background generation's caps when config doesn't set them. */
export const AUTO_DEFAULTS = { queueCap: 3, dailyLimit: 5, aiOnly: false, expiryDays: 14 };

/** The caps in force: config values over the defaults (and nothing else from the \`auto\` setting). */
export function autoCaps(repoConfig: RepoConfig): typeof AUTO_DEFAULTS {
  const auto: Partial<AutoSettings> = repoConfig.auto ?? {};
  return {
    queueCap: auto.queueCap ?? AUTO_DEFAULTS.queueCap,
    dailyLimit: auto.dailyLimit ?? AUTO_DEFAULTS.dailyLimit,
    aiOnly: auto.aiOnly ?? AUTO_DEFAULTS.aiOnly,
    expiryDays: auto.expiryDays ?? AUTO_DEFAULTS.expiryDays,
  };
}
