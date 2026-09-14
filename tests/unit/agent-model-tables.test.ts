import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces the model-discovery half of .claude/rules/cli-features-over-custom-layers.md.
//
// We do not track model releases. A curated list of model names or ids is stale the day a
// vendor ships, and a stale list is worse than none: it offers models the CLI no longer
// serves and hides the ones it does. Cursor shipped exactly that - an eight-entry fallback
// naming GPT-4o and Claude 3.5 Sonnet, while the CLI served 224 other models.
//
// An adapter gets its models by asking the CLI or by deriving the label from the id. So a
// vendor model string that names a SPECIFIC model has no business in adapter code.
//
// Two deliberate narrowings keep this scan honest rather than merely loud:
//
//  1. Comments are stripped. Adapters quote real session JSON and real CLI output in their
//     doc blocks, which is documentation of a wire format, not a table.
//  2. The patterns all require a VERSION component. That is what separates a table entry
//     (`claude-opus-4.6`, `GPT-5.4`) from an id-derivation helper, which matches on a bare
//     family prefix (`prettifyModelId`'s 'gpt-' / 'claude-', antigravityModelDisplayName's
//     'gpt' / 'oss'). Those helpers are the sanctioned alternative to a table, so a scan
//     that flagged them would be arguing against the rule it enforces.
//
// That second narrowing is also this scan's known blind spot: a curated list whose entries
// carry no digit (`['Composer', 'Auto', 'Fast']`) reads as clean. Widening the patterns to
// catch it would flag the id-derivation helpers too, so the miss is accepted and the rule
// leaves that half to review. Do not read a green run as proof no table exists.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/main/agent/adapters';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Patterns naming a specific model. Each requires a version/generation component, so a
 * family prefix used for id derivation does not trip them.
 */
const VENDOR_MODEL_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'gpt-<version>', regex: /\bgpt-\d/i },
  { label: 'claude-<family>', regex: /\bclaude-(?:opus|sonnet|haiku|fable)\b/i },
  { label: 'claude-<version>', regex: /\bclaude-\d/i },
  { label: 'gemini-<version>', regex: /\bgemini-\d/i },
  { label: 'composer-<version>', regex: /\bcomposer-\d/i },
  { label: 'grok-<version>', regex: /\bgrok-\d/i },
  { label: 'kimi-k<version>', regex: /\bkimi-k\d/i },
  { label: 'glm-<version>', regex: /\bglm-\d/i },
  { label: 'qwen<version>', regex: /\bqwen[-.]?\d/i },
  { label: 'GPT-<version> display form', regex: /\bGPT-\d/ },
  { label: 'Claude family display form', regex: /\b(?:Opus|Sonnet|Haiku|Fable)\s+\d/ },
  { label: 'Gemini display form', regex: /\bGemini\s+\d/ },
  { label: 'Qwen display form', regex: /\bQwen[\s-]?\d/ },
];

/**
 * The one sanctioned exception. Granularity is the FILE, not the symbol: an entry exempts
 * everything in it, so a second vendor-model string added to an allowlisted file rides in
 * unflagged. Keep these files small and single-purpose, or the exemption widens silently.
 *
 * Copilot's MODEL_PATTERNS is a RECOGNIZER, not a picker: it reads a model name back out of
 * ANSI-stripped TUI text when the NDJSON path is unavailable. It never reaches a dropdown
 * and is never handed to `--model`, so going stale degrades a label rather than misdirecting
 * a spawn. That is a different failure class from the one the rule bans.
 *
 * Adding an entry here is a deliberate decision, not a way to quiet a red test. If the code
 * feeds a picker or a `--model` value, discover it from the CLI instead.
 */
const ALLOWLIST: Array<{ file: string; reason: string }> = [
  {
    file: 'src/main/agent/adapters/copilot/stream-parser.ts',
    reason:
      'MODEL_PATTERNS is a recognizer that scrapes a model name out of Copilot TUI text, not a '
      + 'picker list. Stale means an unrecognized label, never a model offered that the CLI cannot run.',
  },
];

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Blank out comment lines so a doc block quoting real CLI output or session JSON does not
 * read as a table. Returns one entry per input line, preserving line numbers.
 *
 * Line-based on purpose, matching `esbuild-cjs-imports.test.ts`'s `isCommentLine`. A
 * character-level tokenizer has to track string and template state to know whether a `//`
 * is a comment at all, and a single desync silently blanks or un-blanks the rest of the
 * file. Here the worst case is a truncated string literal containing `//`, which costs a
 * missed match on text that is a URL, never a model name.
 */
function stripCommentLines(source: string): string[] {
  const output: string[] = [];
  let inBlockComment = false;
  for (const line of source.split('\n')) {
    if (inBlockComment) {
      output.push('');
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      output.push('');
      continue;
    }
    if (trimmed.startsWith('/*')) {
      output.push('');
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    // A code line: drop any trailing line comment, and any single-line block comment.
    output.push(line.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, ''));
  }
  return output;
}

describe('no curated model tables in agent adapters', () => {
  it('adapters name no specific vendor model in live code', () => {
    const allowedFiles = new Set(ALLOWLIST.map((entry) => entry.file));
    const offenders: string[] = [];
    const absoluteDir = path.join(REPO_ROOT, SCAN_DIR);

    for (const filePath of collectSourceFiles(absoluteDir)) {
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      if (allowedFiles.has(relativePath)) continue;
      const lines = stripCommentLines(fs.readFileSync(filePath, 'utf-8'));
      lines.forEach((line, index) => {
        for (const { label, regex } of VENDOR_MODEL_PATTERNS) {
          if (regex.test(line)) {
            offenders.push(`${relativePath}:${index + 1} (${label}) ${line.trim()}`);
            return;
          }
        }
      });
    }

    expect(
      offenders,
      'Agent adapters must discover models from the CLI or derive the label from the id, never '
      + 'keep a list to maintain. See .claude/rules/cli-features-over-custom-layers.md.\nOffenders:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every allowlist entry points at a real file and records why', () => {
    for (const entry of ALLOWLIST) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry.file)), `${entry.file} is missing`).toBe(true);
      expect(entry.reason.length, `${entry.file} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('the scan actually fires on a curated list', () => {
    // Guards against a future edit quietly neutering the patterns. This is the shape that
    // shipped in Cursor's adapter, minus the wrapper.
    const curatedList = `const MODELS = ['claude-3.5-sonnet', 'gpt-4-turbo'];`;
    const fired = VENDOR_MODEL_PATTERNS.some(({ regex }) => regex.test(curatedList));
    expect(fired, 'the vendor-model patterns no longer detect a curated list').toBe(true);
  });

  it('the scan does not fire on an id-derivation helper', () => {
    // prettifyModelId / antigravityModelDisplayName match on a bare family prefix. They are
    // the sanctioned alternative to a table and must stay clean.
    const derivation = `if (lowered.startsWith('gpt-')) return \`GPT-\${rest}\`;`;
    const fired = VENDOR_MODEL_PATTERNS.some(({ regex }) => regex.test(derivation));
    expect(fired, 'the patterns now flag id derivation, which the rule prescribes').toBe(false);
  });

  it('comment stripping covers every comment shape and keeps line numbers stable', () => {
    const source = [
      'const a = 1;',
      '// claude-opus-4.6',
      '/**',
      ' * gemini-3-pro',
      ' */',
      '/* opening',
      'claude-sonnet-4.5 with no leading star',
      '*/',
      'const b = 2; // gpt-5.4',
      'const c = 3;',
    ].join('\n');
    const stripped = stripCommentLines(source);
    expect(stripped.length).toBe(source.split('\n').length);
    const hit = stripped.some((line) => VENDOR_MODEL_PATTERNS.some(({ regex }) => regex.test(line)));
    expect(hit, 'a comment shape survived stripping').toBe(false);
    // Code on those lines must survive.
    expect(stripped[0]).toContain('const a = 1;');
    expect(stripped[8]).toContain('const b = 2;');
  });
});
