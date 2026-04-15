import { describe, it, expect } from 'vitest';
import { parseAsanaUrl, buildAsanaLabel } from '../../src/main/boards/adapters/asana/url-parser';

describe('parseAsanaUrl', () => {
  describe('legacy format', () => {
    it('parses a project root URL', () => {
      expect(parseAsanaUrl('https://app.asana.com/0/1234567890').repository).toBe('1234567890');
    });

    it('parses a list-view URL', () => {
      expect(parseAsanaUrl('https://app.asana.com/0/1234567890/list').repository).toBe('1234567890');
    });

    it('parses a board-view URL', () => {
      expect(parseAsanaUrl('https://app.asana.com/0/1234567890/board').repository).toBe('1234567890');
    });

    it('parses a calendar-view URL', () => {
      expect(parseAsanaUrl('https://app.asana.com/0/1234567890/calendar').repository).toBe('1234567890');
    });

    it('parses a task-detail URL (still scopes to project)', () => {
      expect(parseAsanaUrl('https://app.asana.com/0/1234567890/9876543210').repository).toBe('1234567890');
    });

    it('tolerates a trailing query string', () => {
      expect(parseAsanaUrl('https://app.asana.com/0/1234567890/list?focus=true').repository).toBe('1234567890');
    });
  });

  describe('newer format', () => {
    it('parses /1/<workspace>/project/<project_gid>', () => {
      expect(parseAsanaUrl('https://app.asana.com/1/42/project/1234567890').repository).toBe('1234567890');
    });

    it('parses /1/<workspace>/project/<project_gid>/list', () => {
      expect(parseAsanaUrl('https://app.asana.com/1/42/project/1234567890/list').repository).toBe('1234567890');
    });
  });

  describe('error cases', () => {
    it('throws for a non-Asana URL', () => {
      expect(() => parseAsanaUrl('https://github.com/owner/repo')).toThrow('Invalid Asana project URL');
    });

    it('throws for app.asana.com root', () => {
      expect(() => parseAsanaUrl('https://app.asana.com/')).toThrow('Invalid Asana project URL');
    });

    it('throws for a non-numeric project segment', () => {
      expect(() => parseAsanaUrl('https://app.asana.com/0/not-a-gid/list')).toThrow('Invalid Asana project URL');
    });
  });
});

describe('buildAsanaLabel', () => {
  it('prefixes the project GID for display', () => {
    expect(buildAsanaLabel('1234567890')).toBe('Asana project 1234567890');
  });
});
