/**
 * Why a spent presence budget abandoned a socket, as BridgeSession's
 * 'forcedRedial' event carries it: a closed enum rather than free text,
 * because the service also counts it into analytics and a label there must
 * never be able to grow. Its own module so a test that replaces
 * bridge-session.ts wholesale (the service tests do) still has the
 * descriptions the service logs with.
 */
export type ForcedRedialReason = 'paired-silent' | 'parked-stale';

export const FORCED_REDIAL_DESCRIPTIONS: Readonly<Record<ForcedRedialReason, string>> = {
  'paired-silent': 'peer went silent on a paired socket',
  'parked-stale': 'rekey unanswered on a socket past the park timeout',
};
