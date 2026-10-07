import { describe, it, expect, beforeEach } from 'vitest';
import { noteRequestSpan, takeRequestSpans, resetRequestSpansForTests } from '../../../src/main/mobile-bridge/request-spans';

describe('request spans', () => {
  beforeEach(() => {
    resetRequestSpansForTests();
  });

  it('collects every span for one request in order, and forgets them once taken', () => {
    noteRequestSpan('device-1', 'req-1', 'seed 412 ms, 180k chars');
    noteRequestSpan('device-1', 'req-1', 'transcript 30 ms');
    expect(takeRequestSpans('device-1', 'req-1')).toEqual(['seed 412 ms, 180k chars', 'transcript 30 ms']);
    expect(takeRequestSpans('device-1', 'req-1')).toEqual([]);
  });

  it('keeps two devices that reuse a requestId apart', () => {
    noteRequestSpan('device-1', 'req-1', 'from one');
    noteRequestSpan('device-2', 'req-1', 'from two');
    expect(takeRequestSpans('device-2', 'req-1')).toEqual(['from two']);
    expect(takeRequestSpans('device-1', 'req-1')).toEqual(['from one']);
  });

  it('evicts the oldest request once 256 are held, so spans a dropped session never collects cannot grow the map', () => {
    for (let index = 0; index < 257; index++) noteRequestSpan('device-1', `req-${index}`, `span ${index}`);
    expect(takeRequestSpans('device-1', 'req-0')).toEqual([]);
    expect(takeRequestSpans('device-1', 'req-1')).toEqual(['span 1']);
    expect(takeRequestSpans('device-1', 'req-256')).toEqual(['span 256']);
  });
});
