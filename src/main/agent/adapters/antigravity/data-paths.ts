import os from 'node:os';
import path from 'node:path';

/**
 * On-disk layout of the Antigravity CLI's data root, verified against agy
 * 1.1.13 (2026-08-16, Windows). Antigravity shares `~/.gemini` with the
 * Gemini CLI but keeps everything of its own under the `antigravity-cli`
 * subtree, so nothing here collides with the Gemini adapter's paths:
 *
 *   ~/.gemini/antigravity-cli/
 *     settings.json                      { enableTelemetry, trustedWorkspaces: [absPath...] }
 *     cache/last_conversations.json      { "<abs workspace path>": "<conversation uuid>" }
 *     conversations/<uuid>.db            SQLite, protobuf-blob steps (NOT parseable)
 *     brain/<uuid>/.system_generated/logs/transcript.jsonl   parseable JSONL steps
 *
 * `last_conversations.json` is written only at CLI exit; the transcript is
 * appended while the conversation runs.
 */
export function antigravityDataRoot(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/** The CLI's own settings file, which carries the `trustedWorkspaces` trust store. */
export function antigravitySettingsPath(): string {
  return path.join(antigravityDataRoot(), 'settings.json');
}

/** Workspace-path -> most-recent-conversation-id map (what `agy -c` resumes). */
export function antigravityLastConversationsPath(): string {
  return path.join(antigravityDataRoot(), 'cache', 'last_conversations.json');
}

/**
 * The parseable JSONL transcript for a conversation. This is the exact path
 * the CLI reports as `transcriptPath` in every hook payload (with the
 * `antigravity-cli` app-data segment; the IDE variants differ).
 */
export function antigravityTranscriptPath(conversationId: string): string {
  return path.join(
    antigravityDataRoot(),
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
}
