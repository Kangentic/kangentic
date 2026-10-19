import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CRASHPAD_PIPE_NAME_ENV_KEY,
  childProcessEnv,
  withoutCrashpadPipeName,
} from '../../src/main/shared/child-env';

const PIPE_NAME = '\\\\.\\pipe\\crashpad_1234_ABCDEFGHIJKLMNOP';

describe('CRASHPAD_PIPE_NAME_ENV_KEY', () => {
  it('is the name Chromium sets in the browser process on Windows', () => {
    expect(CRASHPAD_PIPE_NAME_ENV_KEY).toBe('CHROME_CRASHPAD_PIPE_NAME');
  });
});

describe('withoutCrashpadPipeName', () => {
  it('drops the pipe name and keeps every other key', () => {
    const environment = withoutCrashpadPipeName({ PATH: '/bin', HOME: '/home/dev', CHROME_CRASHPAD_PIPE_NAME: PIPE_NAME });
    expect(environment).toEqual({ PATH: '/bin', HOME: '/home/dev' });
  });

  it('matches the name case-insensitively, as Windows environment names are', () => {
    const environment = withoutCrashpadPipeName({ Chrome_Crashpad_Pipe_Name: PIPE_NAME, OTHER: 'kept' });
    expect(environment).toEqual({ OTHER: 'kept' });
  });

  it('drops unset values, which a child never receives anyway', () => {
    expect(withoutCrashpadPipeName({ SET: 'value', UNSET: undefined })).toEqual({ SET: 'value' });
  });

  it('returns a copy and leaves its input alone', () => {
    const input: NodeJS.ProcessEnv = { CHROME_CRASHPAD_PIPE_NAME: PIPE_NAME, OTHER: 'kept' };
    const environment = withoutCrashpadPipeName(input);
    expect(environment).not.toBe(input);
    expect(input.CHROME_CRASHPAD_PIPE_NAME).toBe(PIPE_NAME);
  });
});

describe('childProcessEnv', () => {
  const hermeticKeys = [CRASHPAD_PIPE_NAME_ENV_KEY, 'KANGENTIC_CHILD_ENV_TEST'] as const;
  let savedHostValues: Record<string, string | undefined>;

  beforeEach(() => {
    savedHostValues = {};
    for (const key of hermeticKeys) {
      savedHostValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of hermeticKeys) {
      if (savedHostValues[key] === undefined) delete process.env[key];
      else process.env[key] = savedHostValues[key];
    }
  });

  it('copies main\'s environment without the pipe name, and main keeps its own', () => {
    process.env[CRASHPAD_PIPE_NAME_ENV_KEY] = PIPE_NAME;
    process.env.KANGENTIC_CHILD_ENV_TEST = 'inherited';
    const environment = childProcessEnv();
    expect(environment[CRASHPAD_PIPE_NAME_ENV_KEY]).toBeUndefined();
    expect(environment.KANGENTIC_CHILD_ENV_TEST).toBe('inherited');
    // Kangentic's own renderer, GPU and utility processes find the handler
    // through main's copy, so it must survive every child launch.
    expect(process.env[CRASHPAD_PIPE_NAME_ENV_KEY]).toBe(PIPE_NAME);
  });

  it('lays the overrides over main\'s environment', () => {
    process.env.KANGENTIC_CHILD_ENV_TEST = 'inherited';
    expect(childProcessEnv({ KANGENTIC_CHILD_ENV_TEST: 'override' }).KANGENTIC_CHILD_ENV_TEST).toBe('override');
  });

  it('drops a pipe name that rides the overrides too', () => {
    expect(childProcessEnv({ [CRASHPAD_PIPE_NAME_ENV_KEY]: PIPE_NAME })[CRASHPAD_PIPE_NAME_ENV_KEY]).toBeUndefined();
  });
});
