/**
 * docs/ holds Open Knowledge Format v0.2 concepts (task 889): a folder with an `index.md` is a
 * concept folder, every markdown file in it carries frontmatter, and its index lists each concept
 * with the concept's own description. The rest of docs/ is still flat markdown with no frontmatter,
 * because the pilot split did not save an agent any reading (docs/log.md), so the rollout stopped.
 *
 * Checked here, through the same helpers /sync-docs uses (scripts/docs-bundle.mjs):
 *
 * 1. Every file in a concept folder has frontmatter, and any frontmatter in docs/ has a `type` from
 *    the closed vocabulary, a title, a one-line description, and `sources:` paths that exist.
 * 2. Every index.md lists each sibling concept, with its exact description, and carries no
 *    frontmatter but `okf_version`.
 * 3. Every relative link in docs/ resolves to a file, and a fragment into a markdown file matches one
 *    of its headings by GitHub's anchor rules.
 * 4. No file in docs/ is named like an agent's instruction file. On a case-insensitive filesystem
 *    Claude Code read docs/integrations/agents/claude.md as a CLAUDE.md and put the whole doc into an
 *    agent's context; Gemini CLI, Warp and others load GEMINI.md, WARP.md and AGENTS.md the same way.
 * 5. log.md dates its entries `## YYYY-MM-DD`, newest first.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONCEPT_TYPES,
  RESERVED_NAMES,
  anchorsOf,
  conceptsForSource,
  githubSlug,
  headingsOf,
  linksOf,
  listDocsMarkdown,
  parseFrontmatter,
  sourcePathOf,
} from '../../scripts/docs-bundle.mjs';

const ROOT = path.resolve(__dirname, '../..');
const DOCS = path.join(ROOT, 'docs');

/** Names an agent CLI loads as instructions when it reads a folder, compared case-insensitively. */
const INSTRUCTION_FILE_NAMES = ['claude.md', 'claude.local.md', 'agents.md', 'gemini.md', 'qwen.md', 'warp.md', 'grok.md'];

interface Frontmatter {
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  sources?: Array<string | { resource: string; title?: string }>;
  [key: string]: unknown;
}

const repoTextCache = new Map<string, string>();

/** A repo file's text, read once per run: several checks below read the same docs. */
function readRepo(repoPath: string): string {
  if (!repoTextCache.has(repoPath)) repoTextCache.set(repoPath, fs.readFileSync(path.join(ROOT, repoPath), 'utf-8'));
  return repoTextCache.get(repoPath) as string;
}

const docsFiles: string[] = listDocsMarkdown(DOCS);
const conceptFolders = [...new Set(docsFiles.filter((file) => path.posix.basename(file) === 'index.md').map((file) => path.posix.dirname(file)))];

describe('docs concept folders', () => {
  it('finds the docs and at least one concept folder (not vacuous)', () => {
    expect(docsFiles.length).toBeGreaterThan(20);
    expect(conceptFolders).toContain('docs/integrations/agents');
  });

  it('gives every file in a concept folder frontmatter', () => {
    const missing = docsFiles
      .filter((file) => conceptFolders.includes(path.posix.dirname(file)) && !RESERVED_NAMES.has(path.posix.basename(file)))
      .filter((file) => parseFrontmatter(readRepo(file)) === null);
    expect(missing, 'a concept in a folder with an index.md needs frontmatter').toEqual([]);
  });

  it('gives all frontmatter a known type, a title, a one-line description, and sources that exist', () => {
    const problems: string[] = [];
    for (const file of docsFiles.filter((entry) => !RESERVED_NAMES.has(path.posix.basename(entry)))) {
      const frontmatter = parseFrontmatter(readRepo(file)) as Frontmatter | null;
      if (frontmatter === null) continue;
      if (!frontmatter.type || !CONCEPT_TYPES.includes(frontmatter.type)) problems.push(`${file}: type "${frontmatter.type ?? ''}" is not one of ${CONCEPT_TYPES.join(', ')}`);
      if (!frontmatter.title) problems.push(`${file}: no title`);
      if (!frontmatter.description || /\n/.test(frontmatter.description)) problems.push(`${file}: description must be one non-empty line`);
      if (frontmatter.tags !== undefined && !Array.isArray(frontmatter.tags)) problems.push(`${file}: tags must be a list`);
      for (const entry of frontmatter.sources ?? []) {
        const source = sourcePathOf(entry);
        if (!source || !fs.existsSync(path.join(ROOT, source))) problems.push(`${file}: source "${source}" does not exist`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('lists every sibling concept in its index.md with that concept\'s own description', () => {
    const problems: string[] = [];
    for (const folder of conceptFolders) {
      const indexPath = `${folder}/index.md`;
      const indexText = readRepo(indexPath);
      const indexFrontmatter = parseFrontmatter(indexText) as Frontmatter | null;
      if (indexFrontmatter !== null) {
        const extra = Object.keys(indexFrontmatter).filter((key) => key !== 'okf_version');
        if (extra.length > 0) problems.push(`${indexPath}: an index.md may carry only okf_version, not ${extra.join(', ')}`);
      }
      const entries = new Map<string, string>();
      for (const line of indexText.split(/\r?\n/)) {
        // `* [Title](file.md) - description`: the link's file (no fragment) and the description after it.
        const match = /^\* \[[^\]]+\]\(([^)#]+)\) - (.+)$/.exec(line);
        if (match) entries.set(match[1], match[2].trim());
      }
      const siblings = docsFiles.filter((file) => path.posix.dirname(file) === folder && !RESERVED_NAMES.has(path.posix.basename(file)));
      for (const sibling of siblings) {
        const name = path.posix.basename(sibling);
        const description = (parseFrontmatter(readRepo(sibling)) as Frontmatter | null)?.description;
        if (!entries.has(name)) problems.push(`${indexPath}: no "* [Title](${name}) - description" entry`);
        else if (entries.get(name) !== description) problems.push(`${indexPath}: the entry for ${name} does not match its description: "${description}"`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('docs links', () => {
  it('resolves every relative link to a file, and every fragment into a markdown file to a heading', () => {
    const anchorCache = new Map<string, Set<string>>();
    const anchors = (repoPath: string): Set<string> => {
      if (!anchorCache.has(repoPath)) anchorCache.set(repoPath, anchorsOf(readRepo(repoPath)));
      return anchorCache.get(repoPath) as Set<string>;
    };
    const broken: string[] = [];
    let fragments = 0;
    for (const file of docsFiles) {
      for (const link of linksOf(readRepo(file))) {
        const target = link.path === '' ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), link.path));
        if (!fs.existsSync(path.join(ROOT, target))) {
          broken.push(`${file}:${link.line} links to a missing file: ${link.url}`);
          continue;
        }
        if (link.fragment && target.endsWith('.md')) {
          fragments += 1;
          if (!anchors(target).has(link.fragment)) broken.push(`${file}:${link.line} links to a missing heading: ${link.url}`);
        }
      }
    }
    expect(broken).toEqual([]);
    expect(fragments, 'the fragment check read real fragment links').toBeGreaterThan(100);
  });
});

describe('docs file names', () => {
  it('names no file like an agent CLI\'s instruction file', () => {
    const offenders = fs.readdirSync(DOCS, { recursive: true, encoding: 'utf-8' })
      .filter((entry) => INSTRUCTION_FILE_NAMES.includes(path.basename(entry).toLowerCase()));
    expect(offenders, 'rename it after the product (claude-code.md, gemini-cli.md)').toEqual([]);
  });
});

describe('docs/log.md', () => {
  it('dates every entry heading and keeps the newest first', () => {
    const headings = headingsOf(readRepo('docs/log.md')).filter((heading: { level: number }) => heading.level === 2).map((heading: { text: string }) => heading.text);
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) expect(heading).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...headings].sort().reverse()).toEqual(headings);
  });
});

describe('the bundle helpers', () => {
  it('numbers a repeated heading the way GitHub does', () => {
    const slugs = headingsOf('# A\n## Permission Modes\n### Permission Modes\n## Permission Modes 1\n## Permission Modes\n```\n## Not a heading\n```\n').map((heading: { slug: string }) => heading.slug);
    expect(slugs).toEqual(['a', 'permission-modes', 'permission-modes-1', 'permission-modes-1-1', 'permission-modes-2']);
    expect(githubSlug('Global Config Writes (`~/.claude.json`)')).toBe('global-config-writes-claudejson');
    expect(githubSlug('`plan-approval-bridge.js`')).toBe('plan-approval-bridgejs');
    expect(githubSlug('Kimi Code -> Authentication')).toBe('kimi-code---authentication');
  });

  it('reads the frontmatter shape a concept carries', () => {
    const text = [
      '---',
      'type: Reference',
      'title: Codex CLI',
      'description: "Moves a task: with a colon, and a \\"quote\\""',
      'tags: [agents, "codex, cli"]',
      'sources:',
      '  - resource: src/main/agent/adapters/codex/',
      '  - resource: src/shared/types.ts',
      '    title: AgentCapabilities, CommandOptions',
      '---',
      '# Body',
      '',
    ].join('\n');
    expect(parseFrontmatter(text)).toEqual({
      type: 'Reference',
      title: 'Codex CLI',
      description: 'Moves a task: with a colon, and a "quote"',
      tags: ['agents', 'codex, cli'],
      sources: [{ resource: 'src/main/agent/adapters/codex/' }, { resource: 'src/shared/types.ts', title: 'AgentCapabilities, CommandOptions' }],
    });
    expect(parseFrontmatter('# No frontmatter\n')).toBeNull();
    expect(() => parseFrontmatter('---\nnot a key\n---\n')).toThrow(/not a top-level key/);
  });

  it('maps a source file to the concepts that list it or a folder above it', () => {
    const concepts = [
      { path: 'docs/a.md', frontmatter: { sources: [{ resource: 'src/main/agent/adapters/codex/' }] } },
      { path: 'docs/b.md', frontmatter: { sources: [{ resource: 'src/main/agent/agent-adapter.ts' }] } },
      { path: 'docs/c.md', frontmatter: null },
    ];
    expect(conceptsForSource('src/main/agent/adapters/codex/command-builder.ts', concepts).map((concept: { path: string }) => concept.path)).toEqual(['docs/a.md']);
    expect(conceptsForSource('src/main/agent/agent-adapter.ts', concepts).map((concept: { path: string }) => concept.path)).toEqual(['docs/b.md']);
    expect(conceptsForSource('src/main/agent/adapters/codex-cli.ts', concepts)).toEqual([]);
  });
});
