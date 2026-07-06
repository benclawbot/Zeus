import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPRESSION_CONFIG,
  RetrievalStore,
  classifyContent,
  compressContent,
  compressJson,
  compressLog,
  compressMessages,
} from "./contextCompressor";

interface ProviderMessageLike {
  role: string;
  content: string;
}

describe("classifyContent", () => {
  it("classifies valid JSON", () => {
    expect(classifyContent('{"a":1,"b":2}')).toBe("json");
    expect(classifyContent("[1,2,3]")).toBe("json");
  });

  it("classifies log-shaped text", () => {
    const log = Array.from(
      { length: 20 },
      (_, i) => `2026-01-01T00:00:0${i % 10}Z INFO server listening on port 8080`,
    ).join("\n");
    expect(classifyContent(log)).toBe("log");
  });

  it("classifies diffs", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "index 1234..5678 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      "-old line",
      "+new line",
    ].join("\n");
    expect(classifyContent(diff)).toBe("diff");
  });

  it("classifies code-shaped text", () => {
    const code = `
export function foo() { return 1; }
export class Bar {}
export const x = 1;
    `;
    expect(classifyContent(code)).toBe("code");
  });

  it("falls back to prose for plain text", () => {
    expect(classifyContent("This is a plain prose paragraph with multiple sentences. It should not match any of the structural heuristics.")).toBe("prose");
  });

  it("returns unknown for empty / null-ish input", () => {
    expect(classifyContent("")).toBe("unknown");
  });
});

describe("compressJson", () => {
  it("keeps first + last entries of a long array, summarising the middle", () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ id: i, value: `item-${i}` }));
    const text = JSON.stringify(arr);
    const compressed = compressJson(text, DEFAULT_COMPRESSION_CONFIG);
    const parsed = JSON.parse(compressed) as unknown[];
    // First 30% of 50 = 15, last 15% = 7 (rounded). Plus the summary marker.
    expect(parsed.length).toBeLessThan(arr.length);
    expect(compressed).toContain("omitted");
  });

  it("preserves never-drop keys at any depth", () => {
    const text = JSON.stringify({ data: { id: 1, name: "x", error: "boom" }, status: "ok" });
    const compressed = compressJson(text, DEFAULT_COMPRESSION_CONFIG);
    const parsed = JSON.parse(compressed) as { data: { error?: string }; status?: string };
    expect(parsed.data.error).toBe("boom");
    expect(parsed.status).toBe("ok");
  });
});

describe("compressLog", () => {
  it("clusters repeated log lines and preserves error lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i += 1) lines.push(`2026-01-01T00:00:00Z INFO server listening on 8080`);
    lines.push("2026-01-01T00:00:01Z ERROR failed to connect to db");
    lines.push("2026-01-01T00:00:02Z ERROR failed to connect to db");
    const text = lines.join("\n");
    const compressed = compressLog(text, DEFAULT_COMPRESSION_CONFIG);
    expect(compressed).toContain("ERROR failed to connect to db");
    expect(compressed).toMatch(/×\d+/);
  });
});

describe("RetrievalStore", () => {
  it("round-trips an original through put/get", () => {
    const s = new RetrievalStore();
    const id = s.put("hello world");
    expect(s.get(id)).toBe("hello world");
  });

  it("is content-addressed (same input → same refId)", () => {
    const s = new RetrievalStore();
    const a = s.put("duplicate content");
    const b = s.put("duplicate content");
    expect(a).toBe(b);
    expect(s.size()).toBe(1);
  });

  it("supports targeted substring retrieval", () => {
    const s = new RetrievalStore();
    const id = s.put("line one\nline two with target\nline three");
    const hit = s.retrieve(id, "target");
    expect(hit).toContain("target");
  });

  it("returns null for unknown refIds", () => {
    const s = new RetrievalStore();
    expect(s.get("nope")).toBeNull();
    expect(s.retrieve("nope", "anything")).toBeNull();
  });

  it("respects the size cap and evicts oldest", () => {
    const s = new RetrievalStore(200); // very small cap
    for (let i = 0; i < 30; i += 1) s.put(`blob-${i}`.padEnd(20, "x"));
    expect(s.size()).toBeLessThan(30);
  });
});

describe("compressContent", () => {
  it("passes through when compression makes things larger", () => {
    const tiny = '{"a":1}';
    const result = compressContent(tiny, "json", DEFAULT_COMPRESSION_CONFIG, new RetrievalStore());
    expect(result.text).toBe(tiny);
  });

  it("fails open on parse errors", () => {
    const broken = '{"a":'; // invalid JSON
    const result = compressContent(broken, "json", DEFAULT_COMPRESSION_CONFIG, new RetrievalStore());
    expect(result.text).toBe(broken);
  });

  it("always populates a refId for retrieval", () => {
    const s = new RetrievalStore();
    const result = compressContent("hello world this is a test", "prose", DEFAULT_COMPRESSION_CONFIG, s);
    expect(result.refId.length).toBeGreaterThan(0);
    expect(s.get(result.refId)).toBe("hello world this is a test");
  });
});

describe("compressMessages", () => {
  it("returns messages unchanged when already under budget", () => {
    const messages: ProviderMessageLike[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ];
    const result = compressMessages(messages, DEFAULT_COMPRESSION_CONFIG, new RetrievalStore());
    expect(result.messages).toEqual(messages);
    expect(result.compressedTokens).toBe(result.originalTokens);
  });

  it("compresses large JSON tool outputs to fit the budget", () => {
    const arr = Array.from({ length: 200 }, (_, i) => ({ id: i, value: `item-${i}`, data: "x".repeat(20) }));
    const messages: ProviderMessageLike[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "show me the data" },
      { role: "tool", content: JSON.stringify(arr) },
      { role: "assistant", content: "ok" },
    ];
    const result = compressMessages(messages, { ...DEFAULT_COMPRESSION_CONFIG, targetTokens: 500 }, new RetrievalStore());
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    expect(result.retrievals.length).toBeGreaterThan(0);
  });

  it("preserves the first (system) and last (latest) message verbatim", () => {
    const messages: ProviderMessageLike[] = [
      { role: "system", content: "SYSTEM KEEP ME" },
      { role: "user", content: "tool: " + JSON.stringify({ big: "x".repeat(1000) }) },
      { role: "assistant", content: "LATEST KEEP ME" },
    ];
    const result = compressMessages(messages, { ...DEFAULT_COMPRESSION_CONFIG, targetTokens: 200 }, new RetrievalStore());
    const first = result.messages[0];
    const last = result.messages[result.messages.length - 1];
    expect(first?.content).toBe("SYSTEM KEEP ME");
    expect(last?.content).toBe("LATEST KEEP ME");
  });
});
