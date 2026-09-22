import { describe, it, expect } from 'vitest';
import { resolveGpuNotice, GPU_NOTICE_MESSAGE } from '../../src/renderer/utils/gpu-notice';

/**
 * The should-we-say-anything decision for the graphics recovery toast
 * (Sentry DESKTOP-18 / DESKTOP-W).
 *
 * The message itself is fixed text, so what is worth pinning is the gate and
 * the copy discipline: this notice is the ONLY thing that tells a user their
 * app came back degraded, and it must not fire on a launch that is running
 * normally.
 */
describe('resolveGpuNotice', () => {
  it('speaks up on the launch that recovered from a GPU-fatal run', () => {
    expect(resolveGpuNotice({ softwareRendering: true, noticePending: true })).toEqual({
      message: GPU_NOTICE_MESSAGE,
    });
  });

  it('stays silent on every later software-rendered launch', () => {
    // main consumes `noticePending` on read, so only the first launch after
    // the incident carries it. The Settings callout is the standing record
    // from then on; a toast on every start would be nagging.
    expect(resolveGpuNotice({ softwareRendering: true, noticePending: false })).toBeNull();
  });

  it('stays silent on a normal launch', () => {
    expect(resolveGpuNotice({ softwareRendering: false, noticePending: false })).toBeNull();
  });

  it('stays silent on an incoherent status rather than claiming something false', () => {
    // main only arms the notice on a launch it put into software rendering,
    // so this pair should be impossible. If it happens anyway, telling
    // someone their acceleration is off while it is on is worse than saying
    // nothing.
    expect(resolveGpuNotice({ softwareRendering: false, noticePending: true })).toBeNull();
  });

  it('survives a missing status', () => {
    expect(resolveGpuNotice(null)).toBeNull();
    expect(resolveGpuNotice(undefined)).toBeNull();
  });

  it('claims no cause and quotes no tally', () => {
    // Both were in earlier drafts and both were cut deliberately. We never
    // established what killed the GPU process, so naming the display driver
    // would be a confident guess; and a failure count is evidence for us,
    // not guidance for the reader. Sentry gets both.
    expect(GPU_NOTICE_MESSAGE).not.toMatch(/driver/i);
    expect(GPU_NOTICE_MESSAGE).not.toMatch(/\d/);
    // "repeated", not "5 times", which also means the resolver never has to
    // choose between "failed" and "failed once".
    expect(GPU_NOTICE_MESSAGE).toContain('Repeated failures');
  });
});
