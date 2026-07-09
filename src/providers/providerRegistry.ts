import { sendMinimaxChat } from "./minimax";
import type { ProviderClient } from "./chatTypes";

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

/**
 * Look up a registered provider by id.
 */
export function findProvider(id: string): ProviderClient | undefined {
  return registry.find((provider) => provider.id === id);
}

export function listProviders(): ProviderClient[] {
  return registry.slice();
}