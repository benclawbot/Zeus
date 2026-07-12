import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";
import { textFromContent, type ChatMessage, type ChatOptions, type ChatResponse } from "./chatTypes";

export const NATIVE_WORKSPACE_TOOL_PROMPT = [
  "# Zeus native workspace tools",
  "The Zeus desktop runtime owns tool execution, observations, and re-planning.",
  "For a workspace action, emit a fenced `tool` block with one `<toolName> <JSON object>` line.",
  "Use the authoritative runtime capability message for the currently available tool names.",
  "After each tool run, Zeus supplies the observation automatically. Do not include tool output in your final response.",
].join("\n");

export function withWorkspaceToolPrompt(messages: ChatMessage[]): ChatMessage[] {
  if (messages.some((message) => message.role === "system" && textFromContent(message.content).includes("# Zeus native workspace tools"))) {
    return messages;
  }
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) return [{ role: "system", content: NATIVE_WORKSPACE_TOOL_PROMPT }, ...messages];
  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${textFromContent(message.content)}\n\n${NATIVE_WORKSPACE_TOOL_PROMPT}` }
    : message);
}

export async function dispatchChat(options: ChatOptions): Promise<ChatResponse> {
  if (!isTauriRuntime()) {
    throw new Error("Zeus coding-agent turns require the desktop runtime.");
  }
  return invoke<ChatResponse>("agent_runtime_execute_turn", {
    request: {
      sessionId: options.sessionId ?? "desktop-chat",
      objective: options.objective ?? lastUserMessage(options.messages) ?? "workspace task",
      provider: options.provider,
      messages: withWorkspaceToolPrompt(options.messages),
      skillId: options.skillId,
      options: {
        ...(options.model ? { model: options.model } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
    },
  });
}

function lastUserMessage(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return textFromContent(messages[index].content);
  }
  return undefined;
}
