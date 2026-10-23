import { z } from 'zod';

/** US dollars per million tokens. */
export const ModelPriceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /** Defaults to 10% of `input`. */
  cacheRead: z.number().nonnegative().optional(),
  /** Defaults to 125% of `input` (5-minute cache writes). */
  cacheWrite: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** When the built-in table was last checked. Shown next to every estimate. */
export const PRICES_AS_OF = '2026-10';

/**
 * Anthropic first-party API list prices. Other providers' models are left out rather than guessed:
 * users add them (or correct these) under `"prices"` in config.
 */
export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Prompts over 100K tokens cost more; Workout prompts stay far below that.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** The price for a model id, ignoring a trailing date snapshot suffix such as `-20251001`. Config overrides win. */
export function priceFor(model: string, overrides: Record<string, ModelPrice> = {}): ModelPrice | undefined {
  const base = model.replace(/-\d{8}$/, '');
  return overrides[model] ?? overrides[base] ?? BUILTIN_PRICES[model] ?? BUILTIN_PRICES[base];
}
