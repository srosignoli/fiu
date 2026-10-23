import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { generateText, LanguageModel } from 'ai';
import type { Provider } from '../config.ts';

/** Provider-specific request options, keyed by provider name as the AI SDK expects. */
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

export interface ModelChoice {
  model: LanguageModel;
  providerOptions: ProviderOptions;
}

const SUPPORTS_ADAPTIVE_FALLBACKS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

export function createModel(provider: Provider, modelId: string, apiKey: string): ModelChoice {
  switch (provider) {
    case 'anthropic':
      return {
        model: createAnthropic({ apiKey })(modelId),
        // Drill design is intelligence-sensitive coding work. On a safety refusal, the API retries the
        // same request on a fallback model it chooses ("default"). Older models a user configures may
        // reject these settings, so they get the provider defaults.
        providerOptions: SUPPORTS_ADAPTIVE_FALLBACKS.test(modelId)
          ? { anthropic: { thinking: { type: 'adaptive' }, effort: 'high', fallbacks: 'default' } }
          : {},
      };
    case 'openai':
      return { model: createOpenAI({ apiKey })(modelId), providerOptions: {} };
    case 'google':
      return { model: createGoogle({ apiKey })(modelId), providerOptions: {} };
  }
}
