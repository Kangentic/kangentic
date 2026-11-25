/**
 * The mobile bridge's failures that no verb handler throws.
 *
 * The capability router reports a handler's THROW as `mobile_verb`
 * (`capability-router.ts`). Three kinds of failure never reach it:
 *
 * - A verb that answered the phone and failed afterwards. `move-task`,
 *   `pause-session` and `start-session` answer on commit or acceptance, because
 *   the phone gives every verb 10 s, and run the rest behind the response. The
 *   phone was told `ok` and the work did not finish.
 * - Storage and wire work with no request in flight: the roster and the push
 *   registrations loading, a frame that will not decode, a response that will
 *   not encode, a push that could not be sent or cleared.
 * - A listener or resolver of the bridge's own feeds throwing.
 *
 * Each site names its step in `stage`, a fixed word. The reporter skips what is
 * not a defect itself (`isExpectedFailure`: a refusal, an abort, the network, a
 * relay dial that never opened), and skips an error an inner chokepoint already
 * sent (`isReported`), so a spawn failure `spawnAgent` reported is not sent twice.
 * Nothing a phone sent and no task or project name rides a tag.
 */

import { createChokepointReporter, type ChokepointReporter } from '../analytics/handled-report';

export const mobileBridgeReporter: ChokepointReporter = createChokepointReporter('mobile_bridge');
