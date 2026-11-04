/**
 * OpenCode 1 and OpenCode 2 both install as `opencode`, and they take
 * different command lines: V2's TUI rejects `--agent` and `--model`, V2 has
 * no `--pure`, and V2 starts a shared background service unless told
 * `--standalone`. So every launch and helper run picks its arguments by the
 * detected major version.
 *
 * `opencode --version` prints `opencode v2.2.5` on V2 and the bare version on
 * V1 (`1.18.31`); the detector strips the `opencode ` prefix, which leaves a
 * `v` on V2. A version this cannot read (none yet, or a new format) is treated
 * as OpenCode 1, whose command line every earlier Kangentic release used.
 */
export function openCodeMajorVersion(version: string | null | undefined): number | null {
  if (!version) return null;
  const match = /^v?(\d+)(?:\.|$)/i.exec(version.trim().replace(/^opencode\s+/i, ''));
  return match ? Number(match[1]) : null;
}

/** True for OpenCode 2 and later. */
export function isOpenCodeV2(version: string | null | undefined): boolean {
  const major = openCodeMajorVersion(version);
  return major !== null && major >= 2;
}

/** `[major, minor, patch]` of a detected version, or null when it cannot be read. */
function openCodeVersionParts(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(version.trim().replace(/^opencode\s+/i, ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * Whether the TUI takes `--auto`, "auto-approve permissions that are not
 * explicitly denied". OpenCode 1 added it in 1.17.12 (PRs #33279 and #34641,
 * both first released in v1.17.12; listed by `opencode --help` on 1.18.31),
 * and OpenCode 2 keeps it on its TUI command (`packages/cli/src/commands/commands.ts`
 * at v2.2.5, `PermissionParams`). A version that cannot be read gets no flag,
 * since an older TUI would reject it.
 */
export function openCodeSupportsAutoApprove(version: string | null | undefined): boolean {
  const parts = openCodeVersionParts(version);
  if (!parts) return false;
  const [major, minor, patch] = parts;
  if (major !== 1) return major > 1;
  if (minor !== 17) return minor > 17;
  return patch >= 12;
}

/** The message a remote-mode spawn or connection test gives on OpenCode 2. */
export const OPENCODE_REMOTE_NEEDS_V1 =
  'OpenCode remote mode needs OpenCode 1. OpenCode 2 replaced the server API that remote mode uses.';
