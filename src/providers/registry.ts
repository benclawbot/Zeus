import { sendMinimaxChat } from "./minimax";
import { runAgentTask, searchWorkspaceCode, type AgentStepRequest } from "./workspace";

/**
 * Public type for any chat provider.
 *
 * The `id` is what gets sent to the Rust dispatcher (`send_chat`) and the
 * frontend registry; `displayName` is what the UI renders in the provider
 * picker; `defaultModel` is the model used when the user hasn't picked one.
 * `chat` is the function that actually runs a completion — today every
 * provider's `chat` is just a thin wrapper around the same `send_chat` Tauri
 * command, but in the future providers may diverge (different auth flows,
 * streaming, etc.) and this is the seam.
 */
export interface ProviderClient {
  id: string;
  displayName: string;
  defaultModel: string;
  chat: typeof sendMinimaxChat;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  provider: string;
  messages: ChatMessage[];
  /** Optional skill id. When set, the skill body is loaded and injected server-side. */
  skillId?: string;
  /** Optional model override. Falls back to the provider's default. */
  model?: string;
  /**
   * Optional API base URL override. Falls back to the provider's default
   * (e.g. https://api.minimax.io/v1 for MiniMax). Set this from the
   * Settings panel to point at a self-hosted proxy or a regional host.
   */
  baseUrl?: string;
  /** Optional temperature override. Provider-specific support. */
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: unknown;
}

type SearchStep = { kind: "search"; query: string; maxResults?: number; seenFiles?: string[] };
type ParsedToolStep = AgentStepRequest | SearchStep;

const TOOL_BLOCK_PATTERN = /```tool\s*\n([\s\S]*?)\n```/g;
const MAX_TOOL_TURNS = 6;
const MAX_TOOL_OBSERVATION_CHARS = 60_000;

const WORKSPACE_TOOL_PROMPT = [
  "# Zeus workspace tools",
  "The desktop runtime can execute fenced `tool` blocks and return the real observation before your final reply.",
  "Available tools: `listDir`, `readFile`, `search`, `editFile`, `writeFile`, `runCommand`, `gitOp`, `runTest`, `loadProjectConfig`.",
  "Use `listDir` to inspect structure, `search` for grep/symbol lookup, `readFile` for contents, `editFile` for targeted patches, `writeFile` for creates or deliberate overwrites, and `runCommand`/`gitOp`/`runTest` for verification.",
  "Each tool line is `<toolName> <json>`, for example: `search {\"query\":\"runAgentTask\",\"maxResults\":20}`.",
].join("\n");

/**
 * Single entry point for every chat call. Adds the provider id to the
 * options bag, then delegates to the active provider's `chat` function.
 */
export async function dispatchChat(options: ChatOptions): Promise<ChatResponse> {
  const provider = findProvider(options.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${options.provider}`);
  }

  const model = options.model ?? provider.defaultModel;
  const send = (messages: ChatMessage[]) => provider.chat({
    messages,
    skillId: options.skillId,
    model,
    baseUrl: options.baseUrl,
    temperature: options.temperature,
  });

  let messages = withWorkspaceToolPrompt(options.messages);
  let response = await send(messages);
  const objective = lastUserMessage(options.messages) || "workspace task";

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const steps = parseToolSteps(response.content);
    if (steps.length === 0) return response;

    const observation = await runToolSteps(steps, objective);
    messages = [
      ...messages,
      { role: "assistant", content: response.content },
      { role: "user", content: observation },
    ];
    response = await send(messages);
  }

  return {
    ...response,
    content: `${stripToolBlocks(response.content)}\n\nStopped after ${MAX_TOOL_TURNS} tool turns. The model kept requesting workspace actions instead of producing a final answer.`.trim(),
  };
}

function withWorkspaceToolPrompt(messages: ChatMessage[]): ChatMessage[] {
  if (messages.some((message) => message.role === "system" && message.content.includes("# Zeus workspace tools"))) {
    return messages;
  }
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: WORKSPACE_TOOL_PROMPT }, ...messages];
  }
  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${message.content}\n\n${WORKSPACE_TOOL_PROMPT}` }
    : message);
}

function parseToolSteps(content: string): ParsedToolStep[] {
  const steps: ParsedToolStep[] = [];
  for (const block of content.matchAll(TOOL_BLOCK_PATTERN)) {
    for (const rawLine of block[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const split = line.indexOf(" ");
      if (split === -1) continue;
      const kind = line.slice(0, split).trim();
      const json = line.slice(split + 1).trim();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      const step = parseToolStep(kind, parsed);
      if (step) steps.push(step);
    }
  }
  return steps;
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
    return { kind: "search", query: parsed.query, maxResults: numberField(parsed.maxResults), seenFiles: Array.isArray(parsed.seenFiles) ? stringList(parsed.seenFiles) : undefined };
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
  return null;
}

async function runToolSteps(steps: ParsedToolStep[], objective: string): Promise<string> {
  const results: Array<{ step: ParsedToolStep; ok: boolean; result?: unknown; error?: string }> = [];
  for (const step of steps) {
    try {
      const result = step.kind === "search"
        ? await searchWorkspaceCode({ query: step.query, maxResults: step.maxResults, seenFiles: step.seenFiles })
        : await runAgentTask({ objective, steps: [step], stopOnError: false });
      results.push({ step, ok: true, result });
    } catch (error) {
      results.push({ step, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return `Tool result for your fenced \`tool\` block. These are real Zeus workspace observations; use them directly before deciding whether another tool block is needed.\n\n\`\`\`json\n${clip(JSON.stringify(results, null, 2), MAX_TOOL_OBSERVATION_CHARS)}\n\`\`\``;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string");
}

function lastUserMessage(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].content;
  }
  return undefined;
}

function stripToolBlocks(value: string): string {
  return value.replace(TOOL_BLOCK_PATTERN, "").trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

/**
 * Look up a registered provider by id.
 */
export function findProvider(id: string): ProviderClient | undefined {
  return registry.find((provider) => provider.id === id);
}

/**
 * Built-in provider registry. Adding a new provider = appending an entry
 * here and (if its protocol differs from OpenAI completions) wiring a
 * separate `chat` function. See `src/providers/minimax.ts` for an example.
 */
const registry: ProviderClient[] = [
  {
    id: "minimax",
    displayName: "MiniMax",
    defaultModel: "MiniMax-M3",
    chat: sendMinimaxChat,
  },
];

export function listProviders(): ProviderClient[] {
  return registry.slice();
}
