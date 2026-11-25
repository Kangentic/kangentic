/**
 * What a provider CLI did NOT say, in a catch that sorts what it did.
 *
 * A PR read (`gh pr list`, `az repos pr list`, and the reads beside them) ends in a catch that
 * classifies the CLI's own failure: missing or signed out, a transient failure that keeps the
 * link, and everything else, which reads as an ordinary "no PR here" and returns empty. That
 * last branch is right for what the CLI says. The same catch also holds what it never said:
 * output that will not parse, and a throw from the client's own code. Read as "no PR", those
 * unlink a PR the task really has, or show a check list as empty, and nothing reports it,
 * because the catch throws on its other branch and the scan passes it.
 *
 * So the empty branch calls this first. It reports only the two classes that are never the
 * CLI's answer: a runtime defect (`TypeError`, `RangeError`, `ReferenceError`) and a
 * `SyntaxError` from parsing the output. A non-zero exit with the provider's own refusal stays
 * what it was, an expected outcome. Reported as the PR subsystem's (`pr`), since every such read
 * is one, with `provider` and the read as `stage`: fixed words, never a repository, a branch, a
 * number or the output.
 */

import { isRuntimeDefect } from '../../../shared/handled-error-copy';
import { prReporter } from '../../pr/pr-report';

export type PrReadProvider = 'github' | 'azure_devops';

export function reportUnclassifiedDefect(error: unknown, provider: PrReadProvider, stage: string): void {
  if (isRuntimeDefect(error) || error instanceof SyntaxError) {
    prReporter.report(error, { tags: { provider, stage } });
  }
}
