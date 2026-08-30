import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('@aptabase/electron/main', () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

import { sanitizeErrorMessage } from '../../src/main/analytics/analytics';

describe('sanitizeErrorMessage', () => {
  it('strips Windows drive paths', () => {
    const message = 'Error loading C:\\Users\\dev\\projects\\kangentic\\src\\main\\index.ts';
    expect(sanitizeErrorMessage(message)).toBe('Error loading <path>');
  });

  it('strips Unix home and /Users paths', () => {
    const homeMessage = 'ENOENT: no such file, open /home/dev/app/config.json';
    expect(sanitizeErrorMessage(homeMessage)).toBe('ENOENT: no such file, open <path>');

    const macMessage = 'Module not found: /Users/dev/kangentic/node_modules/foo';
    expect(sanitizeErrorMessage(macMessage)).toBe('Module not found: <path>');
  });

  it('strips paths but preserves surrounding text', () => {
    const message = 'Failed at C:\\Users\\dev\\app.ts: Cannot read properties of undefined';
    const result = sanitizeErrorMessage(message);
    expect(result).toBe('Failed at <path>: Cannot read properties of undefined');
  });

  it('truncates to the Aptabase server-side cap (180 characters)', () => {
    const longMessage = 'A'.repeat(300);
    expect(sanitizeErrorMessage(longMessage)).toHaveLength(180);
  });
});
