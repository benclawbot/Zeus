import type { AgentStepRequest } from "./workspace";

// Sentinel that marks the end of a `createArtifact` raw-body block. Each
// line up to (and not including) this marker is appended verbatim to the
// file body. The sentinel must appear on its own line, optionally
// indented; the matching is exact against `RAW_BODY_END_MARKER`.
export const RAW_BODY_END_MARKER = "<<<END";

const TOOL_BLOCK_PATTERN = /```tool\s*\n([\s\S]*?)\n```/g;

export type SearchStep = {
  kind: "search";
  query: string;
  root?: string;
  workspaceDir?: string;
  maxResults?: number;
  seenFiles?: string[];
};

export type ParsedToolStep = AgentStepRequest | SearchStep;

export interface RawToolBlock {
  rawLines: string[];
}

export function extractToolBlocks(content: string): RawToolBlock[] {
  const blocks: RawToolBlock[] = [];
  for (const match of content.matchAll(TOOL_BLOCK_PATTERN)) {
    blocks.push({ rawLines: match[1].split(/\r?\n/) });
  }
  return blocks;
}

/**
 * Each block may contain one or more tool calls. Two syntaxes are
 * supported side by side so the LLM never has to JSON-escape a large
 * multi-line file body just to call a tool.
 *
 *   Standard call — one line:
 *     <kind> <json>
 *
 *   Raw-body call (`createArtifact`) — header line + body lines until
 *   the explicit sentinel `<<<END`:
 *     createArtifact path=coding-agents.html
 *         <!doctype html>
 *         <html>...</html>
 *         <<<END
 * The header line carries `key=value` metadata rather than JSON so the
 * LLM doesn't have to escape every line of a 30 KB HTML body. The body
 * is collected verbatim until the sentinel.
 */
const RAW_BODY_KINDS = new Set(["createArtifact"]);

export function parseToolBlocks(blocks: RawToolBlock[]): ParsedToolStep[] {
  const steps: ParsedToolStep[] = [];
  for (const block of blocks) {
    let i = 0;
    while (i < block.rawLines.length) {
      const rawLine = block.rawLines[i];
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) { i += 1; continue; }
      const split = rawLine.indexOf(" ");
      if (split === -1) { i += 1; continue; }
      const kind = rawLine.slice(0, split).trim();
      const rest = rawLine.slice(split + 1).trim();
      if (RAW_BODY_KINDS.has(kind)) {
        const metadata: Record<string, string> = {};
        for (const token of rest.split(/\s+/)) {
          if (!token) continue;
          const eq = token.indexOf("=");
          if (eq === -1) continue;
          metadata[token.slice(0, eq)] = token.slice(eq + 1);
        }
        const bodyLines: string[] = [];
        let j = i + 1;
        let endSeen = false;
        while (j < block.rawLines.length && !endSeen) {
          const next = block.rawLines[j];
          const nextTrim = next.trim();
          if (nextTrim === RAW_BODY_END_MARKER) {
            endSeen = true;
            j += 1;
            break;
          }
          bodyLines.push(next);
          j += 1;
        }
        i = j;
        if (metadata.path) {
          steps.push({
            kind: "writeFile",
            path: metadata.path,
            content: bodyLines.join("\n"),
            create: metadata.create !== "false",
            overwrite: metadata.overwrite !== "false",
          });
        }
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rest);
      } catch {
        i += 1;
        continue;
      }
      const step = parseToolStep(kind, parsed);
      if (step) steps.push(step);
      i += 1;
    }
  }
  return steps;
}

// `parseToolSteps` is the public alias for `parseToolBlocks(extractToolBlocks(content))`.
// Tests rely on this name; the loop in `dispatchChat` uses the fully
// resolved path internally for type clarity.
export function parseToolSteps(content: string): ParsedToolStep[] {
  return parseToolBlocks(extractToolBlocks(content));
}

function parseToolStep(kind: string, parsed: Record<string, unknown>): ParsedToolStep | null {
  if (kind === "readFile" && typeof parsed.path === "string") {
    return { kind: "readFile", path: parsed.path, maxBytes: numberField(parsed.maxBytes) };
  }
  if (kind === "writeFile" && typeof parsed.path === "string" && typeof parsed.content === "string") {
    return { kind: "writeFile", path: parsed.path, content: parsed.content, create: parsed.create === true, overwrite: parsed.overwrite === true };
  }
  if (kind === "editFile" && typeof parsed.path === "string" && typeof parsed.find === "string" && typeof parsed.replace === "string") {
    return { kind: "editFile", path: parsed.path, find: parsed.find, replace: parsed.replace, replaceAll: parsed.replaceAll === true };
  }
  if (kind === "runCommand" && typeof parsed.program === "string" && Array.isArray(parsed.args)) {
    return {
      kind: "runCommand",
      program: parsed.program,
      args: stringList(parsed.args),
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      timeoutMs: numberField(parsed.timeoutMs),
    };
  }
  if (kind === "listDir" && typeof parsed.path === "string") {
    return { kind: "listDir", path: parsed.path, maxEntries: numberField(parsed.maxEntries) };
  }
  if (kind === "search" && typeof parsed.query === "string") {
    return {
      kind: "search",
      query: parsed.query,
      root: typeof parsed.root === "string" ? parsed.root : undefined,
      workspaceDir: typeof parsed.workspaceDir === "string" ? parsed.workspaceDir : undefined,
      maxResults: numberField(parsed.maxResults),
      seenFiles: Array.isArray(parsed.seenFiles) ? stringList(parsed.seenFiles) : undefined,
    };
  }
  if (kind === "loadProjectConfig") {
    return { kind: "loadProjectConfig" };
  }
  if (kind === "gitOp" && Array.isArray(parsed.args)) {
    return { kind: "gitOp", args: stringList(parsed.args), timeoutMs: numberField(parsed.timeoutMs) };
  }
  if (kind === "runTest") {
    return { kind: "runTest", args: Array.isArray(parsed.args) ? stringList(parsed.args) : [], timeoutMs: numberField(parsed.timeoutMs) };
  }
  if (kind === "webSearch" && typeof parsed.query === "string") {
    return { kind: "webSearch", query: parsed.query, maxResults: numberField(parsed.maxResults) };
  }
  return null;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string");
}