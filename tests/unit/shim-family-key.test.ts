/**
 * shimFamilyKey puts a CLI and its npm shim siblings under one key. The Codex
 * hook trust read and the Ollama think-level cache both store a value under
 * the path discovery saw and look it up under the sibling a Windows spawn
 * launches, so a key that kept the extension or the case would miss.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shimFamilyKey } from '../../src/main/agent/shared/shim-family-key';

describe('shimFamilyKey', () => {
  let savedPlatformDescriptor: PropertyDescriptor | undefined;
  const stubPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  };

  beforeEach(() => {
    savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (savedPlatformDescriptor !== undefined) {
      Object.defineProperty(process, 'platform', savedPlatformDescriptor);
    }
  });

  it('strips a shim extension and lowercases on win32', () => {
    stubPlatform('win32');
    expect(shimFamilyKey('C:\\Users\\dev\\npm\\Ollama.CMD')).toBe('c:\\users\\dev\\npm\\ollama');
    expect(shimFamilyKey('C:\\Users\\dev\\npm\\ollama.ps1')).toBe('c:\\users\\dev\\npm\\ollama');
    expect(shimFamilyKey('C:\\Users\\dev\\npm\\ollama.bat')).toBe('c:\\users\\dev\\npm\\ollama');
  });

  it('strips a shim extension but keeps case on linux', () => {
    stubPlatform('linux');
    expect(shimFamilyKey('/Opt/Dev/Ollama.cmd')).toBe('/Opt/Dev/Ollama');
  });

  it('leaves a path with no shim extension unchanged on linux', () => {
    stubPlatform('linux');
    expect(shimFamilyKey('/usr/bin/ollama')).toBe('/usr/bin/ollama');
  });
});
