/**
 * A headless Claude run the CLI refused for its external API key, run once more
 * on the user's own login.
 *
 * In print mode Claude Code always uses `ANTHROPIC_API_KEY` when it is set; the
 * prompt that lets the interactive TUI decline the key and keep the stored
 * `/login` credential never shows. So a stale key in the environment Kangentic
 * was started from failed every terminal name, task title, summary and
 * Condition check with "Invalid API key · Fix external API key", while the
 * user's own terminals worked (#683). Running without the variable falls back
 * to the stored login. This does that, once, and only after the CLI rejected
 * the key: a key that works is used as before, and a user with no login gets
 * the refusal back.
 *
 * Only the run's own environment changes, never main's.
 */

/** The variables Claude takes an external credential from, ahead of the stored login. */
const EXTERNAL_CREDENTIAL_NAMES: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * The external credential variables `environment` sets, by the name it uses.
 * Matched case-insensitively, since Windows environment names are.
 */
export function inheritedCredentialNames(environment: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(environment).filter((name) => Boolean(environment[name]) && EXTERNAL_CREDENTIAL_NAMES.includes(name.toUpperCase()));
}

/**
 * The environment override that unsets those variables: the inherited names as
 * spelled, plus the canonical ones, which a CLI in a WSL distro reads.
 */
export function withoutExternalCredential(inheritedNames: readonly string[]): Record<string, undefined> {
  const names = new Set([...EXTERNAL_CREDENTIAL_NAMES, ...inheritedNames]);
  return Object.fromEntries([...names].map((name) => [name, undefined]));
}

/**
 * Claude's refusal of an external key, matched on the message text the run's
 * error carries. A change to that wording disables the fallback; the unit test
 * pins the current string.
 */
export function isExternalKeyRejection(error: unknown): boolean {
  return error instanceof Error && /invalid api key/i.test(error.message);
}

/**
 * Run `run` with no change to its environment, and when the CLI refuses the
 * external key it inherited, once more with that key unset. `mayRunAgain` lets
 * a caller refuse the second run, for one whose first already showed output.
 */
export async function runWithSubscriptionFallback<T>(
  run: (credentialEnv: Record<string, undefined>) => Promise<T>,
  mayRunAgain: () => boolean = () => true,
): Promise<T> {
  try {
    return await run({});
  } catch (error) {
    const inheritedNames = inheritedCredentialNames();
    if (inheritedNames.length === 0 || !isExternalKeyRejection(error) || !mayRunAgain()) throw error;
    console.warn(`[CLAUDE] a headless run refused ${inheritedNames.join(', ')}; running it again on the stored login`);
    return run(withoutExternalCredential(inheritedNames));
  }
}
