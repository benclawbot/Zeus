/**
 * Spec 02 — Context Compression Pipeline.
 *
 * Sits in front of the LLM API call, classifies each content block
 * by type, applies a type-appropriate compressor, and stays inside
 * a token budget. Reversible: original blocks are kept in a
 * content-addressed retrieval store and a stable `ref_id` is
 * surfaced inline for later lookup.
 *
 * For the v1 this module ships the library-mode entry point
 * (`compressMessages`) plus a minimal retrieval store. The proxy and
 * MCP modes (Spec 02 §3) are deferred — they need a sidecar process
 * and the v1's value is already captured at the library layer.
 *
 * Type-specific compressors (Spec 02 §5):
 *   - JSON / structured data — array head/tail + schema-once-row-rest
 *   - Code — keep signatures, collapse bodies (out of scope for v1;
 *     lives in codeGraph.ts)
 *   - Log — template-cluster + error-line preservation
 *   - Prose — extractive selection (the most conservative stage)
 *
 * Everything fails open: if a compressor is unsure, the original
 * text passes through. The retrieval store is best-effort: if it
 * throws, the caller still gets the compressed messages.
 */

import { estimateTokens, estimateTokensForMessages, type ProviderMessageLike } from "./tokenEstimator";

export type ContentKind = "json" | "log" | "prose" | "code" | "diff" | "unknown";

export interface CompressionConfig {
  /** Soft target for the compressed total. The system + latest user
   *  turn are reserved first; everything else is compressed to fit. */
  targetTokens: number;
  /** Tokens reserved for the system prompt and the latest user turn. */
  reserveForSystemAndLatest: number;
  /** Per-kind limits, mirroring the YAML config in the spec. */
  json: { arrayThreshold: number; alwaysKeepKeys: ReadonlyArray<string> };
  log: { neverClusterPatterns: ReadonlyArray<string> };
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  targetTokens: 16_000,
  reserveForSystemAndLatest: 4_000,
  json: { arrayThreshold: 20, alwaysKeepKeys: ["error", "message", "status", "code", "id"] },
  log: { neverClusterPatterns: ["ERROR", "FATAL", "panic", "Traceback", "Exception"] },
};

/** Result of a single content block going through the pipeline. */
export interface CompressedBlock {
  /** The new (possibly compressed) text. */
  text: string;
  /** Stable id for retrieving the original. */
  refId: string;
  /** Detected content kind, or "unknown" if unclassified. */
  kind: ContentKind;
  /** Tokens before compression. */
  originalTokens: number;
  /** Tokens after compression. */
  compressedTokens: number;
}

/** Retrieval store. In-memory + content-addressed. */
export class RetrievalStore {
  private blobs = new Map<string, string>();
  private maxBytes: number;
  private currentBytes = 0;

  constructor(maxBytes: number = 1_000_000) {
    this.maxBytes = maxBytes;
  }

  /** FNV-1a 32-bit, lowercase hex. Stable, dependency-free. */
  private static hash(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  /** Store an original. Returns the ref id. */
  put(original: string): string {
    const refId = RetrievalStore.hash(original);
    if (this.blobs.has(refId)) return refId; // already stored
    this.blobs.set(refId, original);
    this.currentBytes += original.length;
    if (this.currentBytes > this.maxBytes) {
      // Simple size cap: drop oldest by insertion order.
      const firstKey = this.blobs.keys().next().value;
      if (firstKey && firstKey !== refId) {
        const removed = this.blobs.get(firstKey) ?? "";
        this.blobs.delete(firstKey);
        this.currentBytes -= removed.length;
      }
    }
    return refId;
  }

  /** Retrieve an original by ref id. */
  get(refId: string): string | null {
    return this.blobs.get(refId) ?? null;
  }

  /** Targeted substring / query lookup inside an original. */
  retrieve(refId: string, query?: string): string | null {
    const original = this.blobs.get(refId);
    if (!original) return null;
    if (!query) return original;
    // Find the first line containing the query (case-insensitive).
    const lower = query.toLowerCase();
    const lines = original.split("\n");
    const matched = lines.find((l) => l.toLowerCase().includes(lower));
    if (matched) {
      const idx = lines.indexOf(matched);
      const start = Math.max(0, idx - 2);
      const end = Math.min(lines.length, idx + 3);
      return lines.slice(start, end).join("\n");
    }
    return null;
  }

  size(): number {
    return this.blobs.size;
  }

  bytes(): number {
    return this.currentBytes;
  }

  clear(): void {
    this.blobs.clear();
    this.currentBytes = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Content router                                                       */
/* ------------------------------------------------------------------ */

export function classifyContent(text: string): ContentKind {
  if (!text) return "unknown";
  const trimmed = text.trim();
  if (looksLikeJson(trimmed)) return "json";
  if (looksLikeLog(trimmed)) return "log";
  if (looksLikeDiff(trimmed)) return "diff";
  if (looksLikeCode(trimmed)) return "code";
  return "prose";
}

function looksLikeJson(text: string): boolean {
  if (!text) return false;
  const first = text[0];
  if (first !== "{" && first !== "[" && first !== '"') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeLog(text: string): boolean {
  // A log line usually starts with a timestamp and a level. Heuristic:
  // more than 5 lines AND at least 2 of them match a level pattern.
  const lines = text.split("\n");
  if (lines.length < 5) return false;
  let matches = 0;
  for (const line of lines.slice(0, 50)) {
    if (/\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/.test(line)) matches += 1;
  }
  return matches >= 2;
}

function looksLikeDiff(text: string): boolean {
  const lines = text.split("\n");
  const hasDiffHeader = lines.some((l) => l.startsWith("diff --git ") || l.startsWith("--- ") || l.startsWith("+++ "));
  const hasHunk = lines.some((l) => l.startsWith("@@ "));
  return hasDiffHeader || hasHunk;
}

function looksLikeCode(text: string): boolean {
  // Heuristic: high symbol density + line containing `function`, `class`,
  // `def `, `fn `, `import `, `use `, `pub `, etc. We keep this loose —
  // the conservative Prose compressor handles false positives.
  const lines = text.split("\n").slice(0, 20);
  let codeHints = 0;
  for (const l of lines) {
    if (/^\s*(function|class|def|fn|pub|use|import|export|const|let|var|interface|type|trait|struct|impl|module|mod)\b/.test(l)) {
      codeHints += 1;
    }
  }
  return codeHints >= 2;
}

/* ------------------------------------------------------------------ */
/* Type-specific compressors                                            */
/* ------------------------------------------------------------------ */

export function compressJson(text: string, cfg: CompressionConfig): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  // Always keep the never-drop keys.
  const keepKeys = new Set(cfg.json.alwaysKeepKeys);
  return JSON.stringify(compressJsonValue(parsed, keepKeys, cfg.json.arrayThreshold), null, 0);
}

function compressJsonValue(value: unknown, keepKeys: Set<string>, arrayThreshold: number, depth: number = 0): unknown {
  if (Array.isArray(value)) {
    if (value.length <= arrayThreshold) {
      return value.map((v) => compressJsonValue(v, keepKeys, arrayThreshold, depth + 1));
    }
    // Keep first 30% + last 15%, summarize the middle.
    const head = Math.ceil(value.length * 0.3);
    const tail = Math.floor(value.length * 0.15);
    const headPart = value.slice(0, head).map((v) => compressJsonValue(v, keepKeys, arrayThreshold, depth + 1));
    const tailPart = value.slice(-tail).map((v) => compressJsonValue(v, keepKeys, arrayThreshold, depth + 1));
    return [
      ...headPart,
      `/* ${value.length - head - tail} items omitted: array.length=${value.length} */`,
      ...tailPart,
    ];
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (keepKeys.has(k) || depth >= 4) {
        out[k] = compressJsonValue(v, keepKeys, arrayThreshold, depth + 1);
        continue;
      }
      // Drop very deep nested values; replace with a count summary.
      if (depth >= 2 && typeof v === "object" && v !== null) {
        if (Array.isArray(v)) out[k] = `[array of ${v.length}]`;
        else out[k] = `[object of ${Object.keys(v as object).length} keys]`;
        continue;
      }
      out[k] = compressJsonValue(v, keepKeys, arrayThreshold, depth + 1);
    }
    return out;
  }
  return value;
}

export function compressLog(text: string, cfg: CompressionConfig): string {
  const lines = text.split("\n");
  const templateCounts = new Map<string, { count: number; first: number; last: number; sample: string }>();
  const distinctLines: string[] = [];
  const neverCluster = cfg.log.neverClusterPatterns;

  const normalize = (line: string): string =>
    line
      .replace(/\d{4}-\d{2}-\d{2}[T ]?\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TS>")
      .replace(/\b\d+\b/g, "<N>")
      .replace(/0x[0-9a-fA-F]+/g, "<HEX>")
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "<UUID>");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (neverCluster.some((p) => line.includes(p))) {
      distinctLines.push(line);
      continue;
    }
    const tpl = normalize(line);
    const entry = templateCounts.get(tpl);
    if (entry) {
      entry.count += 1;
      entry.last = i;
    } else {
      templateCounts.set(tpl, { count: 1, first: i, last: i, sample: line });
      distinctLines.push(line);
    }
  }
  const clusters: string[] = [];
  for (const { count, first, last, sample } of templateCounts.values()) {
    if (count > 1) {
      clusters.push(`${sample} (×${count}, first at line ${first + 1}, last at line ${last + 1})`);
    }
  }
  const out: string[] = [];
  if (distinctLines.length > 0) {
    out.push(`distinct (${distinctLines.length}):`);
    out.push(...distinctLines.slice(0, 50));
    if (distinctLines.length > 50) out.push(`/* ${distinctLines.length - 50} more distinct lines omitted */`);
  }
  if (clusters.length > 0) {
    out.push(`clustered templates (${clusters.length}):`);
    out.push(...clusters.slice(0, 30));
  }
  return out.join("\n");
}

function compressDiff(text: string): string {
  const lines = text.split("\n");
  // Drop pure-whitespace-only change lines.
  const kept: string[] = [];
  for (const line of lines) {
    if (/^[+-]\s*$/.test(line)) continue;
    kept.push(line);
  }
  if (kept.length <= 200) return kept.join("\n");
  const head = kept.slice(0, 80);
  const tail = kept.slice(-40);
  return [...head, `[... ${kept.length - 120} lines omitted ...]`, ...tail].join("\n");
}

function compressProse(text: string): string {
  // Most conservative stage. Keep sentence boundaries; drop sentences
  // shorter than 4 words if we'd otherwise exceed a soft cap.
  const tokens = estimateTokens(text);
  if (tokens <= 800) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 12) return text;
  const head = sentences.slice(0, Math.ceil(sentences.length / 2));
  const tail = sentences.slice(-Math.floor(sentences.length / 4));
  return [...head, `[... ${sentences.length - head.length - tail.length} sentences omitted ...]`, ...tail].join(" ");
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

export interface CompressionResult {
  messages: ProviderMessageLike[];
  /** Retrieval map: refId → hash. */
  retrievals: Array<{ refId: string; kind: ContentKind; originalTokens: number; compressedTokens: number }>;
  originalTokens: number;
  compressedTokens: number;
}

export function compressContent(text: string, kind: ContentKind, cfg: CompressionConfig = DEFAULT_COMPRESSION_CONFIG, store: RetrievalStore = new RetrievalStore()): CompressedBlock {
  const originalTokens = estimateTokens(text);
  let compressed: string;
  try {
    switch (kind) {
      case "json":
        compressed = compressJson(text, cfg);
        break;
      case "log":
        compressed = compressLog(text, cfg);
        break;
      case "diff":
        compressed = compressDiff(text);
        break;
      case "code":
      case "prose":
      case "unknown":
        compressed = compressProse(text);
        break;
    }
  } catch {
    compressed = text; // fail-open
  }
  // If compression made things larger, pass through.
  if (estimateTokens(compressed) > originalTokens) {
    compressed = text;
  }
  const refId = store.put(text);
  return {
    text: compressed,
    refId,
    kind,
    originalTokens,
    compressedTokens: estimateTokens(compressed),
  };
}

/**
 * Compress an array of provider messages to fit a token budget. The
 * first system message and the last user/assistant message are
 * always preserved; the rest are compressed block-by-block. If the
 * total is already under the budget, the messages are returned
 * unchanged.
 */
export function compressMessages(
  messages: ReadonlyArray<ProviderMessageLike>,
  cfg: CompressionConfig = DEFAULT_COMPRESSION_CONFIG,
  store: RetrievalStore = new RetrievalStore(),
): CompressionResult {
  const originalTokens = estimateTokensForMessages(messages);
  const target = cfg.targetTokens;
  if (originalTokens <= target || messages.length === 0) {
    return {
      messages: [...messages],
      retrievals: [],
      originalTokens,
      compressedTokens: originalTokens,
    };
  }
  const out: ProviderMessageLike[] = [];
  const retrievals: CompressionResult["retrievals"] = [];
  const n = messages.length;
  for (let i = 0; i < n; i += 1) {
    const msg = messages[i];
    const isPinned = i === 0 || i === n - 1; // system + latest
    if (isPinned) {
      out.push({ ...msg });
      continue;
    }
    const kind = classifyContent(msg.content);
    const block = compressContent(msg.content, kind, cfg, store);
    out.push({ role: msg.role, content: `${block.text}\n\n[ref: ${block.refId}]` });
    retrievals.push({
      refId: block.refId,
      kind: block.kind,
      originalTokens: block.originalTokens,
      compressedTokens: block.compressedTokens,
    });
  }
  // If we're still over budget, drop the lowest-priority middle items
  // (oldest first) until we fit.
  const compressedTokens = estimateTokensForMessages(out);
  if (compressedTokens > target) {
    // Find middle indices and drop from the front.
    const pinnedCount = 2; // first + last
    const middle: number[] = [];
    for (let i = 1; i < out.length - 1; i += 1) middle.push(i);
    while (estimateTokensForMessages(out) > target && middle.length > pinnedCount) {
      const dropIdx = middle.shift();
      if (dropIdx === undefined) break;
      out[dropIdx] = { role: "system", content: "[evicted — older turn dropped to fit budget]" };
    }
  }
  return {
    messages: out,
    retrievals,
    originalTokens,
    compressedTokens: estimateTokensForMessages(out),
  };
}
