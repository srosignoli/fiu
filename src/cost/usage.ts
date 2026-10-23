import { priceFor, PRICES_AS_OF, type ModelPrice } from './prices.ts';

/** Tokens one model used. Input tokens exclude cache reads and writes. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The token usage of something that cost money, with its estimated price. */
export interface Cost {
  usage: ModelUsage[];
  /** Estimated US dollars for the models with a known price. */
  usd: number;
  /** Models with no known price: their usage isn't in `usd`. */
  unpricedModels: string[];
  pricesAsOf: string;
}

/** The parts of an AI SDK result (or NoObjectGeneratedError) that carry usage. */
export interface UsageSource {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  response?: { modelId?: string };
  providerMetadata?: Record<string, Record<string, unknown> | undefined>;
}

interface AnthropicIteration {
  type: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Usage per model for one LLM call. When Anthropic's server-side fallback answered, the per-iteration
 * usage attributes tokens to each model that ran; otherwise everything belongs to the model that answered.
 */
export function usageOf(source: UsageSource, requestedModel: string): ModelUsage[] {
  const iterations = source.providerMetadata?.anthropic?.iterations as AnthropicIteration[] | null | undefined;
  if (iterations?.some((iteration) => iteration.type === 'fallback_message')) {
    return mergeByModel(
      iterations.map((iteration) => ({
        model: iteration.model ?? requestedModel,
        inputTokens: iteration.inputTokens,
        outputTokens: iteration.outputTokens,
        cacheReadTokens: iteration.cacheReadInputTokens ?? 0,
        cacheWriteTokens: iteration.cacheCreationInputTokens ?? 0,
      })),
    );
  }
  const usage = source.usage;
  if (!usage) return [];
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const inputTokens = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
  return [
    {
      model: source.response?.modelId ?? requestedModel,
      inputTokens,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens,
      cacheWriteTokens,
    },
  ];
}

export function mergeByModel(usages: ModelUsage[]): ModelUsage[] {
  const merged = new Map<string, ModelUsage>();
  for (const usage of usages) {
    const total = merged.get(usage.model) ?? { model: usage.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    merged.set(usage.model, total);
  }
  return [...merged.values()];
}

export function estimateCost(usages: ModelUsage[], overrides: Record<string, ModelPrice> = {}): Cost {
  const usage = mergeByModel(usages);
  let usd = 0;
  const unpricedModels: string[] = [];
  for (const u of usage) {
    const price = priceFor(u.model, overrides);
    if (!price) {
      unpricedModels.push(u.model);
      continue;
    }
    const cacheRead = price.cacheRead ?? price.input * 0.1;
    const cacheWrite = price.cacheWrite ?? price.input * 1.25;
    usd += (u.inputTokens * price.input + u.outputTokens * price.output + u.cacheReadTokens * cacheRead + u.cacheWriteTokens * cacheWrite) / 1e6;
  }
  return { usage, usd, unpricedModels, pricesAsOf: PRICES_AS_OF };
}

export const totalTokens = (cost: Cost) =>
  cost.usage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0);

/** "≈ $0.38", or "52,310 tokens (cost unknown for gpt-x)" when no price is known. */
export function describeCost(cost: Cost): string {
  if (cost.unpricedModels.length === 0) return `≈ ${formatUsd(cost.usd)}`;
  const unknown = `cost unknown for ${cost.unpricedModels.join(', ')}`;
  const priced = cost.usage.length > cost.unpricedModels.length;
  return priced ? `≈ ${formatUsd(cost.usd)} + more (${unknown})` : `${totalTokens(cost).toLocaleString('en-US')} tokens (${unknown})`;
}

export function formatUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
