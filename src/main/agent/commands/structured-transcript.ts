import { agentRegistry } from '../agent-registry';
import {
  filterTranscriptView,
  searchTranscript,
  sliceTranscriptAroundUuid,
  renderTranscriptBudgeted,
  TRANSCRIPT_CHAR_BUDGET_MAX,
  TRANSCRIPT_DATA_NOTE,
  type TranscriptView,
} from '../../../shared/transcript-format';
import type { CommandResponse } from './types';

/** The session a structured read is of, and how to shape it. */
export interface StructuredTranscriptRequest {
  record: { id: string; sessionType: string; agentSessionId: string; cwd: string };
  view: TranscriptView;
  tail: number | undefined;
  charBudget: number;
  search: string | undefined;
  aroundUuid: string | undefined;
  contextTurns: number;
}

/**
 * `kangentic_get_transcript`'s structured format: parse the session's native
 * history with its adapter, filter and render it to a character budget. Runs
 * in the retrieval worker (`transcript.structured`), so main parses no
 * transcript; the handler resolves which session and passes it here.
 */
export async function renderStructuredTranscript(request: StructuredTranscriptRequest): Promise<CommandResponse> {
  const { record, view, tail, charBudget, search, aroundUuid, contextTurns } = request;
  const adapter = agentRegistry.getBySessionType(record.sessionType);
  if (!adapter?.parseTranscript) {
    const label = adapter?.displayName ?? record.sessionType;
    return {
      success: true,
      message: `Structured transcripts are not supported for ${label}. Re-run with format="raw" to get the terminal scrollback instead.`,
    };
  }

  const { entries, sourcePath } = await adapter.parseTranscript(record.agentSessionId, record.cwd);

  if (entries.length === 0) {
    const where = sourcePath ? ` at ${sourcePath}` : '';
    return {
      success: true,
      message: `No structured transcript found${where}. The native session history may not exist yet. Re-run with format="raw" for the terminal scrollback.`,
    };
  }

  const totalParsed = entries.length;

  // Filter on the agent-agnostic TranscriptEntry[]: view, then the
  // turn-anchored window (citation-first fetch), then search.
  const viewed = filterTranscriptView(entries, view);
  if (view !== 'full' && viewed.length === 0) {
    const label = view === 'result' ? 'assistant response' : 'assistant responses';
    return {
      success: true,
      message: `No ${label} found in this session (view="${view}"). Try view="full" or format="raw".`,
    };
  }

  // sliceTranscriptAroundUuid returns the full list unchanged when the uuid
  // is absent, so a stale citation degrades to the full transcript.
  const windowed = aroundUuid ? sliceTranscriptAroundUuid(viewed, aroundUuid, contextTurns) : viewed;

  const searched = search ? searchTranscript(windowed, search) : windowed;
  if (search && searched.length === 0) {
    return { success: true, message: `No entries match "${search}" in this session.` };
  }

  // `result` already collapses to the single final answer, so tail is moot.
  const budgeted = renderTranscriptBudgeted(searched, {
    tail: view === 'result' ? undefined : tail,
    charBudget,
  });

  // `result` mirrors the SDK's bare result string: drop the "## Assistant"
  // heading the renderer adds.
  const body =
    view === 'result' ? budgeted.markdown.replace(/^## Assistant(?: \([^)]*\))?\n+/, '') : budgeted.markdown;

  const headerParts = [`Session: ${record.id.slice(0, 8)}...`, 'Format: structured', `View: ${view}`];
  if (search) headerParts.push(`Search: "${search}"`);
  headerParts.push(`Entries: ${budgeted.renderedEntries}/${totalParsed}`);
  let header = headerParts.join(' | ');
  if (budgeted.truncated) {
    const omittedTotal = budgeted.omittedByTail + budgeted.omittedByBudget;
    const reasons: string[] = [];
    if (budgeted.omittedByTail > 0) reasons.push(`${budgeted.omittedByTail} by tail`);
    if (budgeted.omittedByBudget > 0) {
      reasons.push(`${budgeted.omittedByBudget} by ${Math.round(charBudget / 1000)}k size cap`);
    }
    const reasonText = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
    header +=
      `\n[Truncated: ${omittedTotal} earlier entries omitted${reasonText}. ` +
      `Narrow with view="responses"/"result", tail=N, or search="term"; ` +
      `raise maxChars (up to ${TRANSCRIPT_CHAR_BUDGET_MAX}) for more.]`;
  }

  return {
    success: true,
    message: `${TRANSCRIPT_DATA_NOTE}\n${header}\n\n${body}`,
    data: {
      sessionId: record.id,
      format: 'structured',
      view,
      entryCount: totalParsed,
      renderedEntryCount: budgeted.renderedEntries,
      omittedEntryCount: budgeted.omittedByTail + budgeted.omittedByBudget,
      truncated: budgeted.truncated,
      filePath: sourcePath,
      ...(search ? { matchCount: searched.length } : {}),
    },
  };
}
