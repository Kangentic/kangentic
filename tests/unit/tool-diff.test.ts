import { describe, it, expect } from 'vitest';
import { computeLineDiff, parseFileEditTool, diffStats } from '../../src/shared/tool-diff';

describe('computeLineDiff', () => {
  it('marks a changed line remove-then-add and keeps surrounding context', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('treats an empty old text as an all-added block (a fresh Write)', () => {
    expect(computeLineDiff('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('is all-context for identical text', () => {
    expect(computeLineDiff('same', 'same')).toEqual([{ type: 'context', text: 'same' }]);
  });
});

describe('parseFileEditTool', () => {
  it('parses an Edit shape into one hunk', () => {
    expect(parseFileEditTool({ file_path: '/a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      filePath: '/a.ts',
      hunks: [{ oldText: 'x', newText: 'y' }],
    });
  });

  it('parses a MultiEdit shape into several hunks', () => {
    const result = parseFileEditTool({
      file_path: '/a.ts',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 'p', new_string: 'q' },
      ],
    });
    expect(result?.hunks).toHaveLength(2);
    expect(result?.filePath).toBe('/a.ts');
  });

  it('parses a Write shape into an all-added hunk', () => {
    expect(parseFileEditTool({ file_path: '/a.ts', content: 'hello' })).toEqual({
      filePath: '/a.ts',
      hunks: [{ oldText: '', newText: 'hello' }],
    });
  });

  it('returns null for a non-edit tool or non-object input', () => {
    expect(parseFileEditTool({ pattern: 'foo' })).toBeNull();
    expect(parseFileEditTool(null)).toBeNull();
    expect(parseFileEditTool('x')).toBeNull();
    expect(parseFileEditTool(['a'])).toBeNull();
  });

  it('returns null for a Write-shaped input that has content but no file_path', () => {
    // The Write branch requires filePath truthy; content alone is not enough
    // to identify a file-edit shape.
    expect(parseFileEditTool({ content: 'hello' })).toBeNull();
  });

  it('drops only the invalid entries from a MultiEdit edits array, keeping the valid hunks', () => {
    const result = parseFileEditTool({
      file_path: '/a.ts',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 123, new_string: 'z' }, // wrong type, dropped
        { not_a_valid_edit: true }, // missing both fields, dropped
        { old_string: 'p', new_string: 'q' },
      ],
    });

    expect(result).toEqual({
      filePath: '/a.ts',
      hunks: [
        { oldText: 'x', newText: 'y' },
        { oldText: 'p', newText: 'q' },
      ],
    });
  });

  it('returns null for a MultiEdit whose edits array is empty or entirely invalid', () => {
    expect(parseFileEditTool({ file_path: '/a.ts', edits: [] })).toBeNull();
    expect(
      parseFileEditTool({
        file_path: '/a.ts',
        edits: [{ foo: 'bar' }, { old_string: 1, new_string: 2 }],
      }),
    ).toBeNull();
  });
});

describe('diffStats', () => {
  it('counts added and removed lines across hunks', () => {
    expect(diffStats([{ oldText: 'a\nb', newText: 'a\nc\nd' }])).toEqual({ added: 2, removed: 1 });
  });
});
