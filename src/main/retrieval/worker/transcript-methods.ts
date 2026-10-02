/**
 * The retrieval worker's transcript reads: the Conversation window, the
 * phone's read-stream, `kangentic_get_transcript`'s structured format, the
 * board cards' message trail, and the token and tool counts read when a run
 * ends. Every agent transcript parse and stitch runs here, never on main: a
 * 16 MB tail parse cost main 47 ms on a 448 MB transcript, the phone re-read
 * a task on every hook event, and a run's end streamed its whole transcript.
 *
 * The task read answers with JSON main hands on without parsing, and sends a
 * caller holding an earlier revision only the entries that changed.
 */
import type { TranscriptEventPayload } from '@kangentic/protocol';
import { agentRegistry } from '../../agent/agent-registry';
import {
  entriesAtRevision,
  entryJson,
  resolveTaskTranscript,
  sameEntry,
  type ResolvedTaskTranscript,
} from '../../agent/transcript-service';
import { renderStructuredTranscript, type StructuredTranscriptRequest } from '../../agent/commands/structured-transcript';
import { readTrail } from '../../agent/message-trail-read';
import type { MessageTrailSessionFacts, TrailRead } from '../../agent/message-trail-tracker';
import type { CommandResponse } from '../../agent/commands/types';
import { lastAssistantPreview } from '../../agent/shared/message-preview';
import { sliceTranscriptWindow, TranscriptSync, type TranscriptWindowSlice } from '../../mobile-bridge/handlers/transcript-sync';
import { adoptRemoteTargets, type RemoteTargets } from '../remote-targets';
import type { TranscriptToolCounts, TranscriptUsage } from '../../../shared/types';
import type { WorkerContext } from './methods';

/** Who wrote a transcript, for the token and tool counts read at a run's end. */
export interface RunTranscriptRef {
  agentName: string;
  transcriptPath: string | null;
  agentSessionId: string | null;
  cwd: string | null;
}

export interface TranscriptMethods {
  /**
   * A task's whole conversation for the viewer, as the JSON of a
   * `TranscriptGetResponse`, a `TranscriptUnchangedResponse` (the caller's
   * revision is current) or a `TranscriptDeltaResponse` (only what changed
   * since the caller's revision). Main relays the string as is.
   */
  'transcript.task': {
    params: { projectId: string; sessionId: string; knownRevision?: number; remoteTargets: RemoteTargets };
    result: string;
  };
  /** The phone's page of a task's conversation: the newest entries before an index. */
  'transcript.window': {
    params: { projectId: string; sessionId: string; beforeIndex?: number; limit?: number; remoteTargets: RemoteTargets };
    result: TranscriptWindowSlice;
  };
  /**
   * One phone subscription's transcript sync: `seed` marks what the phone
   * will fetch by window as known, `diff` returns the deltas since. The
   * per-subscription state lives here (`syncId`); a sync this worker does not
   * know (it restarted) answers `diff` with a reset.
   */
  'transcript.mobileSync': {
    params: { syncId: string; projectId: string; sessionId: string; mode: 'seed' | 'diff'; remoteTargets: RemoteTargets };
    result: { payloads: TranscriptEventPayload[]; preview: string | null };
  };
  /** Forget a phone subscription's sync state. */
  'transcript.mobileRelease': {
    params: { syncId: string };
    result: void;
  };
  /** `kangentic_get_transcript`'s structured format, rendered. */
  'transcript.structured': {
    params: { request: StructuredTranscriptRequest; remoteTargets: RemoteTargets };
    result: CommandResponse;
  };
  /** One message-trail read: the newest assistant previews since `cursor`. */
  'transcript.trailRead': {
    params: { facts: MessageTrailSessionFacts & { agentSessionId: string }; cursor: number | null; remoteTargets: RemoteTargets };
    result: TrailRead;
  };
  /** Lifetime tokens from a finished run's transcript (`transcriptUsage`). */
  'transcript.usage': {
    params: RunTranscriptRef;
    result: TranscriptUsage | null;
  };
  /** Tool-call counts from a finished run's transcript (`transcriptToolCounts`). */
  'transcript.toolCounts': {
    params: RunTranscriptRef;
    result: TranscriptToolCounts | null;
  };
}

type TranscriptHandlers = {
  [Method in keyof TranscriptMethods]: (
    params: TranscriptMethods[Method]['params'],
    context: WorkerContext,
  ) => TranscriptMethods[Method]['result'] | Promise<TranscriptMethods[Method]['result']>;
};

/** Phone subscriptions' sync state, by subscription. */
const mobileSyncs = new Map<string, TranscriptSync>();
/** Reads of a subscription still awaiting its transcript, by subscription. */
const mobileReadsInFlight = new Map<string, number>();
/** Subscriptions released while one of their reads was awaiting: that read
 *  must not create their state again, since a sync id is never reused and no
 *  later release would remove it. Bounded by the reads in flight. */
const releasedMidRead = new Set<string>();

/** A delta is sent only while it is smaller than this share of the whole. */
const DELTA_MAX_SHARE = 0.5;

/** The response fields other than the entries, as JSON members. */
function metaJson(resolved: ResolvedTaskTranscript): string {
  const meta = {
    sessionId: resolved.record.id,
    taskId: resolved.record.task_id ?? null,
    taskTitle: resolved.taskTitle,
    agentName: resolved.agentName,
    startedAt: resolved.record.started_at,
    sessionStatus: resolved.record.status,
    source: resolved.source,
    sourcePath: resolved.sourcePath,
    degraded: resolved.degraded,
    ...(resolved.unavailableReason ? { unavailableReason: resolved.unavailableReason } : {}),
    sessions: resolved.sessions,
    revision: resolved.revision,
  };
  // Without its braces, to be joined with the entries.
  return JSON.stringify(meta).slice(1, -1);
}

/**
 * The viewer's response for `resolved`, as JSON, built from each entry's
 * JSON made once per entry object: an unchanged entry is never serialized
 * twice. Against a revision the caller still holds, only changed or added
 * entries go, by index.
 */
export function taskTranscriptJson(resolved: ResolvedTaskTranscript, knownRevision: number | undefined): string {
  if (knownRevision !== undefined && knownRevision === resolved.revision) {
    return JSON.stringify({ unchanged: true, revision: resolved.revision });
  }
  const entries = resolved.entries;
  const base = knownRevision !== undefined && resolved.record.task_id
    ? entriesAtRevision(resolved.record.task_id, knownRevision)
    : null;
  if (base) {
    const upserts: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      if (index < base.length && sameEntry(base[index], entries[index])) continue;
      upserts.push(`[${index},${entryJson(entries[index])}]`);
      if (upserts.length > entries.length * DELTA_MAX_SHARE) break;
    }
    if (upserts.length <= entries.length * DELTA_MAX_SHARE) {
      return `{${metaJson(resolved)},"delta":true,"baseRevision":${knownRevision},"length":${entries.length},"upserts":[${upserts.join(',')}]}`;
    }
  }
  return `{${metaJson(resolved)},"entries":[${entries.map(entryJson).join(',')}]}`;
}

function emptyTaskJson(sessionId: string): string {
  return JSON.stringify({
    sessionId,
    taskId: null,
    taskTitle: '(unknown task)',
    agentName: '',
    startedAt: '',
    sessionStatus: null,
    source: 'none',
    sourcePath: null,
    entries: [],
    degraded: false,
    unavailableReason: 'file_missing',
    sessions: [],
    revision: 0,
  });
}

export const transcriptHandlers: TranscriptHandlers = {
  'transcript.task': async ({ projectId, sessionId, knownRevision, remoteTargets }, context) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    const resolved = await resolveTaskTranscript(context.getDb(projectId), sessionId);
    return resolved ? taskTranscriptJson(resolved, knownRevision) : emptyTaskJson(sessionId);
  },

  'transcript.window': async ({ projectId, sessionId, beforeIndex, limit, remoteTargets }, context) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    const resolved = await resolveTaskTranscript(context.getDb(projectId), sessionId);
    return resolved
      ? sliceTranscriptWindow(resolved, beforeIndex, limit)
      : { revision: 0, totalEntries: 0, startIndex: 0, entries: [] };
  },

  'transcript.mobileSync': async ({ syncId, projectId, sessionId, mode, remoteTargets }, context) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    mobileReadsInFlight.set(syncId, (mobileReadsInFlight.get(syncId) ?? 0) + 1);
    let resolved: Awaited<ReturnType<typeof resolveTaskTranscript>>;
    let releasedDuringRead: boolean;
    try {
      resolved = await resolveTaskTranscript(context.getDb(projectId), sessionId);
    } finally {
      const remaining = (mobileReadsInFlight.get(syncId) ?? 1) - 1;
      releasedDuringRead = releasedMidRead.has(syncId);
      if (remaining > 0) {
        mobileReadsInFlight.set(syncId, remaining);
      } else {
        mobileReadsInFlight.delete(syncId);
        releasedMidRead.delete(syncId);
      }
    }
    if (releasedDuringRead || !resolved) return { payloads: [], preview: null };
    let sync = mobileSyncs.get(syncId);
    const known = sync !== undefined;
    if (!sync) {
      sync = new TranscriptSync();
      mobileSyncs.set(syncId, sync);
    }
    const preview = lastAssistantPreview(resolved.entries);
    if (mode === 'seed') {
      sync.seed(resolved);
      return { payloads: [], preview };
    }
    if (!known) {
      // This worker never saw the subscription (it restarted): the phone
      // re-fetches its window.
      sync.seed(resolved);
      return { payloads: [{ mode: 'reset', revision: resolved.revision, totalEntries: resolved.entries.length }], preview };
    }
    return { payloads: sync.diff(resolved), preview };
  },

  'transcript.mobileRelease': ({ syncId }) => {
    mobileSyncs.delete(syncId);
    if (mobileReadsInFlight.has(syncId)) releasedMidRead.add(syncId);
  },

  'transcript.structured': ({ request, remoteTargets }) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    return renderStructuredTranscript(request);
  },

  'transcript.trailRead': async ({ facts, cursor, remoteTargets }) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    const adapter = agentRegistry.getBySessionType(facts.sessionType);
    if (!adapter) return { previews: [], cursor, usedFallback: false };
    return readTrail(adapter, facts, cursor);
  },

  'transcript.usage': async ({ agentName, transcriptPath, agentSessionId, cwd }) => {
    const adapter = agentRegistry.get(agentName);
    if (!adapter?.transcriptUsage) return null;
    return adapter.transcriptUsage({ transcriptPath, agentSessionId, cwd });
  },

  'transcript.toolCounts': async ({ agentName, transcriptPath, agentSessionId, cwd }) => {
    const adapter = agentRegistry.get(agentName);
    if (!adapter?.transcriptToolCounts) return null;
    return adapter.transcriptToolCounts({ transcriptPath, agentSessionId, cwd });
  },
};
