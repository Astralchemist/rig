// SPDX-License-Identifier: Apache-2.0
// Model prices from OpenRouter's public catalogue (no key needed). Used for
// the --dry-run estimate and to cost Anthropic-direct runs, whose replies
// carry token counts but no price.

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface PriceTier {
  // Applies when a call's prompt has at least this many tokens.
  min_prompt_tokens: number;
  // USD per token.
  prompt: number;
  completion: number;
}

export interface ModelPricing {
  id: string;
  canonical: string | null;
  // Ascending by min_prompt_tokens; the first tier starts at 0.
  tiers: PriceTier[];
  // Whether the catalogue lists `tools` among the model's supported
  // parameters; undefined when the entry doesn't say.
  tools?: boolean;
  // The catalogue's reasoning defaults: on unless asked otherwise, or always on.
  reasoning?: { default_enabled: boolean; mandatory: boolean };
}

interface CatalogueEntry {
  id: string;
  canonical_slug?: string;
  supported_parameters?: string[];
  reasoning?: { default_enabled?: boolean; mandatory?: boolean } | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    overrides?: { min_prompt_tokens?: number; prompt?: string; completion?: string }[];
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export const parsePricing = (entry: CatalogueEntry): ModelPricing | null => {
  const prompt = num(entry.pricing?.prompt);
  const completion = num(entry.pricing?.completion);
  if (prompt === null || completion === null) return null;
  const tiers: PriceTier[] = [{ min_prompt_tokens: 0, prompt, completion }];
  for (const o of entry.pricing?.overrides ?? []) {
    const min = num(o.min_prompt_tokens);
    if (min === null) continue;
    tiers.push({
      min_prompt_tokens: min,
      prompt: num(o.prompt) ?? prompt,
      completion: num(o.completion) ?? completion,
    });
  }
  tiers.sort((a, b) => a.min_prompt_tokens - b.min_prompt_tokens);
  return {
    id: entry.id,
    canonical: entry.canonical_slug ?? null,
    tiers,
    ...(Array.isArray(entry.supported_parameters)
      ? { tools: entry.supported_parameters.includes('tools') }
      : {}),
    ...(entry.reasoning
      ? {
          reasoning: {
            default_enabled: entry.reasoning.default_enabled === true,
            mandatory: entry.reasoning.mandatory === true,
          },
        }
      : {}),
  };
};

// The catalogue, or null when it can't be fetched (offline, outage).
export const fetchCatalogue = async (
  doFetch: typeof fetch = fetch,
): Promise<Map<string, ModelPricing> | null> => {
  try {
    const res = await doFetch(OPENROUTER_MODELS_URL);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: CatalogueEntry[] };
    const out = new Map<string, ModelPricing>();
    for (const e of json.data ?? []) {
      const p = parsePricing(e);
      if (p) out.set(e.id, p);
    }
    return out;
  } catch {
    return null;
  }
};

// Anthropic API id → OpenRouter id: drop the date stamp, turn the trailing
// "-4-5" version into "-4.5". claude-haiku-4-5-20251001 → anthropic/claude-haiku-4.5.
export const openRouterIdFor = (anthropicId: string): string =>
  'anthropic/' + anthropicId.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2');

export const lookupPricing = (
  catalogue: Map<string, ModelPricing> | null,
  model: string,
): ModelPricing | null => {
  if (!catalogue) return null;
  return catalogue.get(model) ?? catalogue.get(openRouterIdFor(model)) ?? null;
};

// Cost of one call. Long-prompt tiers price the whole call, as OpenRouter does.
export const priceCall = (
  p: ModelPricing,
  promptTokens: number,
  completionTokens: number,
): number => {
  let tier = p.tiers[0]!;
  for (const t of p.tiers) if (promptTokens >= t.min_prompt_tokens) tier = t;
  return promptTokens * tier.prompt + completionTokens * tier.completion;
};

export const perMillion = (usdPerToken: number): string => `$${(usdPerToken * 1e6).toFixed(2)}`;
