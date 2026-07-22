/**
 * Replace `{{key}}` placeholders in a template string with values from `vars`.
 * An unknown key's `{{...}}` is left untouched in the output.
 */
export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Task-template interpolation for auto_command and spawn_agent promptTemplate
 * only (not the general interpolateTemplate consumers like send_command/
 * run_script/webhook). Differs from interpolateTemplate in two ways:
 *
 *   1. An empty-valued OR unknown `{{key}}` is dropped instead of left as a
 *      literal placeholder or a dangling empty string.
 *   2. Horizontal whitespace in the template's LITERAL TEXT collapses to a
 *      single space. That covers the run left behind by a dropped placeholder,
 *      so `/code-review {{baseBranch}}` with an empty baseBranch yields
 *      `/code-review`, not `/code-review ` with a trailing space. Note the
 *      collapse is not limited to drop sites: it normalizes ALL literal
 *      spacing in the template, so a hand-aligned `/foo  --flag` (double
 *      space) delivers as `/foo --flag`. Substituted values are exempt.
 *
 * Resolves and strips against the TEMPLATE, never the interpolated output: a
 * substituted value (e.g. a task description that itself contains the text
 * "{{title}}") is inserted verbatim and never re-scanned for placeholders, so
 * legitimate content in a resolved value cannot be corrupted by this pass.
 *
 * Newlines are preserved - only runs of spaces/tabs collapse, and only within
 * template text (never inside a substituted value). This keeps a multi-line
 * {{task_xml}} envelope intact, down to a markdown hard break inside the raw
 * description, while still cleaning up a single-line auto_command whose
 * trailing keyword resolved empty. The leading/trailing edges of the whole
 * result are trimmed only when that edge is template text; an outermost
 * substituted value keeps its own surrounding whitespace.
 */
export function interpolateTaskTemplate(template: string, vars: Record<string, string>): string {
  const tokens = template.split(/(\{\{\w+\}\})/g);
  const rawSegments: Array<{ type: 'text' | 'value'; content: string }> = [];

  for (const token of tokens) {
    const match = /^\{\{(\w+)\}\}$/.exec(token);
    if (match) {
      const value = vars[match[1]];
      if (value) {
        rawSegments.push({ type: 'value', content: value });
      }
      // Empty or unknown: dropped entirely (no segment emitted).
    } else if (token) {
      rawSegments.push({ type: 'text', content: token });
    }
  }

  // Merge consecutive text segments BEFORE collapsing whitespace - this is
  // where a dropped placeholder's two text neighbors become adjacent, and a
  // whitespace run split across that drop point must collapse as one run,
  // not two independently-collapsed halves. Substituted values are never
  // merged into text and never touched by the collapse below.
  const merged: Array<{ type: 'text' | 'value'; content: string }> = [];
  for (const segment of rawSegments) {
    const last = merged[merged.length - 1];
    if (segment.type === 'text' && last?.type === 'text') {
      last.content += segment.content;
    } else {
      merged.push({ ...segment });
    }
  }

  // Every cleanup below is per-TEXT-segment and runs BEFORE concatenation.
  // Running it on the joined string instead would reach into substituted
  // values: a markdown hard break (a line ending in two spaces) inside a raw
  // task description delivered via {{task_xml}} would be silently stripped -
  // exactly the multi-line fidelity the task_xml resolver keeps the raw
  // description to protect. Edge trimming is skipped when the outermost
  // segment is a value, so a value's own leading/trailing whitespace survives.
  let result = '';
  for (let index = 0; index < merged.length; index++) {
    const segment = merged[index];
    if (segment.type === 'value') {
      result += segment.content;
      continue;
    }
    let text = segment.content
      .replace(/[ \t]+/g, ' ')
      // Trailing horizontal whitespace before a line break. The lookahead keeps
      // the break itself untouched, so a CRLF-authored template (`" \r\n"`)
      // loses the space without stranding a bare `\r`.
      .replace(/[ \t]+(?=\r?\n)/g, '');
    if (index === 0) text = text.replace(/^\s+/, '');
    if (index === merged.length - 1) text = text.replace(/\s+$/, '');
    result += text;
  }

  return result;
}
