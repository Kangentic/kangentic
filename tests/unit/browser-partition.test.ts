/**
 * Unit tests for src/shared/browser-partition.ts.
 *
 * The pane's cookie jar is keyed by TASK IDENTITY (project id + task id), not by
 * the worktree path, so it follows the task through any relocate/rename/Done
 * round-trip. The names are self-describing (`kng-<proj>-<task>` and
 * `kng-<proj>-identity`) so the sweep can parse them back. Determinism, the name
 * format, and round-trip parsing are the load-bearing properties, since the
 * renderer and main both derive and (for the sweep) parse the same names.
 */

import { describe, it, expect } from 'vitest';
import {
  BROWSER_PARTITION,
  LEGACY_BROWSER_PARTITION_DIR_NAME,
  browserPartitionForProjectIdentity,
  browserPartitionForTask,
  isKngPartitionDirName,
  isLegacyWorktreeJarDirName,
  parseKngPartitionDir,
  partitionDirName,
} from '../../src/shared/browser-partition';

const PROJECT = '11111111-2222-3333-4444-555555555555';
const PROJECT_NORM = '11111111222233334444555555555555';
const TASK = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TASK_NORM = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';

describe('BROWSER_PARTITION', () => {
  it('is the legacy shared jar and its dir name', () => {
    expect(BROWSER_PARTITION).toBe('persist:kangentic-browser');
    expect(LEGACY_BROWSER_PARTITION_DIR_NAME).toBe('kangentic-browser');
  });
});

describe('browserPartitionForTask', () => {
  it('is deterministic and self-describing (hyphen-stripped, lowercased ids)', () => {
    const partition = browserPartitionForTask(PROJECT, TASK);
    expect(partition).toBe(`persist:kng-${PROJECT_NORM}-${TASK_NORM}`);
    expect(browserPartitionForTask(PROJECT, TASK)).toBe(partition);
    expect(browserPartitionForTask(PROJECT.toUpperCase(), TASK.toUpperCase())).toBe(partition);
  });

  it('gives distinct tasks distinct partitions and does not depend on any path', () => {
    const a = browserPartitionForTask(PROJECT, 'aaaaaaaa-0000-0000-0000-000000000000');
    const b = browserPartitionForTask(PROJECT, 'bbbbbbbb-0000-0000-0000-000000000000');
    expect(a).not.toBe(b);
  });

  it('falls back to the legacy jar when a project or task id is missing', () => {
    expect(browserPartitionForTask(null, TASK)).toBe(BROWSER_PARTITION);
    expect(browserPartitionForTask(PROJECT, null)).toBe(BROWSER_PARTITION);
    expect(browserPartitionForTask('', '')).toBe(BROWSER_PARTITION);
  });
});

describe('browserPartitionForProjectIdentity', () => {
  it('is the per-project identity jar', () => {
    expect(browserPartitionForProjectIdentity(PROJECT)).toBe(`persist:kng-${PROJECT_NORM}-identity`);
  });

  it('is distinct from any task jar in the same project', () => {
    expect(browserPartitionForProjectIdentity(PROJECT)).not.toBe(browserPartitionForTask(PROJECT, TASK));
  });

  it('falls back to the legacy jar when no project id is known', () => {
    expect(browserPartitionForProjectIdentity(null)).toBe(BROWSER_PARTITION);
  });
});

describe('partitionDirName', () => {
  it('strips the persist: prefix', () => {
    expect(partitionDirName(browserPartitionForTask(PROJECT, TASK))).toBe(`kng-${PROJECT_NORM}-${TASK_NORM}`);
    expect(partitionDirName(BROWSER_PARTITION)).toBe('kangentic-browser');
  });
});

describe('parseKngPartitionDir', () => {
  it('round-trips a task jar back to its normalized project and task ids', () => {
    const name = partitionDirName(browserPartitionForTask(PROJECT, TASK));
    expect(parseKngPartitionDir(name)).toEqual({ kind: 'task', projectId: PROJECT_NORM, taskId: TASK_NORM });
  });

  it('round-trips an identity jar back to its project id', () => {
    const name = partitionDirName(browserPartitionForProjectIdentity(PROJECT));
    expect(parseKngPartitionDir(name)).toEqual({ kind: 'identity', projectId: PROJECT_NORM });
  });

  it('returns null for the legacy jar, the old scheme, and foreign names', () => {
    expect(parseKngPartitionDir('kangentic-browser')).toBeNull();
    expect(parseKngPartitionDir('kngbrowser-abcd1234')).toBeNull();
    expect(parseKngPartitionDir('kng-shortproj-shorttask')).toBeNull();
    expect(parseKngPartitionDir('some-other-consumer')).toBeNull();
  });
});

describe('isKngPartitionDirName', () => {
  it('accepts current-scheme task and identity jars only', () => {
    expect(isKngPartitionDirName(partitionDirName(browserPartitionForTask(PROJECT, TASK)))).toBe(true);
    expect(isKngPartitionDirName(partitionDirName(browserPartitionForProjectIdentity(PROJECT)))).toBe(true);
    expect(isKngPartitionDirName('kngbrowser-abcd1234')).toBe(false);
    expect(isKngPartitionDirName('kangentic-browser')).toBe(false);
  });
});

describe('isLegacyWorktreeJarDirName', () => {
  it('matches the abandoned pre-task-keying scheme only', () => {
    expect(isLegacyWorktreeJarDirName('kngbrowser-abcd1234')).toBe(true);
    expect(isLegacyWorktreeJarDirName('kngbrowser-DEADBEEF')).toBe(false);
    expect(isLegacyWorktreeJarDirName(partitionDirName(browserPartitionForTask(PROJECT, TASK)))).toBe(false);
    expect(isLegacyWorktreeJarDirName('kangentic-browser')).toBe(false);
  });
});
