/**
 * Unit tests for readBrowserAutomationConfig in
 * src/main/browser/browser-automation-config.ts.
 *
 * Anchors three invariants:
 *   (a) defaults when no stored value exists - including the security-critical
 *       allowEval:false default;
 *   (b) stored values win over defaults;
 *   (c) a throwing configManager.load() does not propagate and returns defaults.
 *
 * No Electron mocks needed: browser-automation-config.ts has no runtime
 * imports from electron.
 */

import { describe, it, expect } from 'vitest';
import {
  readBrowserAutomationConfig,
  type ResolvedBrowserAutomationConfig,
} from '../../src/main/browser/browser-automation-config';

// Minimal duck-typed stand-in. ConfigManager is a class with many methods;
// readBrowserAutomationConfig only calls .load() and accesses .browserAutomation.
type FakeConfigManager = { load: () => { browserAutomation?: Record<string, unknown> } };

function makeManager(
  browserAutomation?: Record<string, unknown>,
): Parameters<typeof readBrowserAutomationConfig>[0] {
  const manager: FakeConfigManager = {
    load: () => (browserAutomation !== undefined ? { browserAutomation } : {}),
  };
  return manager as unknown as Parameters<typeof readBrowserAutomationConfig>[0];
}

function makeThrowingManager(): Parameters<typeof readBrowserAutomationConfig>[0] {
  const manager: FakeConfigManager = {
    load: () => {
      throw new Error('config unavailable');
    },
  };
  return manager as unknown as Parameters<typeof readBrowserAutomationConfig>[0];
}

describe('readBrowserAutomationConfig', () => {
  it('returns the security-safe defaults when no browserAutomation is stored', () => {
    const result = readBrowserAutomationConfig(makeManager());

    // allowEval:false is the security-critical default - eval is gated off
    // unless explicitly opted in. Any regression that flips this to true
    // would give agents unrestricted arbitrary-JS access without a Settings
    // toggle being set.
    expect(result).toEqual<ResolvedBrowserAutomationConfig>({
      enabled: true,
      allowInteraction: true,
      allowNavigation: true,
      allowEval: false,
      restrictNavigationToLocalhost: false,
    });
  });

  it('stored browserAutomation fields win over defaults', () => {
    const stored = {
      enabled: false,
      allowInteraction: false,
      allowNavigation: true,
      allowEval: true,
      restrictNavigationToLocalhost: true,
    };
    const result = readBrowserAutomationConfig(makeManager(stored));

    expect(result.enabled).toBe(false);
    expect(result.allowInteraction).toBe(false);
    expect(result.allowNavigation).toBe(true);
    // allowEval:true from stored value should override the off default
    expect(result.allowEval).toBe(true);
    expect(result.restrictNavigationToLocalhost).toBe(true);
  });

  it('partial stored object uses defaults for omitted fields', () => {
    // Only override allowEval; the rest should fall back to defaults.
    const result = readBrowserAutomationConfig(makeManager({ allowEval: true }));

    expect(result.allowEval).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.allowInteraction).toBe(true);
    expect(result.allowNavigation).toBe(true);
    expect(result.restrictNavigationToLocalhost).toBe(false);
  });

  it('does not throw and returns all defaults when load() throws', () => {
    expect(() => readBrowserAutomationConfig(makeThrowingManager())).not.toThrow();

    const result = readBrowserAutomationConfig(makeThrowingManager());
    expect(result).toEqual<ResolvedBrowserAutomationConfig>({
      enabled: true,
      allowInteraction: true,
      allowNavigation: true,
      allowEval: false,
      restrictNavigationToLocalhost: false,
    });
  });
});
