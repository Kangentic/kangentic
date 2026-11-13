import { createChokepointReporter } from '../analytics/handled-report';

/**
 * One report per defect in the PR subsystem's own work: a resolve that failed
 * with something other than an unavailable or transient resolver
 * (`pr-linking.ts`), and the background refresh's tick, check and sweep
 * (`pr-refresh-scheduler.ts`). The `stage` tag says which. Never a URL, a repo or
 * a branch: the message is fixed and the tags are the stage alone.
 */
export const prReporter = createChokepointReporter('pr');
