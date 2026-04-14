import { AgentDetector } from '../../shared/agent-detector';

/**
 * GitHub Copilot CLI detector.
 *
 * `copilot --version` outputs multiple lines:
 *   GitHub Copilot CLI 1.0.24.
 *   Run 'copilot update' to check for updates.
 *
 * Takes only the first line and strips the `GitHub Copilot CLI ` prefix
 * and trailing period (e.g. `GitHub Copilot CLI 1.0.24.` -> `1.0.24`).
 */
export class CopilotDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'copilot',
      parseVersion: (raw) => {
        const firstLine = raw.split('\n')[0] || '';
        return firstLine.replace(/^GitHub Copilot CLI\s+/i, '').replace(/\.\s*$/, '').trim() || null;
      },
    });
  }
}
