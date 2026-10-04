import type { AutomationConfig, AutomationType } from './types';

/**
 * The one-line sentence an automation's row shows.
 *
 * Shared rather than per-adapter because BOTH sides need it: the main process
 * writes it into a run's log line, and the renderer draws it on every row in
 * Board setup. The plan called for the renderer to keep its own copy pinned
 * equal by a test, which is a worse version of just having one function.
 *
 * Renderer-safe by contract: no Node imports. Every adapter's `describe`
 * delegates here.
 *
 * Must never throw, on any input including `{}` and a config full of
 * unsubstituted `{{variables}}`. A half-built draft renders through it: the
 * picker adds an automation before it has a name or a value.
 */
export function describeAutomation(type: AutomationType, config: AutomationConfig): string {
  switch (type) {
    case 'send_message': {
      // `command` is the legacy `send_command` key a migrated row may carry.
      const message = (config.message ?? config.command ?? '').trim();
      if (!message) return 'No message yet.';
      const timing = config.mode === 'deferred' ? 'after the current turn' : 'immediately';
      return `Sends "${firstLine(message, 52)}" ${timing}.`;
    }

    case 'run_script': {
      const script = (config.script ?? '').trim();
      return script ? `Runs ${firstLine(script, 56)}` : 'No script yet.';
    }

    case 'webhook': {
      const url = (config.url ?? '').trim();
      return url ? `${config.method ?? 'POST'} to ${hostOf(url)}` : 'No URL yet.';
    }

    case 'notify': {
      const title = (config.title ?? '').trim();
      return title ? `Notifies "${firstLine(title, 52)}"` : 'Shows a desktop notification.';
    }

    case 'move_to_column': {
      const column = typeof config.targetColumn === 'string' ? config.targetColumn.trim() : '';
      const where = column ? `to ${firstLine(column, 40)}` : 'to the next column';
      const message = typeof config.message === 'string' ? config.message.trim() : '';
      return message ? `Moves the task ${where} with "${firstLine(message, 40)}"` : `Moves the task ${where}.`;
    }

    case 'spawn_agent': {
      const prompt = (config.promptTemplate ?? '').trim();
      return prompt ? `Starts the agent with "${firstLine(prompt, 48)}"` : 'Starts the agent.';
    }
  }
}

/**
 * The line under a row that names its guards, or null when it has none:
 * "Only if the review is clean. At most 3 times for each task." Read in the
 * same order the rule runs, condition first.
 */
export function describeAutomationGuards(guards: { condition: string | null; max_runs: number | null }): string | null {
  const parts: string[] = [];
  const condition = guards.condition?.trim() ?? '';
  if (condition) {
    const sentence = firstLine(condition, 72);
    // Lower-case the first letter so it reads as one sentence, unless it starts
    // an acronym or a name ("CI is green" stays as written).
    const continued = /^[A-Z][a-z]/.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence;
    parts.push(`Only if ${continued.replace(/[.!?]+$/, '')}.`);
  }
  if (guards.max_runs !== null) {
    parts.push(guards.max_runs === 1 ? 'At most once for each task.' : `At most ${guards.max_runs} times for each task.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Collapse to one line and cut at `max`, so a multi-line script stays a row. */
export function firstLine(text: string, max = 60): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}...`;
}

/** The host of a URL, so a row does not print a signed webhook URL in full. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A URL carrying an unsubstituted template variable is not parseable, and a
    // half-built draft renders through describeAutomation, so this must not throw.
    return firstLine(url, 40);
  }
}

/**
 * The one-line sentence a failed run's toast leads with.
 *
 * Names the automation AND the column, because neither alone locates it: two
 * columns can hold automations with the same name, and a column name alone does
 * not say which of its rows broke.
 *
 * Here rather than beside the notifier for the same reason `describeAutomation`
 * is: the renderer draws it and cannot import from `src/main/`, so a copy in
 * each would be two strings that have to agree and nothing making them.
 */
export function describeAutomationFailure(failure: { automationName: string; columnName: string }): string {
  return `${failure.automationName} failed on ${failure.columnName}`;
}
