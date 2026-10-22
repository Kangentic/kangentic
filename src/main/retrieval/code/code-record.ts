import crypto from 'node:crypto';
import { estimateTokens } from '../token-estimate';
import type { ChunkInput } from '../types';

/**
 * Source code as the memory index holds it: the `code` corpus, one document
 * per tracked file on the project's default branch (doc id = its path), found
 * by meaning when a question is asked.
 *
 * Only what explains the product goes in: source and docs. Tests and fixtures
 * are most of a tree's text (17,000 of this repository's 29,437 chunks) and
 * answer "how does it work" worse than the code they test; data files, lock
 * files, binaries, minified and generated output, and anything over 256 KB say
 * nothing a question asks. What is left here: 1,488 of 3,143 tracked files,
 * 12,186 chunks.
 *
 * Chunks split at top-level declarations and pack up to 1,600 characters,
 * each opening with the file's path, so a passage reads as being from its
 * file. The measured retrieval (`corpora.ts`) was taken on exactly these
 * chunks; a change here re-measures before it ships.
 *
 * A markdown file's leading YAML frontmatter (the OKF concepts under docs/,
 * the .claude rules and skills) is not text a question matches: it is
 * dropped, and its `description` goes on the line after the path, so every
 * passage of a concept carries its one-line summary. Version 4 made that
 * change without a re-measure: a file with no frontmatter chunks exactly as
 * before (tests/unit/code-corpus.test.ts pins it), and a markdown file only
 * loses the YAML block and gains a line.
 */

/** Bump when the chunking or the file rules change, so every file re-reads.
 *  The re-read also removes a file the rules now skip, and an unchanged
 *  passage keeps its embedding, so a bump costs a read of the branch. */
export const CODE_RECORD_VERSION = 4;
/** Files bigger than this are skipped: generated, vendored, or data. */
export const CODE_MAX_FILE_BYTES = 256 * 1024;
const CHUNK_CHARS = 1_600;

const SKIP_NAMES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/;
const SKIP_PATHS = /(^|\/)(dist|build|out|vendor|node_modules|\.next|coverage)\//;
const MINIFIED = /\.min\.(js|css)$/;
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|pdf|zip|gz|tgz|7z|rar|woff2?|ttf|otf|eot|mp[34]|mov|webm|wav|ogg|exe|dll|so|dylib|node|wasm|onnx|bin|dat|db|sqlite)$/i;
const TESTS_AND_FIXTURES = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|e2e|spec)\/|\.(test|spec)\.[a-z]+$/i;
const DATA_FILES = /\.(json|ya?ml|toml|csv|svg|snap|lock)$/i;
/** Keys and credential files, committed or not: a passage is handed to the
 *  answering agent, so none of these may ever become one. */
const SECRET_FILES = /(^|\/)(\.env(\..+)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|\.pgpass|\.dockercfg|\.s3cfg|\.aws\/credentials|id_(rsa|dsa|ecdsa|ed25519))$|\.(pem|key|p12|pfx|jks|keystore|ppk|p8|tfvars|tfstate)$/i;
/** A line that starts a top-level declaration, where a chunk may break. */
const DECLARATION = /^(export |function |class |interface |type |const |let |async function |def |fn |pub |func |impl |struct |enum |module |describe\(|it\(|test\()/;

/** Whether a tracked file at `path` (forward slashes, repository-relative) is indexed. */
export function isIndexableCodePath(path: string): boolean {
  return !SKIP_NAMES.test(path)
    && !SKIP_PATHS.test(path)
    && !MINIFIED.test(path)
    && !BINARY_EXTENSIONS.test(path)
    && !TESTS_AND_FIXTURES.test(path)
    && !DATA_FILES.test(path)
    && !SECRET_FILES.test(path);
}

const MARKDOWN = /\.mdx?$/i;
/** A leading `---` line (after an optional BOM), the block, which may be empty, and the closing
 *  `---` line. scripts/docs-bundle.mjs reads the same blocks for /sync-docs and the docs tests, and
 *  tests/unit/code-corpus.test.ts checks the two agree on this repository's markdown. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;
/** A line a YAML block holds: a key, a list item, an indented continuation, or a comment. */
const YAML_LINE = /^(?:[A-Za-z_][\w-]*:(?:\s|$)|-(?:\s|$)|\s+\S|\s*#)/;
const YAML_KEY = /^[A-Za-z_][\w-]*:(?:\s|$)/;
const DESCRIPTION_KEY = /^description:[ \t]*/;
/** A block scalar's indicator (`>`, `|-`, ...), whose text is the indented lines after it. */
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

/**
 * A markdown file's text without its leading YAML block, and the block's `description`, if any.
 * A block whose lines do not read as YAML, such as the text between two horizontal rules at the
 * top of a document, is body text, so the file chunks as if it had no frontmatter.
 */
export function splitMarkdownFrontmatter(text: string): { body: string; description: string | null } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { body: text, description: null };
  const block = match[1] ?? '';
  const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
  const readsAsYaml = lines.every((line) => YAML_LINE.test(line)) && lines.some((line) => YAML_KEY.test(line));
  if (lines.length > 0 && !readsAsYaml) return { body: text, description: null };
  return { body: text.slice(match[0].length), description: frontmatterDescription(block) };
}

/**
 * The block's `description` as one line. A quoted scalar is unescaped; a block scalar (the
 * `description: |` every .claude agent writes) and a plain scalar that wraps give the first
 * paragraph of their text, folded with spaces.
 */
function frontmatterDescription(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => DESCRIPTION_KEY.test(line));
  if (start === -1) return null;
  const value = lines[start].replace(DESCRIPTION_KEY, '').trim();
  const continuation: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    continuation.push(line.trim());
  }
  const blankAt = continuation.indexOf('');
  const firstParagraph = (blankAt === -1 ? continuation : continuation.slice(0, blankAt)).join(' ');
  let description: string;
  if (BLOCK_SCALAR.test(value)) {
    description = firstParagraph;
  } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    description = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  } else if (value.length >= 2 && value.startsWith('\'') && value.endsWith('\'')) {
    description = value.slice(1, -1).replace(/''/g, '\'');
  } else {
    description = [value, firstParagraph].filter((part) => part.length > 0).join(' ');
  }
  return description.length > 0 ? description : null;
}

/** A file's chunks, or none for one that holds a NUL byte (binary). */
export function codeChunks(path: string, text: string): ChunkInput[] {
  if (text.includes('\u0000')) return [];
  const markdown = MARKDOWN.test(path) ? splitMarkdownFrontmatter(text) : null;
  const content = markdown ? markdown.body : text;
  const header = markdown?.description ? `${path}\n${markdown.description}` : path;
  const pieces: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    if (DECLARATION.test(line) && current.length > 0) {
      pieces.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current) pieces.push(current);
  const bodies: string[] = [];
  let buffer = '';
  for (const piece of pieces) {
    if (piece.length > CHUNK_CHARS) {
      if (buffer) {
        bodies.push(buffer);
        buffer = '';
      }
      for (let start = 0; start < piece.length; start += CHUNK_CHARS) bodies.push(piece.slice(start, start + CHUNK_CHARS));
      continue;
    }
    if (buffer.length + piece.length > CHUNK_CHARS) {
      bodies.push(buffer);
      buffer = '';
    }
    buffer += piece;
  }
  if (buffer) bodies.push(buffer);
  return bodies.map((body, seq) => {
    const chunkText = `${header}\n\n${body}`;
    return {
      seq,
      text: chunkText,
      contentHash: crypto.createHash('sha1').update(chunkText).digest('hex'),
      tokenEstimate: estimateTokens(chunkText),
      role: 'code',
      tsStart: null,
      tsEnd: null,
      turnUuidStart: null,
      turnUuidEnd: null,
    };
  });
}

/** Whether a question names a code identifier (camelCase, snake_case, a dotted
 *  name or a backticked word). Such questions score low by meaning even when
 *  the right file ranks near the top, so the code floor is lower for them. */
export function namesCodeIdentifier(question: string): boolean {
  return /`[^`]+`|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b|\b[A-Za-z_]+\.[A-Za-z_]+\(?/.test(question);
}
