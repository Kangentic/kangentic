import type { AgentAdapter } from './agent-adapter';
import { ClaudeAdapter } from './adapters/claude-adapter';
import { CodexAdapter } from './adapters/codex-adapter';
import { GeminiAdapter } from './adapters/gemini-adapter';

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
