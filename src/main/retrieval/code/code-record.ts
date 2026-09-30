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
 */

/** Bump when the chunking or the file rules change, so every file re-reads. */
export const CODE_RECORD_VERSION = 2;
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
const SECRET_FILES = /(^|\/)(\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|dsa|ecdsa|ed25519))$|\.(pem|key|p12|pfx|jks|keystore)$/i;
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

/** A file's chunks, or none for one that holds a NUL byte (binary). */
export function codeChunks(path: string, text: string): ChunkInput[] {
  if (text.includes('\u0000')) return [];
  const pieces: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
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
    const chunkText = `${path}\n\n${body}`;
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
