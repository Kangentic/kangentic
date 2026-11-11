/**
 * The account contract an agent adapter declares (`AgentAdapter.accounts`). The generic account
 * layer in this folder reads only this shape and never branches on an agent's name
 * (`agent-adapters-boundary.md`). An adapter that declares nothing gets no Accounts card.
 */

import type { RateLimitWindow } from '../../shared/types';
import type { AgentUsageWindowShape } from '../../shared/agent-accounts';

/**
 * How one entry of an account folder relates to the default home. `name` is the entry's path
 * inside a home's data folder, with `/` between parts. `..` reaches a sibling of the data folder
 * (`../.agents` is `~/.agents` beside `~/.gemini`), for a CLI that keeps a few things there.
 * - `link-dir`: a folder link (a junction on Windows) into the default home. The account reads and
 *   writes the default home's folder.
 * - `hardlink-file`: a hard link to the default home's file (same drive only). Only for a file the
 *   CLI appends to in place: a save by rename breaks the link.
 * - `copy-file`: a copy, refreshed before each spawn. For files the CLI saves by replacing them,
 *   which would break a link.
 * - `derive-json`: a JSON file built from the default home's copy by `derive`, refreshed before each
 *   spawn. For a state file that mixes shared answers with this account's own login fields.
 * - `text`: a file whose content `text` builds from the default home's path (an import line).
 */
export type SharedEntry =
  | {
      name: string;
      how: 'link-dir';
      /**
       * Holds conversations or checkpoints. A failed link for one of these blocks the account,
       * so a session never writes history where Kangentic cannot read it. Created empty in the
       * default home when missing, so the account always writes through the link.
       */
      conversationBearing: boolean;
      /** The platforms this entry exists on, when not all (a folder only one OS's sandbox uses). */
      onlyOn?: readonly NodeJS.Platform[];
    }
  | {
      name: string;
      how: 'hardlink-file';
      conversationBearing: false;
      /**
       * What the file is, when not the CLI's prompt history. A prompt history that cannot be
       * linked marks the account (its history stays its own); another file's failure is only reported.
       */
      holds?: 'prompt-history' | 'other';
    }
  | {
      name: string;
      how: 'copy-file';
      /**
       * The account must not run on a stale or missing copy: the file decides where conversations
       * are filed. A copy that cannot be made, when the default home has the file, blocks the account.
       */
      required?: boolean;
      /** Rewrites the text on its way into the account folder (a line that must not be carried over). */
      transform?: (text: string) => string;
    }
  | {
      name: string;
      how: 'derive-json';
      /** The default home's file, when it is not `name` in the default home. */
      sourcePath?: (defaultHome: string) => string;
      /** Where the account's copy lives, when it is not `name` in the account folder. */
      targetPath?: (accountFolder: string) => string;
      /** Builds the account's file from the default home's (`source`) and its current one. */
      derive: (source: Record<string, unknown>, current: Record<string, unknown>) => Record<string, unknown>;
      /** Runs the read and write inside the CLI's own lock on `targetPath`, when it keeps one. */
      lock?: (targetPath: string, operation: () => void) => Promise<void>;
      /** Reads the file's text when the CLI accepts more than strict JSON (comments). Null: unreadable. */
      parse?: (text: string) => Record<string, unknown> | null;
      /**
       * The default home's file holds a setting that guards conversations (how long the CLI keeps
       * them), so an account must never run on defaults in its place. When the file exists, is not
       * empty and cannot be read, the account is blocked.
       */
      required?: boolean;
    }
  | { name: string; how: 'text'; text: (defaultHome: string) => string | null };

/**
 * Thrown by `readIdleUsage` when the CLI answered in a shape the adapter does not know, which the
 * account service reports. An adapter never reports by itself: adapters also load in the pty
 * host, which carries no error reporting. `keys` names the answer's fields, never a value.
 */
export class UnreadableUsageError extends Error {
  constructor(readonly keys: string) {
    super('The CLI answered a usage read in a shape the adapter does not know');
    this.name = 'UnreadableUsageError';
  }
}

/** What the CLI says about the login in a home. */
export interface AccountIdentity {
  signedIn: boolean;
  email: string | null;
  /** The plan as the CLI names it, or null when it reports none. */
  plan: string | null;
  /** False when signed in with no subscription; null when the CLI cannot tell. */
  hasSubscription: boolean | null;
}

interface AccountSupportBase {
  /**
   * Variables the CLI uses ahead of any stored login. Kangentic never removes them;
   * the agent's card names one that is set, on one line.
   */
  overridingCredentialEnvVars: readonly string[];
  /**
   * Classifies a turn failure as plan exhaustion (not a transient rate limit). Built from a
   * captured exhausted run, never guessed.
   */
  isUsageLimitFailure?(detail: string): boolean;
  /**
   * The usage windows the CLI always has, shortest first, including one an account has not opened
   * yet (Claude's 5h window, reported only once the account has run in it). Each account row draws
   * a line per window, an unopened one as Not started. Absent: rows show only what was reported.
   */
  usageWindows?: readonly AgentUsageWindowShape[];
}

export interface FolderAccountSupport extends AccountSupportBase {
  kind: 'folder';
  /**
   * The variables that put one CLI run on an account folder: the CLI's own home variable
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) naming the folder, and anything that must go with it
   * (a keyring opt-out, a file both homes share by path). `defaultHome` is the agent's own home.
   */
  accountEnv(accountFolder: string, defaultHome: string): Record<string, string>;
  /**
   * The agent's own home: what account #1 uses. Honours an inherited home variable, so a user who
   * already runs the CLI with one keeps that folder as account #1.
   */
  defaultHome(): string;
  /**
   * Where the CLI keeps its data inside an account folder, when its home variable names the
   * parent of that data. Gemini's replaces the user's home folder, so its data is `<folder>/.gemini`
   * while `defaultHome()` is `~/.gemini` itself.
   */
  accountDataSubfolder?: string;
  /** The arguments that run the CLI's own sign-in in a terminal. Empty: the CLI itself. */
  loginArgs: readonly string[];
  /**
   * The sign-in happens inside the CLI's own screen, which the user leaves when done, instead of
   * a command that ends by itself. The terminal then starts in the account folder: such a CLI
   * reads its working folder's settings as a project's, and the account folder has none.
   */
  loginIsInteractive?: boolean;
  sharedEntries: readonly SharedEntry[];
  /**
   * A conversation can only go on under the account that started it: the provider ties what the
   * conversation stores to that account. A resume then runs on that account while it is signed
   * in, wherever the list has moved it, and Switch to leaves running sessions where they are.
   */
  conversationsStayOnAccount?: boolean;
  /**
   * Built from the CLI's source and docs, never run on a real second account. A sign-in that
   * cannot be read back, or a session that starts signed out, is then reported, so a wrong guess
   * shows up. Left off once the declaration has been run with real accounts.
   */
  unproven?: boolean;
  /**
   * The provider's words for refusing a conversation under this account (one it tied to another
   * account). Reported when a turn fails with them.
   */
  isConversationRefusal?(detail: string): boolean;
  /**
   * Reads who is signed in to `home`, or to the agent's own login when `home` is null (the run
   * then sets no home variable, so the CLI reads exactly what the user's own terminal does).
   * Must not print or return a token.
   */
  identify(cliPath: string, home: string | null): Promise<AccountIdentity>;
  /**
   * Reads the account's usage windows with no session running on it: no model turn, no cost, and
   * nothing written to the shared history or conversations. Null when it cannot be read; the
   * account then keeps its last values. Throws `UnreadableUsageError` for an answer in a shape
   * it does not know. Absent for a CLI with no such read.
   */
  readIdleUsage?(cliPath: string, home: string | null): Promise<RateLimitWindow[] | null>;
}

export interface KeyFileAccountSupport extends AccountSupportBase {
  kind: 'key-file';
  /** The variable names a key file may set for this agent. A name ending in `*` is a prefix. */
  keyEnvVars: readonly string[];
  /**
   * A variable naming a file the CLI loads after its own `.env` files, over them. When set, a
   * session on a key-file account points it at the key file too, so a key in the user's home or
   * project `.env` cannot replace the account's (Aider's `AIDER_ENV_FILE`).
   */
  envFileVar?: string;
}

export type AgentAccountSupport = FolderAccountSupport | KeyFileAccountSupport;
