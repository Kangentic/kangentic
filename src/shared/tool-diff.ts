/**
 * Pure, agent-agnostic helpers for rendering a file-editing tool call as a diff
 * (Claude-Code-style add/remove view) in the conversation viewer.
 *
 * Everything here is a pure function over data already present in the structured
 * transcript (a tool_use block's `input`): the line diff is a lossless render of
 * the old/new strings, and the tool interpretation is SHAPE-based rather than
 * tool-NAME based, so it degrades across agents (any tool whose input carries
 * old/new strings, an `edits` array, or full file `content` is drawn as a diff).
 * This is the display-side seed of the future `ConversationEvent.file_edit`
 * normalization; keeping it in `src/shared/` means the desktop viewer and a
 * future companion render the same thing from one contract.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

export interface FileEditHunk {
  oldText: string;
  newText: string;
}

export interface FileEdit {
  /** Target file path when the tool input carried one, else null. */
  filePath: string | null;
  /** One hunk per edit (a MultiEdit yields several; a Write is a single hunk
   *  whose `oldText` is empty, so it renders as an all-added file). */
  hunks: FileEditHunk[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Interpret a tool_use `input` as a file edit, or return null when it is not one.
 * Recognizes the three common shapes:
 *  - Edit:      `{ file_path?, old_string, new_string }`      -> one hunk
 *  - MultiEdit: `{ file_path?, edits: [{ old_string, new_string }, ...] }`
 *  - Write:     `{ file_path, content }`                      -> all-added hunk
 */
export function parseFileEditTool(input: unknown): FileEdit | null {
  const record = asRecord(input);
  if (!record) return null;
  const filePath = typeof record.file_path === 'string' ? record.file_path : null;

  if (typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    return { filePath, hunks: [{ oldText: record.old_string, newText: record.new_string }] };
  }

  if (Array.isArray(record.edits)) {
    const hunks: FileEditHunk[] = [];
    for (const edit of record.edits) {
      const editRecord = asRecord(edit);
      if (
        editRecord
        && typeof editRecord.old_string === 'string'
        && typeof editRecord.new_string === 'string'
      ) {
        hunks.push({ oldText: editRecord.old_string, newText: editRecord.new_string });
      }
    }
    return hunks.length > 0 ? { filePath, hunks } : null;
  }

  if (typeof record.content === 'string' && filePath) {
    return { filePath, hunks: [{ oldText: '', newText: record.content }] };
  }

  return null;
}

/**
 * Line-level diff of two text blocks via a longest-common-subsequence walk.
 * Old-only lines are `remove`, new-only lines are `add`, shared lines are
 * `context`. O(n*m) - fine for edit-sized strings. An empty `oldText` yields an
 * all-`add` result (a freshly written file).
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n');
  const newLines = newText.length === 0 ? [] : newText.split('\n');
  const rows = oldLines.length;
  const cols = newLines.length;

  // lcs[i][j] = length of the longest common subsequence of oldLines[i:] and
  // newLines[j:]. Extra row/column of zeros as the base case.
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'context', text: oldLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'remove', text: oldLines[i] });
      i++;
    } else {
      result.push({ type: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < rows) {
    result.push({ type: 'remove', text: oldLines[i] });
    i++;
  }
  while (j < cols) {
    result.push({ type: 'add', text: newLines[j] });
    j++;
  }
  return result;
}

/** Count of added / removed lines in a set of hunks, for a "+N -M" summary. */
export function diffStats(hunks: FileEditHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of computeLineDiff(hunk.oldText, hunk.newText)) {
      if (line.type === 'add') added++;
      else if (line.type === 'remove') removed++;
    }
  }
  return { added, removed };
}
