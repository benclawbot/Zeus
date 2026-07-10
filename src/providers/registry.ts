// Barrel re-export so existing imports (`import { dispatchChat } from "./providers/registry"`)
// keep working after the split into `chatTypes` / `toolDispatch` /
// `providerRegistry`. New code should import from the specific module it needs.

export type {
  ProviderClient,
  ChatContentPart,
  ChatContent,
  ChatMessage,
  ChatOptions,
  ChatResponse,
} from "./chatTypes";

export { textFromContent } from "./chatTypes";

export {
  dispatchChat,
  withWorkspaceToolPrompt,
  NATIVE_WORKSPACE_TOOL_PROMPT,
} from "./toolDispatch";

export { findProvider, listProviders } from "./providerRegistry";
