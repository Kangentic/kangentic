import path from 'node:path';
import type { AgentAccountSupport } from './account-support';
import { isInsideOrSame, isLexicallyInside } from './account-folder';

/**
 * Home variables Kangentic inherited, and the ones it dropped (Sentry DESKTOP-4R, DESKTOP-4S).
 *
 * A session on a folder account runs with the CLI's home variable naming that account's folder
 * (`CLAUDE_CONFIG_DIR=<configDir>/accounts/claude/2`), and its terminal keeps it. Kangentic
 * started from that terminal inherited the variable, so the account's folder became the default
 * home: account #1 read account 2's login, and its Sign in, its sessions and every CLI run with no
 * env of its own went to account 2's folder. A home inside Kangentic's own accounts folder is
 * never the user's own, so it is dropped from the environment once at boot, before anything
 * starts a child that would inherit it. A home variable that names any other folder is the
 * user's, and stays.
 */

/** Where an agent's default home came from, as a fixed word for a report. */
export type DefaultHomeOrigin = 'builtin' | 'inherited' | 'inherited-ignored' | 'login-shell';

/** What the boot step needs of an adapter: its name and its account support. */
export interface HomeVariableSource {
  name: string;
  accounts?: AgentAccountSupport;
}

/** The agents whose inherited home variable named a Kangentic account folder and was dropped. */
const ignoredAgents = new Set<string>();

/** The agents whose home variable was taken from the login shell (`adoptShellHomeVariables`). */
const loginShellAgents = new Set<string>();

/**
 * By real path, for a value that reaches the folder through a link, and as written, for a folder
 * that does not exist yet and so has no real path to compare.
 */
function namesAccountFolder(value: string, accountsRoot: string): boolean {
  return isInsideOrSame(value, accountsRoot) || isLexicallyInside(value, accountsRoot);
}

/** Each folder adapter's home variables, with the agent that declares them. */
function homeVariablesOf(sources: readonly HomeVariableSource[]): Array<{ agent: string; variable: string }> {
  return sources.flatMap((source) => (source.accounts?.kind === 'folder'
    ? source.accounts.homeEnvVars.map((variable) => ({ agent: source.name, variable }))
    : []));
}

/** Every folder adapter's home variable names, for the login shell probe to read. */
export function folderHomeVariableNames(sources: readonly HomeVariableSource[]): string[] {
  return [...new Set(homeVariablesOf(sources).map(({ variable }) => variable))];
}

/**
 * Removes from `env` each folder adapter's home variable whose value is an absolute path inside
 * `accountsRoot`, by real path or as written. Only the adapters' own `homeEnvVars` are looked at:
 * `PWD` can sit in an account folder while a sign-in runs there, and is not a home. Returns the
 * names it removed. Logs each, never its value.
 */
export function dropInheritedAccountHomes(
  env: NodeJS.ProcessEnv,
  accountsRoot: string,
  sources: readonly HomeVariableSource[],
): string[] {
  const dropped: string[] = [];
  for (const { agent, variable } of homeVariablesOf(sources)) {
    const value = env[variable]?.trim();
    if (!value || !path.isAbsolute(value)) continue;
    if (!namesAccountFolder(value, accountsRoot)) continue;
    delete env[variable];
    dropped.push(variable);
    ignoredAgents.add(agent);
    console.warn(`[ACCOUNTS] Ignoring an inherited ${variable}: it names a Kangentic account folder, so ${agent}'s own home is used`);
  }
  return dropped;
}

/**
 * Sets in `env` each folder adapter's home variable that the user's login shell exports and
 * Kangentic was not started with. Started from a desktop launcher, Kangentic read `~/.claude`
 * while every session's shell read its rc file's `CLAUDE_CONFIG_DIR`, so the agent's own account
 * ran in one folder and Kangentic looked in another; started from a terminal, it read the rc
 * file's folder, and its account folders' links pointed at whichever home the last launch had
 * (Sentry DESKTOP-4S). The login shell's value is the user's home for the CLI, as an inherited
 * one is. A value that is not absolute, or names a Kangentic account folder, is left out.
 * `shellValues` comes from `restoreShellEnv`. Returns the names it set. Logs each, never its value.
 */
export function adoptShellHomeVariables(
  env: NodeJS.ProcessEnv,
  shellValues: Readonly<Record<string, string>>,
  accountsRoot: string,
  sources: readonly HomeVariableSource[],
): string[] {
  const adopted: string[] = [];
  for (const { agent, variable } of homeVariablesOf(sources)) {
    const value = shellValues[variable]?.trim();
    if (!value || (env[variable] ?? '').trim() !== '') continue;
    if (!path.isAbsolute(value) || namesAccountFolder(value, accountsRoot)) continue;
    env[variable] = value;
    adopted.push(variable);
    loginShellAgents.add(agent);
    console.log(`[ACCOUNTS] Using ${variable} from the login shell as ${agent}'s own home, as its sessions do`);
  }
  return adopted;
}

/**
 * Where an agent's default home comes from: its built-in home, a home variable it inherited, one
 * the login shell exports (`login-shell`), or an inherited one that named a Kangentic account
 * folder and was dropped at boot. Read from the boot step's record, because the environment no
 * longer says so once it was dropped. A home taken from the login shell after a drop is the one in
 * use, so `login-shell` wins while its variable is still set.
 */
export function defaultHomeOrigin(agent: string, homeEnvVars: readonly string[], env: NodeJS.ProcessEnv = process.env): DefaultHomeOrigin {
  const set = homeEnvVars.some((variable) => (env[variable] ?? '').trim() !== '');
  if (set && loginShellAgents.has(agent)) return 'login-shell';
  if (ignoredAgents.has(agent)) return 'inherited-ignored';
  return set ? 'inherited' : 'builtin';
}

/** For tests: forget what the boot steps dropped and adopted. */
export function resetInheritedAccountHomes(): void {
  ignoredAgents.clear();
  loginShellAgents.clear();
}
