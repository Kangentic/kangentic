import crypto from 'node:crypto';
import { estimateTokens } from '../token-estimate';
import type { ChunkInput } from '../types';

/**
 * A task's own record as the memory index holds it: its title, labels and
 * description, the `task` corpus.
 *
 * Only what the task SAYS goes in. Its lane, outcome, dates, cost and pull
 * request are facts, joined from the board when a question needs them, never
 * embedded: a column move then leaves the text, and so every content hash,
 * unchanged, and the re-index it triggers writes nothing and embeds nothing.
 */

/** Bump when the record's text or chunking changes, so every record re-indexes. */
export const TASK_RECORD_VERSION = 1;

/** Characters of description per chunk, with the title line on top. Near the
 *  conversation chunker's 400-token target, so the two corpora embed alike. */
const RECORD_CHUNK_CHARS = 1_600;
/** Carried from the end of one hard-split piece into the next. */
const RECORD_OVERLAP_CHARS = 160;

export interface TaskRecordSource {
  /** The task id, or `backlog:<id>` for a backlog item. */
  docId: string;
  /** Null for a backlog item, which has no board task yet. */
  taskId: string | null;
  title: string;
  description: string;
  labels: ReadonlyArray<string>;
  /** ISO timestamp the record was created. */
  createdAt: string;
  /** ISO timestamp of its last edit; what the index re-reads on. */
  updatedAt: string;
  /** The task's summary, when the answering agent has written one. */
  summary?: string | null;
  /** When the summary was written, ISO; a newer summary re-reads the record too. */
  summaryAt?: string | null;
}

/** When a record last changed: its own edit, or a newer summary of it. */
export function recordChangedMs(record: Pick<TaskRecordSource, 'updatedAt' | 'summaryAt'>): number | null {
  const times = [record.updatedAt, record.summaryAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => !Number.isNaN(value));
  return times.length > 0 ? Math.max(...times) : null;
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** A description split into pieces of at most `RECORD_CHUNK_CHARS`: whole
 *  paragraphs where they fit, hard windows with a little overlap where one
 *  paragraph alone is too long. */
function splitDescription(description: string): string[] {
  const paragraphs = description
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const pieces: string[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer) pieces.push(buffer);
    buffer = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > RECORD_CHUNK_CHARS) {
      flush();
      let cursor = 0;
      while (cursor < paragraph.length) {
        const end = Math.min(paragraph.length, cursor + RECORD_CHUNK_CHARS);
        pieces.push(paragraph.slice(cursor, end));
        if (end >= paragraph.length) break;
        cursor = end - RECORD_OVERLAP_CHARS;
      }
      continue;
    }
    if (buffer && buffer.length + 2 + paragraph.length > RECORD_CHUNK_CHARS) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return pieces;
}

/**
 * One record as chunks. Every chunk opens with the title (and the labels and
 * summary, when there are any), so each one embeds as being about this task: a
 * passage from the middle of a long description is otherwise just prose.
 */
export function taskRecordChunks(record: TaskRecordSource): ChunkInput[] {
  const title = record.title.trim() || 'Untitled';
  const labels = record.labels.map((label) => label.trim()).filter((label) => label.length > 0);
  const summary = record.summary?.trim();
  const header = [
    title,
    ...(labels.length > 0 ? [`Labels: ${labels.join(', ')}`] : []),
    ...(summary ? [`Summary: ${summary}`] : []),
  ].join('\n');
  const pieces = splitDescription(record.description);
  const createdMs = Date.parse(record.createdAt);
  const at = Number.isNaN(createdMs) ? null : createdMs;
  const texts = pieces.length > 0 ? pieces.map((piece) => `${header}\n\n${piece}`) : [header];
  return texts.map((text, seq) => ({
    seq,
    text,
    contentHash: sha1(text),
    tokenEstimate: estimateTokens(text),
    role: 'record',
    // The record's own date, which does not move when the task does.
    tsStart: at,
    tsEnd: at,
    turnUuidStart: null,
    turnUuidEnd: null,
  }));
}

/** A task's labels column (a JSON array of strings), read leniently. */
export function parseLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === 'string') : [];
  } catch {
    return [];
  }
}
