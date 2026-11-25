/**
 * One reporter for the workflow subsystem's own work: an evaluation pass, a start nothing else
 * reported, dropping links, completing a workflow, ending its agent, and the recovery, step, lock,
 * agent and project-delete work that runs with no caller to throw to.
 *
 * A workflow runs unattended, often overnight, so a failure that is only logged is the worst kind
 * here: a workflow stalls, a paused workflow's agent keeps working, a lock stops protecting its
 * tasks, and nobody is at the desk to see the log. The `stage` tag says which step failed.
 *
 * A database that will not read or write is an environment failure. It still reports, grouped by
 * its SQLite code (`['handled-env', name, code]`), so a locked or corrupt board is one issue
 * however many steps met it. A `WorkflowRequestError` and a `StaleWorkflowRevisionError` are
 * refusals the reporter skips itself.
 *
 * No workflow title, task title, column name or project name rides a tag.
 *
 * A leaf module (it imports only the shared report path), so every file under `src/main/workflows`
 * can import it. It used to live in `workflow-engine-host.ts`, which most of those files cannot
 * import without a cycle.
 */

import { createChokepointReporter, type ChokepointReporter } from '../analytics/handled-report';

export const workflowEngineReporter: ChokepointReporter = createChokepointReporter('workflow_engine');
