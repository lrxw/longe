import type { AgentProvider } from "../../store/config.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import type { ChatProvider } from "./types.js";

export type { ChatProvider, ProviderContext, ProviderHooks, ProviderProcess } from "./types.js";

/**
 * Every provider the chat can run, keyed by its config id. Adding one: its id in
 * PROVIDER_IDS (store/config.ts), a file next to this one, and an entry here.
 */
export const PROVIDERS: Record<AgentProvider, ChatProvider> = { claude, codex };

export function isProvider(id: string | undefined): id is AgentProvider {
  return id !== undefined && Object.hasOwn(PROVIDERS, id);
}

export function providerLabel(id: AgentProvider): string {
  return PROVIDERS[id].label;
}
