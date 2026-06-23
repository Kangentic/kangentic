import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashString,
  hashFilePath,
  contentMatchesFile,
  atomicWriteJson,
  computeFingerprint,
} from '../../src/main/config/board-config/atomic-write';

describe('board-config/atomic-write', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('hashString', () => {
    it('returns a stable sha256 hex digest', () => {
      expect(hashString('hello')).toBe(hashString('hello'));
      expect(hashString('hello')).not.toBe(hashString('world'));
      expect(hashString('hello')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('hashFilePath', () => {
    it('hashes an existing file', () => {
      const filePath = path.join(tempDir, 'sample.json');
      fs.writeFileSync(filePath, '{"hello":"world"}');
      const hash = hashFilePath(filePath);
      expect(hash).toBe(hashString('{"hello":"world"}'));
    });

    it('returns null for a missing file', () => {
      expect(hashFilePath(path.join(tempDir, 'missing.json'))).toBeNull();
    });
  });

  describe('contentMatchesFile', () => {
    it('matches when on-disk content is structurally identical', () => {
      const filePath = path.join(tempDir, 'config.json');
      const config = { version: 1, columns: [], actions: [], transitions: [] };
      atomicWriteJson(filePath, config);

      const result = contentMatchesFile(filePath, config);
      expect(result.matches).toBe(true);
      expect(result.contentHash).toBeTruthy();
    });

    it('does not match when the new config differs', () => {
      const filePath = path.join(tempDir, 'config.json');
      atomicWriteJson(filePath, { version: 1, columns: [] });

      const result = contentMatchesFile(filePath, { version: 1, columns: [{ name: 'A' }] });
      expect(result.matches).toBe(false);
    });

    it('ignores _modifiedBy fingerprint when comparing', () => {
      const filePath = path.join(tempDir, 'config.json');
      atomicWriteJson(filePath, { version: 1, columns: [], _modifiedBy: 'alice' });

      const result = contentMatchesFile(filePath, { version: 1, columns: [], _modifiedBy: 'bob' });
      expect(result.matches).toBe(true);
    });

    it('returns matches=false and contentHash=null for missing file', () => {
      const result = contentMatchesFile(path.join(tempDir, 'missing.json'), { version: 1 });
      expect(result.matches).toBe(false);
      expect(result.contentHash).toBeNull();
    });
  });

  describe('atomicWriteJson', () => {
    it('writes via tmp file and returns the content hash', () => {
      const filePath = path.join(tempDir, 'config.json');
      const value = { version: 1, columns: [{ name: 'A' }] };
      const hash = atomicWriteJson(filePath, value);

      const written = fs.readFileSync(filePath, 'utf-8');
      expect(JSON.parse(written)).toEqual(value);
      expect(hash).toBe(hashString(written));
    });

    it('appends a trailing LF newline (never CRLF, for cross-platform hash stability)', () => {
      const filePath = path.join(tempDir, 'config.json');
      atomicWriteJson(filePath, { version: 1 });
      const written = fs.readFileSync(filePath, 'utf-8');
      expect(written.endsWith('\n')).toBe(true);
      expect(written.endsWith('\r\n')).toBe(false);
    });

    it('overwrites an existing file atomically', () => {
      const filePath = path.join(tempDir, 'config.json');
      atomicWriteJson(filePath, { version: 1 });
      atomicWriteJson(filePath, { version: 2 });
      const written = fs.readFileSync(filePath, 'utf-8');
      expect(JSON.parse(written).version).toBe(2);
    });
  });

  describe('computeFingerprint', () => {
    it('returns a stable 12-char hex string for the current machine', () => {
      const first = computeFingerprint();
      const second = computeFingerprint();
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{12}$/);
    });

    it('falls back without throwing when os.userInfo() fails (minimal containers)', () => {
      const userInfoSpy = vi.spyOn(os, 'userInfo').mockImplementation(() => {
        throw new Error('uid has no passwd entry');
      });
      try {
        expect(() => computeFingerprint()).not.toThrow();
        expect(computeFingerprint()).toMatch(/^[0-9a-f]{12}$/);
      } finally {
        userInfoSpy.mockRestore();
      }
    });
  });
});
