import type { ExternalSource } from '../../shared/types';
import type { BoardAdapter } from './shared';
import { GitHubImporter } from './adapters/github-common';
import { GitHubIssuesAdapter } from './adapters/github-issues';
import { GitHubProjectsAdapter } from './adapters/github-projects';
import { AzureDevOpsAdapter } from './adapters/azure-devops';
import { AsanaAdapter } from './adapters/asana';
import { JiraAdapter } from './adapters/jira';
import { LinearAdapter } from './adapters/linear';
import { TrelloAdapter } from './adapters/trello';
import { trackFeatureUsed } from '../analytics/usage';

/**
 * Central registry of board integration adapters. Mirrors the agent registry
 * pattern at `src/main/agent/agent-registry.ts`.
 *
 * To add a new board provider:
 *   1. Create a new folder under `src/main/boards/adapters/<provider>/`.
 *   2. Implement `BoardAdapter` from `./shared`.
 *   3. Extend the `ExternalSource` union in `src/shared/types.ts`.
 *   4. Register the adapter in this file.
 *
 * No edits to IPC handlers are required - dispatch is registry-driven.
 */
export class BoardRegistry {
  private readonly adapters = new Map<ExternalSource, BoardAdapter>();

  register(adapter: BoardAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Board adapter '${adapter.id}' is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ExternalSource): BoardAdapter | undefined {
    return this.adapters.get(id);
  }

  getOrThrow(id: ExternalSource): BoardAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Board adapter not registered: ${id}`);
    }
    return adapter;
  }

  has(id: ExternalSource): boolean {
    return this.adapters.has(id);
  }

  /** Enumerate all registered adapters (stable + stub). */
  list(): BoardAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Resolve a stable (non-stub) adapter for an IPC dispatch. Throws a
   * user-facing error if the source is unknown or its adapter is a stub,
   * so IPC handlers don't need to repeat the status guard.
   */
  requireStable(id: ExternalSource): BoardAdapter {
    const adapter = this.getOrThrow(id);
    if (adapter.status === 'stub') {
      throw new Error(`${adapter.displayName} integration is not yet implemented.`);
    }
    // Adoption signal: this is the one funnel every import fetch and execute
    // goes through, and a stub throws above so an unimplemented provider never
    // counts. Main dedups to once per day.
    trackFeatureUsed('board_integration');
    return adapter;
  }
}

// Share one GitHub CLI client across both GitHub adapters so `gh` detection
// runs once instead of twice per app launch.
const githubClient = new GitHubImporter();

export const boardRegistry = new BoardRegistry();
boardRegistry.register(new GitHubIssuesAdapter(githubClient));
boardRegistry.register(new GitHubProjectsAdapter(githubClient));
boardRegistry.register(new AzureDevOpsAdapter());
boardRegistry.register(new AsanaAdapter());
boardRegistry.register(new JiraAdapter());
boardRegistry.register(new LinearAdapter());
boardRegistry.register(new TrelloAdapter());
