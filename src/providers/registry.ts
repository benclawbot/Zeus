// Barrel re-export so existing imports (`import { dispatchChat } from "./providers/registry"`)
// keep working after the split into `chatTypes` / `toolBlockParser` / `toolDispatch` /
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
  RAW_BODY_END_MARKER,
  extractToolBlocks,
  parseToolBlocks,
  parseToolSteps,
  type ParsedToolStep,
  type SearchStep,
  type RawToolBlock,
} from "./toolBlockParser";

export {
  dispatchChat,
  withWorkspaceToolPrompt,
  runToolSteps,
  formatAgentRunResult,
  formatStepLog,
  MAX_TOOL_TURNS,
  MAX_TOOL_OBSERVATION_CHARS,
  MAX_REPEATED_TOOL_BLOCKS,
} from "./toolDispatch";

export { findProvider, listProviders } from "./providerRegistry";