export interface NormalizedTokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function normalizeTokenUsage(usage: unknown): NormalizedTokenUsage | null {
  const root = record(usage);
  if (!root) return null;

  const input = tokenCount(root.prompt_tokens) ?? tokenCount(root.input_tokens);
  const output = tokenCount(root.completion_tokens) ?? tokenCount(root.output_tokens);
  if (input === undefined || output === undefined) return null;

  const promptDetails = record(root.prompt_tokens_details);
  const inputDetails = record(root.input_tokens_details);
  const cacheRead = tokenCount(promptDetails?.cached_tokens)
    ?? tokenCount(inputDetails?.cached_tokens)
    ?? tokenCount(root.cache_read_input_tokens);
  const cacheWrite = tokenCount(root.cache_creation_input_tokens);

  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

export function cacheReadPercent(usage: NormalizedTokenUsage): number | null {
  if (usage.cacheRead === undefined) return null;
  if (usage.input <= 0) return 0;
  return Math.max(0, Math.min(100, (usage.cacheRead / usage.input) * 100));
}
