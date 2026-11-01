import { describe, it, expect } from 'vitest';
import {
  escapeXml,
  buildBriefXml,
  buildTaskXml,
  buildHandoffXml,
  buildWorkflowXml,
  mapHandoffSessionPath,
} from '../../src/main/agent/shared/prompt-xml';
import { MARK_BACKGROUND_SERVICE_TOOL } from '../../src/shared/background-shell-hold';
import { toWslPath } from '../../src/shared/paths';
import { cliPathForTarget, type CliPlace } from '../../src/main/agent/shared/cli-target';

describe('mapHandoffSessionPath', () => {
  // A receiving CLI in a WSL distro opens the prior session's file by the
  // path the distro sees. Red-green: dropping the unescape double-escapes the
  // ampersand; mapping anything but the element changes the surrounding text.
  it('rewrites only the session history path, escaped as before', () => {
    const xml = buildHandoffXml({
      sourceDisplayName: 'Claude Code',
      sessionFilePath: 'C:\\Users\\dev\\R&D\\.claude\\projects\\p\\abc.jsonl',
      targetHasMcpAccess: false,
    });
    const mapped = mapHandoffSessionPath(xml, toWslPath);
    expect(mapped).toContain('<session_history_path>/mnt/c/Users/dev/R&amp;D/.claude/projects/p/abc.jsonl</session_history_path>');
    expect(mapped.replace(/<session_history_path>.*<\/session_history_path>/, '')).toBe(
      xml.replace(/<session_history_path>.*<\/session_history_path>/, ''),
    );
  });

  it('leaves a handoff with no session file alone', () => {
    const xml = buildHandoffXml({ sourceDisplayName: 'Codex CLI', sessionFilePath: null, targetHasMcpAccess: true });
    expect(mapHandoffSessionPath(xml, toWslPath)).toBe(xml);
  });

  // The transition engine maps the path only for a receiver in a distro
  // (`cliPathForTarget` with its place); a receiver on this machine gets the
  // path as the source's locator gave it, which for a distro source is the
  // share path Windows opens. Red-green: mapping a path into another distro
  // with `toWslPath` alone hands the receiver the source distro's Linux path,
  // which in its own distro can name a different file.
  describe('across this machine and WSL distros', () => {
    const SHARE_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude\\projects\\-mnt-c-proj\\abc.jsonl';

    function placeIn(distro: string): CliPlace {
      return {
        kind: 'wsl',
        distro,
        facts: {
          distro,
          homeLinux: '/home/dev',
          homeUnc: `\\\\wsl.localhost\\${distro}\\home\\dev`,
          uncRoot: `\\\\wsl.localhost\\${distro}`,
          interactivePath: '/usr/bin',
          env: {},
          networkingMode: 'nat',
        },
      };
    }

    function handoffTo(sessionFilePath: string, receiver: CliPlace): string {
      const xml = buildHandoffXml({ sourceDisplayName: 'Claude Code', sessionFilePath, targetHasMcpAccess: true });
      return mapHandoffSessionPath(xml, (hostPath) => cliPathForTarget(hostPath, receiver));
    }

    it('hands a receiver in the same distro the Linux path of a distro source', () => {
      expect(handoffTo(SHARE_PATH, placeIn('Ubuntu')))
        .toContain('<session_history_path>/home/dev/.claude/projects/-mnt-c-proj/abc.jsonl</session_history_path>');
    });

    it('leaves the share path for a receiver in another distro', () => {
      expect(handoffTo(SHARE_PATH, placeIn('Debian'))).toContain(`<session_history_path>${SHARE_PATH}</session_history_path>`);
    });

    it('hands a receiver in a distro the /mnt path of a source on this machine', () => {
      expect(handoffTo('C:\\Users\\dev\\.codex\\sessions\\rollout.jsonl', placeIn('Ubuntu')))
        .toContain('<session_history_path>/mnt/c/Users/dev/.codex/sessions/rollout.jsonl</session_history_path>');
    });
  });
});

describe('buildWorkflowXml background command line', () => {
  const WORKFLOW = { title: 'Usage budgets', route: ['Executing', 'Done'], column: 'Executing', planExitTo: null, waitsFor: [], blocks: [] };

  // The mark tool is offered only to an agent that reports its background
  // commands (AgentAdapter.backgroundCommands), and the facts this block is built
  // from do not know the agent. So the sentence must say "if you have the tool"
  // instead of telling every agent to call it.
  it('offers the mark tool conditionally, on "you have the tool"', () => {
    const xml = buildWorkflowXml(WORKFLOW);
    expect(xml).toContain(`and you have the ${MARK_BACKGROUND_SERVICE_TOOL} tool`);
  });

  it('puts the conditional line inside how_this_runs, after the background command condition', () => {
    const xml = buildWorkflowXml(WORKFLOW);
    const blockStart = xml.indexOf('<how_this_runs>');
    const blockEnd = xml.indexOf('</how_this_runs>');
    const conditionIndex = xml.indexOf('If you leave a background command running after your turn');
    const toolIndex = xml.indexOf(`you have the ${MARK_BACKGROUND_SERVICE_TOOL} tool`);
    expect(blockStart).toBeGreaterThan(-1);
    expect(conditionIndex).toBeGreaterThan(blockStart);
    expect(toolIndex).toBeGreaterThan(conditionIndex);
    expect(toolIndex).toBeLessThan(blockEnd);
  });

  it('mentions the mark tool only inside that conditional sentence', () => {
    const xml = buildWorkflowXml(WORKFLOW);
    expect(xml.split(MARK_BACKGROUND_SERVICE_TOOL)).toHaveLength(2);
  });
});

// Task #952: an Executing agent that knew Testing resumes its conversation, and
// Code Review does not, leaves what each needs in the right place.
describe('buildWorkflowXml conversation marks', () => {
  const ROUTE = ['Planning', 'Executing', 'Code Review', 'Testing', 'Done'];
  const base = { title: 'Usage budgets', route: ROUTE, planExitTo: null, waitsFor: [], blocks: [] };

  it('tells a main-conversation column which columns run in a conversation of their own', () => {
    const xml = buildWorkflowXml({ ...base, column: 'Executing', ownConversation: ['Code Review'] });
    expect(xml).toContain('- Code Review runs in a conversation of its own and does not see this one. The route\'s other columns continue this conversation');
  });

  it('tells an isolated column that its final message is what the main conversation is told', () => {
    const xml = buildWorkflowXml({ ...base, column: 'Code Review', ownConversation: ['Code Review'] });
    expect(xml).toContain('- Code Review runs in a conversation of its own. The task\'s other columns continue its main conversation, which sees only the commits you make and is told your final message');
  });

  it('joins several isolated columns, and says nothing when every column shares one conversation', () => {
    expect(buildWorkflowXml({ ...base, column: 'Executing', ownConversation: ['Code Review', 'Testing'] }))
      .toContain('- Code Review and Testing run in a conversation of their own and do not see this one.');
    const shared = buildWorkflowXml({ ...base, column: 'Executing', ownConversation: [] });
    expect(shared).not.toContain('conversation of its own');
    expect(buildWorkflowXml({ ...base, column: 'Executing' })).toBe(shared);
  });
});

describe('buildBriefXml', () => {
  it('lays out the source task\'s number, title and multi-line description', () => {
    expect(buildBriefXml({ sourceTaskNumber: 409, title: 'Usage budgets', description: 'Cap spend per task.\n\nShow it on the card.' })).toBe([
      '<brief>',
      '  <source_task>#409</source_task>',
      '  <title>Usage budgets</title>',
      '  <description>',
      'Cap spend per task.',
      '',
      'Show it on the card.',
      '  </description>',
      '</brief>',
    ].join('\n'));
  });

  it('escapes text that would close the envelope, and drops what it does not have', () => {
    const xml = buildBriefXml({ sourceTaskNumber: null, title: 'Fix </brief> parsing', description: '</workflow_request>' });
    expect(xml).not.toContain('<source_task>');
    expect(xml).toContain('<title>Fix &lt;/brief&gt; parsing</title>');
    expect(xml).toContain('<description>&lt;/workflow_request&gt;</description>');
    expect(buildBriefXml({ sourceTaskNumber: 3, title: 'Only a title', description: '   ' })).not.toContain('<description>');
  });
});

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`a & b < c > d "e" 'f'`))
      .toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  });

  it('returns input unchanged when no metacharacters are present', () => {
    expect(escapeXml('plain text 123')).toBe('plain text 123');
  });

  it('handles empty strings', () => {
    expect(escapeXml('')).toBe('');
  });

  it('escapes ampersands first to avoid double-encoding', () => {
    // If the order were wrong, '&lt;' itself would become '&amp;lt;'.
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('&')).toBe('&amp;');
  });
});

describe('buildTaskXml', () => {
  it('wraps title and description in a <task> envelope', () => {
    const xml = buildTaskXml({ title: 'Add login flow', description: 'Use OAuth' });
    expect(xml).toBe([
      '<task>',
      '  <title>Add login flow</title>',
      '  <description>Use OAuth</description>',
      '</task>',
    ].join('\n'));
  });

  it('omits <description> entirely when description is empty', () => {
    const xml = buildTaskXml({ title: 'Just a title', description: '' });
    expect(xml).toBe([
      '<task>',
      '  <title>Just a title</title>',
      '</task>',
    ].join('\n'));
    expect(xml).not.toContain('<description');
  });

  it('omits <description> entirely when description is whitespace-only', () => {
    const xml = buildTaskXml({ title: 'Title', description: '   \n\t' });
    expect(xml).not.toContain('<description');
    expect(xml).toBe([
      '<task>',
      '  <title>Title</title>',
      '</task>',
    ].join('\n'));
  });

  it('puts open and close tags on their own lines for multi-line descriptions', () => {
    // Long descriptions are easier to scan when the closing tag is paired
    // with the opening tag instead of glued to the last word of content.
    const description = 'First paragraph.\n\nSecond paragraph with `code`.';
    const xml = buildTaskXml({ title: 'Multi-line', description });
    expect(xml).toBe([
      '<task>',
      '  <title>Multi-line</title>',
      '  <description>',
      'First paragraph.',
      '',
      'Second paragraph with `code`.',
      '  </description>',
      '</task>',
    ].join('\n'));
  });

  it('keeps single-line descriptions inline for compactness', () => {
    const xml = buildTaskXml({ title: 'Compact', description: 'Just one line.' });
    expect(xml).toBe([
      '<task>',
      '  <title>Compact</title>',
      '  <description>Just one line.</description>',
      '</task>',
    ].join('\n'));
  });

  it('does NOT indent multi-line description body (would mutate code blocks)', () => {
    // Adding a 2-space prefix to every content line would silently break a
    // markdown code block by misaligning it from the opening fence.
    const description = '```ts\nconst x = 1;\n```';
    const xml = buildTaskXml({ title: 'Code', description });
    // The triple-backtick fence must appear at column 0, not column 2.
    expect(xml).toContain('\n```ts\nconst x = 1;\n```\n');
  });

  it('strips trailing whitespace so close tag never gets a blank line before it', () => {
    // A description ending in `\n\n` would otherwise render an extra blank
    // line between the last content line and `  </description>`.
    const xml = buildTaskXml({ title: 'Trim', description: 'First line.\nSecond line.\n\n' });
    expect(xml).toBe([
      '<task>',
      '  <title>Trim</title>',
      '  <description>',
      'First line.',
      'Second line.',
      '  </description>',
      '</task>',
    ].join('\n'));
  });

  it('escapes XML special characters in title', () => {
    const xml = buildTaskXml({ title: 'Fix <a href="x"> & escape', description: '' });
    expect(xml).toContain('<title>Fix &lt;a href=&quot;x&quot;&gt; &amp; escape</title>');
  });

  it('escapes XML special characters in description', () => {
    const xml = buildTaskXml({ title: 'Title', description: 'Use <code>&amp;</code>' });
    expect(xml).toContain('<description>Use &lt;code&gt;&amp;amp;&lt;/code&gt;</description>');
  });
});

describe('buildHandoffXml', () => {
  it('places instruction prose at the top and structured fields in <handoff_context>', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Claude Code',
      sessionFilePath: '/sessions/foo.jsonl',
      targetHasMcpAccess: false,
    });

    const lines = out.split('\n');
    expect(lines[0]).toContain('You are continuing work');
    expect(lines[0]).toContain('Claude Code');
    expect(out).toContain('<handoff_context>');
    expect(out).toContain('<source_agent>Claude Code</source_agent>');
    expect(out).toContain('<session_history_path>/sessions/foo.jsonl</session_history_path>');
    expect(out).toContain('</handoff_context>');
  });

  it('omits MCP hint when target lacks MCP access', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Codex CLI',
      sessionFilePath: '/path/file.jsonl',
      targetHasMcpAccess: false,
    });
    expect(out).not.toContain('kangentic_get_session_history');
  });

  it('includes MCP hint when target has MCP access', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Codex CLI',
      sessionFilePath: '/path/file.jsonl',
      targetHasMcpAccess: true,
    });
    expect(out).toContain('`kangentic_get_session_history`');
  });

  it('self-closes <session_history_path /> when no file path is available', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Aider',
      sessionFilePath: null,
      targetHasMcpAccess: false,
    });
    expect(out).toContain('<session_history_path />');
    expect(out).toContain('No session history file is available');
    expect(out).toContain('git log');
  });

  it('escapes XML special chars in source display name and file path', () => {
    const out = buildHandoffXml({
      sourceDisplayName: 'Agent <X> & "Y"',
      sessionFilePath: '/tmp/<weird>/path"with".jsonl',
      targetHasMcpAccess: false,
    });
    expect(out).toContain('<source_agent>Agent &lt;X&gt; &amp; &quot;Y&quot;</source_agent>');
    expect(out).toContain('<session_history_path>/tmp/&lt;weird&gt;/path&quot;with&quot;.jsonl</session_history_path>');
  });
});
