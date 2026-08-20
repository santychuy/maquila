export const EXECUTION_MODEL = "exe/claude-sonnet-4-6";
export const EXECUTION_LIMITS = { contextTokens: 200_000, maxOutputTokens: 16_384 } as const;

export const CLAUDE_SONNET_4_6_REFERENCE = {
  source: {
    repository: "https://github.com/anomalyco/models.dev",
    commit: "eeffdfc0157a27e3abf6fdb75e52f91db3c8d29f",
    path: "providers/anthropic/models/claude-sonnet-4-6.toml",
    sha256: "99ed5bcf8c9c67ef14e70a38a6f98fdc56dc0b8f3409148a8ba3d70f71c31a28",
  },
  model: "anthropic/claude-sonnet-4-6",
  displayName: "Claude Sonnet 4.6",
  capabilities: { attachments: true, reasoning: true, tools: true, structuredOutput: true },
  limits: { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  knowledgeCutoff: "2025-08-31",
  releaseDate: "2026-02-17",
  updatedAt: "2026-03-13",
  pricing: {
    mode: "flat",
    currency: "USD",
    nanoUsdPerToken: { input: 3000, output: 15000, cacheRead: 300, cacheWrite: 3750 },
  },
} as const;

export interface ReportedTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function modelReference(model: string) {
  if (model !== EXECUTION_MODEL) return undefined;
  return {
    ...CLAUDE_SONNET_4_6_REFERENCE,
    modalities: {
      input: [...CLAUDE_SONNET_4_6_REFERENCE.modalities.input],
      output: [...CLAUDE_SONNET_4_6_REFERENCE.modalities.output],
    },
  };
}

export function estimateReferenceNanoUsd(
  tokens: ReportedTokens,
  reference: {
    pricing?: {
      mode: string;
      currency: string;
      nanoUsdPerToken?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>;
    };
  },
): number | undefined {
  const values = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.total];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  if (
    BigInt(tokens.total) !==
    BigInt(tokens.input) +
      BigInt(tokens.output) +
      BigInt(tokens.cacheRead) +
      BigInt(tokens.cacheWrite)
  )
    return undefined;
  const pricing = reference.pricing;
  const rates = pricing?.nanoUsdPerToken;
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (
    !pricing ||
    pricing.mode !== "flat" ||
    pricing.currency !== "USD" ||
    !rates ||
    Object.keys(pricing).toSorted().join() !== "currency,mode,nanoUsdPerToken" ||
    Object.keys(rates).toSorted().join() !== keys.toSorted().join()
  )
    return undefined;
  if (keys.some((key) => !Number.isSafeInteger(rates[key]) || (rates[key] ?? -1) < 0))
    return undefined;
  const result = keys.reduce((sum, key) => sum + BigInt(tokens[key]) * BigInt(rates[key]!), 0n);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : undefined;
}
