/**
 * resolveTask (src/main/agent/commands/task-resolver.ts): an MCP tool's `taskId`
 * is either the board's numeric display id (with or without its `#`) or the
 * task's UUID. A display id is tried first when the input is a positive integer,
 * and the UUID lookup is the fallback.
 *
 * The repository is a two-method fake: the resolver's whole contract is which
 * lookup it asks and with what.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type { Task } from '../../src/shared/types';
import { resolveTask } from '../../src/main/agent/commands/task-resolver';

const TASK_UUID = '3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6b';

/** Only the identity fields the resolver's callers compare; the rest of a Task is not read here. */
function taskStub(id: string, displayId: number): Task {
  return { id, display_id: displayId } as unknown as Task;
}

describe('resolveTask', () => {
  let getByDisplayId: ReturnType<typeof vi.fn>;
  let getById: ReturnType<typeof vi.fn>;
  let repository: TaskRepository;

  beforeEach(() => {
    getByDisplayId = vi.fn(() => undefined);
    getById = vi.fn(() => undefined);
    repository = { getByDisplayId, getById } as unknown as TaskRepository;
  });

  describe('a display id', () => {
    const taskTwelve = taskStub(TASK_UUID, 12);

    beforeEach(() => {
      getByDisplayId.mockImplementation((displayId: number) => (displayId === 12 ? taskTwelve : undefined));
    });

    it.each([
      ['a bare number', '12'],
      ['a number with its #', '#12'],
      ['a number with its # and surrounding spaces', ' #12 '],
    ])('resolves %s by display id 12, as a number', (_label, input) => {
      expect(resolveTask(repository, input)).toBe(taskTwelve);

      expect(getByDisplayId).toHaveBeenCalledTimes(1);
      expect(getByDisplayId).toHaveBeenCalledWith(12);
      expect(getById).not.toHaveBeenCalled();
    });
  });

  describe('a UUID', () => {
    it('resolves by id and never looks up a display id', () => {
      const task = taskStub(TASK_UUID, 12);
      getById.mockImplementation((id: string) => (id === TASK_UUID ? task : undefined));

      expect(resolveTask(repository, TASK_UUID)).toBe(task);

      expect(getById).toHaveBeenCalledWith(TASK_UUID);
      expect(getByDisplayId).not.toHaveBeenCalled();
    });

    it('is undefined when no task has that id', () => {
      expect(resolveTask(repository, TASK_UUID)).toBeUndefined();
    });
  });

  describe('a display id that no task has', () => {
    it('falls back to the id lookup with the input as given', () => {
      // A task whose id is the digits themselves is still found.
      const taskWithNumericId = taskStub('12', 7);
      getById.mockImplementation((id: string) => (id === '12' ? taskWithNumericId : undefined));

      expect(resolveTask(repository, '12')).toBe(taskWithNumericId);

      expect(getByDisplayId).toHaveBeenCalledWith(12);
      expect(getById).toHaveBeenCalledWith('12');
    });

    it('is undefined when the fallback finds nothing either', () => {
      expect(resolveTask(repository, '#99')).toBeUndefined();

      expect(getByDisplayId).toHaveBeenCalledWith(99);
      expect(getById).toHaveBeenCalledWith('#99');
    });

    it('prefers the display id match over an id lookup for the same digits', () => {
      const byDisplayId = taskStub(TASK_UUID, 12);
      getByDisplayId.mockReturnValue(byDisplayId);
      getById.mockReturnValue(taskStub('12', 7));

      expect(resolveTask(repository, '12')).toBe(byDisplayId);
      expect(getById).not.toHaveBeenCalled();
    });
  });

  describe('an input that is not a positive whole number', () => {
    it.each([
      ['zero', '0'],
      ['a negative number', '-3'],
      ['a decimal', '1.5'],
      ['empty text', ''],
      ['spaces only', '   '],
      ['a name', 'twelve'],
      ['a lone #', '#'],
    ])('never looks up a display id for %s, and goes to the id lookup', (_label, input) => {
      expect(resolveTask(repository, input)).toBeUndefined();

      expect(getByDisplayId).not.toHaveBeenCalled();
      expect(getById).toHaveBeenCalledWith(input);
    });
  });
});
