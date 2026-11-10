/**
 * Whether a CLI path still resolves to the file detection found, the
 * `command_head_since_detection` tag on a launch report. Runs on real files,
 * since what is under test is how a link swap, a replace and a removal look to
 * `realpath` and `stat`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cliIdentitySinceDetection,
  recordDetectedCliIdentity,
  resetDetectedCliIdentities,
} from '../../src/main/agent/shared/cli-identity';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-identity-'));
  resetDetectedCliIdentities();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeCli(name: string, body: string): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  return filePath;
}

describe('cliIdentitySinceDetection', () => {
  it('reads same for a file nothing touched since detection', () => {
    const cliPath = writeCli('claude', '#!/bin/sh\necho 2.1.319\n');
    recordDetectedCliIdentity(cliPath);

    expect(cliIdentitySinceDetection(cliPath)).toBe('same');
  });

  it('reads unknown for a path detection never found', () => {
    const cliPath = writeCli('claude', '#!/bin/sh\n');

    expect(cliIdentitySinceDetection(cliPath)).toBe('unknown');
  });

  it('reads changed for a file replaced by a rename, as a package manager installs one', () => {
    const cliPath = writeCli('claude', '#!/bin/sh\necho 2.1.319\n');
    recordDetectedCliIdentity(cliPath);
    const replacement = writeCli('claude.new', '#!/bin/sh\necho 2.1.321\n');
    fs.renameSync(replacement, cliPath);

    expect(cliIdentitySinceDetection(cliPath)).toBe('changed');
  });

  it('reads changed for a file rewritten in place to a different size', () => {
    const cliPath = writeCli('claude', '#!/bin/sh\necho 2.1.319\n');
    recordDetectedCliIdentity(cliPath);
    fs.writeFileSync(cliPath, '#!/bin/sh\necho 2.1.319 and a longer line\n');

    expect(cliIdentitySinceDetection(cliPath)).toBe('changed');
  });

  it('reads changed for a file whose size held but whose modified time moved', () => {
    const cliPath = writeCli('claude', '#!/bin/sh\necho 2.1.319\n');
    recordDetectedCliIdentity(cliPath);
    const futureSeconds = Date.now() / 1000 + 3600;
    fs.utimesSync(cliPath, futureSeconds, futureSeconds);

    expect(cliIdentitySinceDetection(cliPath)).toBe('changed');
  });

  it('reads changed for a file that was removed', () => {
    const cliPath = writeCli('claude', '#!/bin/sh\n');
    recordDetectedCliIdentity(cliPath);
    fs.rmSync(cliPath, { force: true });

    expect(cliIdentitySinceDetection(cliPath)).toBe('changed');
  });

  // Creating a symlink on Windows needs developer mode or an elevated process.
  // The native installer's link shape is a POSIX one, and CI's unit tier runs it.
  it.skipIf(process.platform === 'win32')('reads changed for a link pointed at another version, as the native installer updates one', () => {
    const versions = path.join(root, 'versions');
    fs.mkdirSync(versions);
    const oldVersion = path.join(versions, '2.1.319');
    const newVersion = path.join(versions, '2.1.321');
    fs.writeFileSync(oldVersion, '#!/bin/sh\necho 2.1.319\n', { mode: 0o755 });
    fs.writeFileSync(newVersion, '#!/bin/sh\necho 2.1.321\n', { mode: 0o755 });
    const link = path.join(root, 'claude');
    fs.symlinkSync(oldVersion, link);
    recordDetectedCliIdentity(link);
    expect(cliIdentitySinceDetection(link)).toBe('same');

    fs.rmSync(link, { force: true });
    fs.symlinkSync(newVersion, link);

    expect(cliIdentitySinceDetection(link)).toBe('changed');
  });

  it.skipIf(process.platform === 'win32')('reads changed for a link whose target was removed', () => {
    const target = path.join(root, '2.1.319');
    fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
    const link = path.join(root, 'claude');
    fs.symlinkSync(target, link);
    recordDetectedCliIdentity(link);
    fs.rmSync(target, { force: true });

    expect(cliIdentitySinceDetection(link)).toBe('changed');
  });
});
