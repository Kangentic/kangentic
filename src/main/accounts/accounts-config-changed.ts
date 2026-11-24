/**
 * The accounts settings were saved (`CONFIG_SET` with `agent.accounts`). Order mode decides the
 * order main lists, so the accounts handlers push `accounts:changed` and the Accounts tab lists
 * again once the write has landed. A module of its own so the config handler does not load the
 * accounts handlers' graph to reach them.
 */
let listener: (() => void) | null = null;

/** Set by the accounts handlers once registered; null clears it (app quit). */
export function setAccountsConfigListener(next: (() => void) | null): void {
  listener = next;
}

/** Called by `CONFIG_SET` once a save that carries `agent.accounts` has landed. */
export function noteAccountsConfigChanged(): void {
  listener?.();
}

/**
 * Called when the read after a launch found other agents installed than the launch was shown
 * (`agent-list.ts`). A card exists only for an agent whose CLI was found, so the tab lists again.
 */
export function noteInstalledAgentsChanged(): void {
  listener?.();
}
