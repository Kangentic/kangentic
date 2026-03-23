/**
 * PR Connector Registry - platform-agnostic PR URL detection.
 *
 * Each hosting platform (GitHub, GitLab, Bitbucket, Azure DevOps) implements
 * the PRConnector interface. The registry exposes two functions that the rest
 * of the codebase calls without knowing which platforms are registered:
 *
 *   matchesPRCommand(detail)  - used by usage-tracker to flag relevant Bash commands
 *   detectPR(scrollback)      - used by session-manager to extract PR URLs
 *
 * To add a new platform:
 * 1. Create a connector file (e.g. gitlab-mr-detector.ts)
 * 2. Export a PRConnector object
 * 3. Import and add it to the `connectors` array below
 */

export interface DetectedPR {
  url: string;
  number: number;
}

export interface PRConnector {
  /** Platform name for logging (e.g. "GitHub", "GitLab") */
  name: string;

  /** Does this Bash command detail look like a PR command for this platform? */
  matchesCommand(commandDetail: string): boolean;

  /** Extract a PR URL + number from raw PTY scrollback text. */
  extract(scrollback: string): DetectedPR | null;
}

// --- Registry: add new connectors here ---
import { gitHubPRConnector } from './github-pr-detector';

const connectors: PRConnector[] = [
  gitHubPRConnector,
  // Future: gitLabMRConnector, bitbucketPRConnector, azureDevOpsPRConnector
];

// --- Platform-agnostic API ---

/** Check if a Bash command detail matches any registered PR connector. */
export function matchesPRCommand(commandDetail: string): boolean {
  return connectors.some((connector) => connector.matchesCommand(commandDetail));
}

/** Try all registered connectors against scrollback, return first match. */
export function detectPR(scrollback: string): DetectedPR | null {
  for (const connector of connectors) {
    const result = connector.extract(scrollback);
    if (result) return result;
  }
  return null;
}
