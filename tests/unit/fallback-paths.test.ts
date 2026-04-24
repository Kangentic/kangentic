/**
 * Unit tests for standardUnixFallbackPaths() and enumerateNvmPaths()
 * (Gap 2).
 *
 * Covers:
 * - Windows guard: returns [] without touching fs
 * - Non-Windows: returns expected static paths
 * - enumerateNvmPaths happy path: version dirs map to <dir>/<ver>/bin/<name>
 * - enumerateNvmPaths: ~/.nvm/versions/node does not exist -> returns []
 * - enumerateNvmPaths: readdirSync throws -> returns [] silently
 *
 * Mocks `node:fs` (existsSync, readdirSync), `node:os` (homedir), and
 * flips process.platform via Object.defineProperty following the same
 * pattern used in shell-env.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      readdirSync: vi.fn().mockReturnValue([]),
    },
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn().mockReturnValue('/home/dev'),
    },
  };
});

import fs from 'node:fs';
import os from 'node:os';
import { standardUnixFallbackPaths } from '../../src/main/agent/shared/fallback-paths';

// ── Helpers ──────────────────────────────────────────────────────────────────

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Normalize all backslashes to forward slashes in an array of paths.
 * path.join() on Windows emits backslash separators, but the static
 * path strings in fallback-paths.ts use forward slashes in the
 * path.join() call sites. On Windows the result has backslashes, so
 * we normalize before comparing to keep the tests cross-platform.
 */
function normalizePaths(paths: string[]): string[] {
  return paths.map((p) => p.replace(/\\/g, '/'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('standardUnixFallbackPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/home/dev');
    // Default: ~/.nvm/versions/node does not exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  // ── Windows guard ──────────────────────────────────────────────────────────

  it('returns [] on Windows without touching fs', () => {
    setPlatform('win32');

    const result = standardUnixFallbackPaths('testcli');

    expect(result).toEqual([]);
    expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.readdirSync)).not.toHaveBeenCalled();
  });

  // ── Non-Windows: static path entries ─────────────────────────────────────

  it('returns Homebrew Apple Silicon path on macOS', () => {
    setPlatform('darwin');

    const result = normalizePaths(standardUnixFallbackPaths('mycli'));

    expect(result).toContain('/opt/homebrew/bin/mycli');
  });

  it('returns Homebrew Intel / npm-global path on macOS', () => {
    setPlatform('darwin');

    const result = normalizePaths(standardUnixFallbackPaths('mycli'));

    expect(result).toContain('/usr/local/bin/mycli');
  });

  it('returns Linuxbrew path on Linux', () => {
    setPlatform('linux');

    const result = normalizePaths(standardUnixFallbackPaths('mycli'));

    expect(result).toContain('/home/linuxbrew/.linuxbrew/bin/mycli');
  });

  it('returns home-relative paths using os.homedir()', () => {
    setPlatform('darwin');
    vi.mocked(os.homedir).mockReturnValue('/Users/testuser');

    const result = normalizePaths(standardUnixFallbackPaths('mycli'));

    expect(result).toContain('/Users/testuser/.npm-global/bin/mycli');
    expect(result).toContain('/Users/testuser/.volta/bin/mycli');
    expect(result).toContain('/Users/testuser/.bun/bin/mycli');
    expect(result).toContain('/Users/testuser/.local/bin/mycli');
    expect(result).toContain('/Users/testuser/.cargo/bin/mycli');
    expect(result).toContain('/Users/testuser/bin/mycli');
  });

  it('includes binaryName in every static path', () => {
    setPlatform('linux');

    const result = normalizePaths(standardUnixFallbackPaths('specialcli'));

    // All static entries should end with the binary name
    const staticPaths = result.filter((p) => !p.includes('.nvm'));
    expect(staticPaths.length).toBeGreaterThan(0);
    for (const candidatePath of staticPaths) {
      expect(candidatePath.endsWith('/specialcli')).toBe(true);
    }
  });

  // ── enumerateNvmPaths happy path ───────────────────────────────────────────

  it('enumerates nvm version dirs and maps to <dir>/<ver>/bin/<name>', () => {
    setPlatform('darwin');
    vi.mocked(os.homedir).mockReturnValue('/home/dev');

    // ~/.nvm/versions/node exists and has two version directories.
    // The existsSync check in enumerateNvmPaths uses path.join which on
    // Windows emits backslashes, so we normalize the incoming path for comparison.
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return String(filePath).replace(/\\/g, '/') === '/home/dev/.nvm/versions/node';
    });
    vi.mocked(fs.readdirSync).mockReturnValue(
      ['v18.20.0', 'v20.10.0'] as unknown as ReturnType<typeof fs.readdirSync>,
    );

    const result = normalizePaths(standardUnixFallbackPaths('testcli'));

    expect(result).toContain('/home/dev/.nvm/versions/node/v18.20.0/bin/testcli');
    expect(result).toContain('/home/dev/.nvm/versions/node/v20.10.0/bin/testcli');
  });

  it('appends nvm paths after the static entries', () => {
    setPlatform('darwin');
    vi.mocked(os.homedir).mockReturnValue('/home/dev');

    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return String(filePath).replace(/\\/g, '/') === '/home/dev/.nvm/versions/node';
    });
    vi.mocked(fs.readdirSync).mockReturnValue(
      ['v20.0.0'] as unknown as ReturnType<typeof fs.readdirSync>,
    );

    const result = normalizePaths(standardUnixFallbackPaths('testcli'));

    const nvmIndex = result.findIndex((p) => p.includes('.nvm'));
    const homebrewIndex = result.findIndex((p) => p.includes('/opt/homebrew'));

    expect(nvmIndex).toBeGreaterThan(homebrewIndex);
  });

  // ── enumerateNvmPaths: directory does not exist ────────────────────────────

  it('returns no nvm entries when ~/.nvm/versions/node does not exist', () => {
    setPlatform('linux');
    // existsSync returns false by default (set in beforeEach)

    const result = standardUnixFallbackPaths('testcli');

    const nvmPaths = result.filter((p) => p.includes('.nvm'));
    expect(nvmPaths).toHaveLength(0);
    expect(vi.mocked(fs.readdirSync)).not.toHaveBeenCalled();
  });

  // ── enumerateNvmPaths: readdirSync throws ─────────────────────────────────

  it('returns no nvm entries and does not throw when readdirSync throws', () => {
    setPlatform('darwin');

    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === '/home/dev/.nvm/versions/node';
    });
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    // Should not throw
    let result: string[] = [];
    expect(() => {
      result = standardUnixFallbackPaths('testcli');
    }).not.toThrow();

    const nvmPaths = result.filter((p) => p.includes('.nvm'));
    expect(nvmPaths).toHaveLength(0);
  });

  // ── Return value is always an array ───────────────────────────────────────

  it('always returns an array (never null/undefined)', () => {
    setPlatform('darwin');

    const result = standardUnixFallbackPaths('testcli');

    expect(Array.isArray(result)).toBe(true);
  });

  it('always returns an array on Windows (never null/undefined)', () => {
    setPlatform('win32');

    const result = standardUnixFallbackPaths('testcli');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});
