import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationConfig } from '../../../../shared/types';
import { describeAutomation, hostOf } from '../../../../shared/automation-describe';
import type { AutomationAdapter, AutomationContext } from '../../shared/automation-adapter';
import { AutomationPermanentError, AutomationRetryableError } from '../../shared/automation-errors';

/**
 * Call webhook. Three things the action it replaces did not do, each of which
 * made a failure invisible.
 *
 * It checks `response.ok`, so a 500 is no longer indistinguishable from a 200.
 * It carries the manifest's 30 second budget, so a hung server can no longer
 * hold the task lock (which is what wedges every later operation on that task).
 * And it classifies its failures, so the runner retries a network blip or a 5xx
 * but never a 404 or a 401, which would just fail three times more slowly.
 *
 * Every attempt sends the run id as `Idempotency-Key`, so a retry cannot
 * double-create downstream. That is what makes retrying safe enough to do at
 * all.
 */
export const webhookAdapter: AutomationAdapter = {
  id: 'webhook',
  manifest: AUTOMATION_MANIFEST.webhook,

  // Delegated so the row sentence has ONE definition: the renderer draws it
  // on every row in Board setup and cannot import this file.
  describe(config: AutomationConfig): string {
    return describeAutomation('webhook', config);
  },

  async execute(config, context) {
    const url = (config.url ?? '').trim();
    if (!url) return { detail: 'No URL to call.' };

    const method = config.method ?? 'POST';
    const custom = (config.body ?? '').trim();
    // A GET carries no body. Otherwise an empty Body field means the default
    // envelope, which is why most users never have to write one, and why there
    // is usually nothing to JSON-escape.
    const body = method === 'GET' ? undefined : (custom || JSON.stringify(defaultEnvelope(context)));

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': context.runId,
          'X-Kangentic-Event': `automation.${context.trigger}`,
          ...config.headers,
        },
        body,
        signal: context.signal,
      });
    } catch (error) {
      // fetch rejects only on a transport failure or an abort. An abort is the
      // move being superseded or the budget elapsing, and the runner owns both,
      // so it is rethrown rather than classified.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new AutomationRetryableError(
        `Could not reach ${hostOf(url)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.ok) return { detail: `HTTP ${response.status}` };

    const message = `${hostOf(url)} answered HTTP ${response.status}.`;
    if (isRetryableStatus(response.status)) {
      throw new AutomationRetryableError(message, readRetryAfterSeconds(response));
    }
    throw new AutomationPermanentError(message);
  },
};

/** 408 and 429 are the server asking for another try; 5xx is the server failing at one. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function readRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * What a webhook receives when its Body field is empty.
 *
 * Real JSON built from real values, never a string the user had to escape by
 * hand. That is the whole reason it exists: the common case should not require
 * anyone to think about what a quote in a task title does to their payload.
 */
function defaultEnvelope(context: AutomationContext): Record<string, unknown> {
  return {
    event: `automation.${context.trigger}`,
    trigger: context.trigger,
    column: context.column.name,
    fromColumn: context.fromColumn?.name ?? null,
    toColumn: context.toColumn?.name ?? null,
    task: {
      id: context.task.id,
      number: context.task.display_id,
      title: context.task.title,
      labels: context.task.labels,
      branch: context.task.branch_name,
      prUrl: context.task.pr_url,
      prNumber: context.task.pr_number,
      prState: context.task.pr_state,
      externalUrl: context.task.external_url,
    },
    project: {
      id: context.projectId,
      name: context.projectName,
    },
  };
}
