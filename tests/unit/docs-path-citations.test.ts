/**
 * Every `docs/...md` path the repo cites must exist. Source comments, skills, rules, agents, user
 * strings and the root markdown name doc files by path, and a moved doc (task 889 moved
 * agent-integration.md into docs/integrations/agents/) leaves each of those citations pointing at
 * nothing, with no link checker anywhere to say so. A GitHub URL into this repo's docs counts too.
 *
 * docs/ is scanned too: okf-docs-conformance.test.ts resolves its markdown links, but a doc that
 * names another as a backticked path is not a link, and one such citation outlived the move.
 *
 * Out of scope: CHANGELOG files and docs/log.md (history, never rewritten), tests (their docs/ paths
 * are mostly made-up fixture paths), URLs into any other site, whose docs/ paths are not this repo's,
 * and a git object spec (`<commit>:docs/x.md`), which names a file as it was at that commit, the way
 * scripts/measure-docs-structure.mjs reads the flat agent doc from before the split.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const ROOT_FILES = new Set(['CLAUDE.md', 'CONTRIBUTING.md', 'README.md']);
const SKIPPED = [/(^|\/)CHANGELOG[^/]*\.md$/i, /^scripts\/review-eval\/verdict-replay\.json$/, /^docs\/log\.md$/];
/** A docs path, wherever it starts (a bare path, `../../docs/...`, a GitHub URL). */
const DOCS_PATH = /(?<![\w-])docs\/[\w./-]*?\.md(?![\w])/g;
/** A URL into anywhere but this repository, whose docs/ paths are not ours. */
const FOREIGN_URL = /https?:\/\/(?!github\.com\/kangentic\/kangentic\/)[^\s)\]'"`>]+/gi;
/** A git object spec naming a docs file at a commit, which may be gone from the tree by design. */
const GIT_OBJECT_SPEC = /\b[0-9a-f]{7,40}:docs\/[\w./-]*?\.md(?![\w])/g;

function scannedFiles(): string[] {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf-8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /^(src|scripts|\.claude|demo|docs)\//.test(file) || /^packages\/[^/]+\/README\.md$/.test(file) || ROOT_FILES.has(file))
    .filter((file) => !SKIPPED.some((pattern) => pattern.test(file)))
    .filter((file) => fs.existsSync(path.join(ROOT, file)));
}

/** Every docs path `text` cites, outside URLs into other sites. */
function citedDocsPaths(text: string): string[] {
  return [...text.replace(FOREIGN_URL, '').replace(GIT_OBJECT_SPEC, '').matchAll(DOCS_PATH)].map((match) => match[0]);
}

describe('docs path citations', () => {
  it('finds docs paths in a bare path, a relative link and a GitHub URL, and skips other sites', () => {
    expect(citedDocsPaths('see docs/integrations/agents/codex-cli.md and [x](../../docs/mcp-server.md#tools)')).toEqual(['docs/integrations/agents/codex-cli.md', 'docs/mcp-server.md']);
    expect(citedDocsPaths('https://github.com/kangentic/kangentic/blob/main/docs/command-injection.md#per-adapter-support-matrix')).toEqual(['docs/command-injection.md']);
    expect(citedDocsPaths('upstream https://example.com/docs/en/wire-mode.md and src/content/docs/dev/contributing.mdx')).toEqual([]);
  });

  it('skips a git object spec, which names a file at a commit, and still checks a bare path beside it', () => {
    expect(citedDocsPaths("value('--flat', '492f0c474:docs/agent-integration.md') and docs/mcp-server.md")).toEqual(['docs/mcp-server.md']);
    expect(citedDocsPaths('see docs/agent-integration.md')).toEqual(['docs/agent-integration.md']);
  });

  it('cites only docs files that exist', () => {
    const files = scannedFiles();
    const missing: string[] = [];
    let cited = 0;
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      if (!text.includes('docs/') || text.includes('\u0000')) continue;
      for (const docsPath of citedDocsPaths(text)) {
        cited += 1;
        if (!fs.existsSync(path.join(ROOT, docsPath))) missing.push(`${file} cites ${docsPath}`);
      }
    }
    expect(missing, 'a moved or deleted doc is still cited; point the citation at the doc that holds the section now').toEqual([]);
    // Not vacuous: the scan read source, skills and rules, and found real citations.
    expect(files.some((file) => file.startsWith('src/'))).toBe(true);
    expect(files.some((file) => file.startsWith('.claude/'))).toBe(true);
    expect(files.some((file) => file.startsWith('docs/'))).toBe(true);
    expect(cited).toBeGreaterThan(50);
  });
});
