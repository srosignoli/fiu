import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { priceFor } from '../src/cost/prices.ts';
import { describeCost, estimateCost, usageOf, type ModelUsage } from '../src/cost/usage.ts';

const usage = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): ModelUsage => ({
  model,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

describe('priceFor', () => {
  it('knows Anthropic list prices, ignoring date snapshot suffixes', () => {
    assert.deepEqual(priceFor('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 });
    assert.equal(priceFor('claude-haiku-4-5-20251001')?.input, 1);
    assert.equal(priceFor('gpt-5'), undefined, 'other providers are not guessed');
  });

  it('lets config override or add prices', () => {
    assert.equal(priceFor('claude-opus-5-5', { 'claude-opus-5-5': { input: 1, output: 2 } })?.input, 1);
    assert.equal(priceFor('gpt-5', { 'gpt-5': { input: 1.25, output: 10 } })?.output, 10);
  });
});

describe('usageOf', () => {
  it('splits cached input from fresh input', () => {
    const result = {
      usage: { inputTokens: 1500, outputTokens: 300, inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 400, cacheWriteTokens: 100 } },
      response: { modelId: 'claude-opus-5-5' },
    };
    assert.deepEqual(usageOf(result, 'requested'), [usage('claude-opus-5-5', 1000, 300, 400, 100)]);
  });

  it('falls back to the requested model and derives fresh input when details are missing', () => {
    assert.deepEqual(usageOf({ usage: { inputTokens: 50, outputTokens: 5 } }, 'claude-sonnet-5-5'), [usage('claude-sonnet-5-5', 50, 5)]);
    assert.deepEqual(usageOf({}, 'x'), []);
  });

  it('attributes a refusal fallback to each model that ran', () => {
    const result = {
      usage: { inputTokens: 999, outputTokens: 999 },
      response: { modelId: 'claude-opus-4-8' },
      providerMetadata: {
        anthropic: {
          iterations: [
            { type: 'message', inputTokens: 1000, outputTokens: 50 },
            { type: 'fallback_message', model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 400, cacheReadInputTokens: 10 },
          ],
        },
      },
    };
    assert.deepEqual(usageOf(result, 'claude-opus-5-5'), [usage('claude-opus-5-5', 1000, 50), usage('claude-opus-4-8', 1000, 400, 10)]);
  });
});

describe('estimateCost', () => {
  it('prices each model, defaulting cache reads to 10% and writes to 125% of input', () => {
    const cost = estimateCost([usage('claude-opus-5-5', 1_000_000, 100_000, 1_000_000), usage('claude-opus-4-8', 0, 0, 1_000_000, 1_000_000)]);
    // Opus 5.5: $4 input + $2 output + $0.20 cache read; Opus 4.8: $0.50 cache read + $6.25 cache write.
    assert.equal(cost.usd.toFixed(2), '12.95');
    assert.deepEqual(cost.unpricedModels, []);
  });

  it('merges calls by model and flags unpriced usage', () => {
    const cost = estimateCost([usage('claude-sonnet-5-5', 500_000, 0), usage('claude-sonnet-5-5', 500_000, 0), usage('gpt-5', 10, 10)]);
    assert.equal(cost.usage.length, 2);
    assert.equal(cost.usd, 2);
    assert.deepEqual(cost.unpricedModels, ['gpt-5']);
  });
});

describe('describeCost', () => {
  it('shows dollars, partial dollars, or tokens when nothing is priced', () => {
    assert.equal(describeCost(estimateCost([usage('claude-opus-5-5', 10_000, 20_000)])), '≈ $0.44');
    assert.equal(describeCost(estimateCost([usage('claude-haiku-5-5', 1000, 1000)])), '≈ $0.0006');
    assert.equal(describeCost(estimateCost([usage('gpt-5', 40_000, 12_310)])), '52,310 tokens (cost unknown for gpt-5)');
    assert.equal(
      describeCost(estimateCost([usage('claude-opus-5-5', 10_000, 20_000), usage('gpt-5', 1, 1)])),
      '≈ $0.44 + more (cost unknown for gpt-5)',
    );
  });
});
