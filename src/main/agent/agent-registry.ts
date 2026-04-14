import type { AgentAdapter } from './agent-adapter';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import { GeminiAdapter } from './adapters/gemini';
import { AiderAdapter } from './adapters/aider';
import { CursorAdapter } from './adapters/cursor';
import { WarpAdapter } from './adapters/warp';
import { CopilotAdapter } from './adapters/copilot';

class AgentRegistry {
  private adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getOrThrow(name: string): AgentAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`No agent adapter registered for "${name}"`);
    }
    return adapter;
  }

  /**
   * Look up an adapter by its session_type value (e.g. 'claude_agent').
   * Returns the adapter whose `sessionType` matches, or undefined.
   */
  getBySessionType(sessionType: string): AgentAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.sessionType === sessionType) return adapter;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

/** Singleton agent registry with built-in adapters pre-registered. */
export const agentRegistry = new AgentRegistry();
agentRegistry.register(new ClaudeAdapter());
agentRegistry.register(new CodexAdapter());
agentRegistry.register(new GeminiAdapter());
agentRegistry.register(new AiderAdapter());
agentRegistry.register(new CursorAdapter());
agentRegistry.register(new WarpAdapter());
agentRegistry.register(new CopilotAdapter());
