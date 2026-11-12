/**
 * What an agent's publish and the unrecognised-domain report do with a link
 * (#1056). A user loses: a tracker link an agent mentioned filling the
 * Artifacts list, a publish title stuck on the wrong one of several links, or
 * (the privacy half) a private host name, a path or a repeat reaching error
 * reporting.
 *
 * Red-green: drop the `detection !== 'manual'` filter in `publishedArtifacts`
 * and the tracker case fails; drop the `isPrivateHost` check and the private
 * host case fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  active: true,
  reportHandledMessage: vi.fn(),
  claimed: new Set<string>(),
}));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  isErrorReportingActive: () => mocks.active,
  reportHandledMessage: mocks.reportHandledMessage,
}));

vi.mock('../../src/main/analytics/usage', () => ({
  claimArtifactDomainReport: (domain: string) => {
    if (mocks.claimed.has(domain)) return false;
    mocks.claimed.add(domain);
    return true;
  },
}));

import { publishedArtifacts } from '../../src/main/artifacts/artifact-detection';
import {
  reportAddedArtifactDomains,
  reportUnrecognisedArtifactDomains,
  unrecognisedArtifactDomain,
} from '../../src/main/artifacts/artifact-domain-report';
import type { TaskArtifact } from '../../src/shared/types';

const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';
const GOOGLE_DOC = 'https://docs.google.com/document/d/1xR4abc/edit';

describe('publishedArtifacts', () => {
  it('keeps recognised links and drops the others', () => {
    const result = publishedArtifacts({ urls: [FIGMA, 'https://example.org/page', MIRO], title: 'Mock' });
    expect(result.map((artifact) => artifact.url)).toEqual([FIGMA, MIRO]);
  });

  it('keeps a document the agent published', () => {
    expect(publishedArtifacts({ urls: [GOOGLE_DOC], title: null }).map((artifact) => artifact.url)).toEqual([GOOGLE_DOC]);
  });

  it('drops a tracker link', () => {
    expect(publishedArtifacts({ urls: ['https://github.com/owner/repo/issues/3'], title: 'Issue' })).toEqual([]);
  });

  it('names the link with the title only when exactly one link was recognised', () => {
    expect(publishedArtifacts({ urls: [FIGMA], title: 'Checkout' })).toEqual([{ url: FIGMA, name: 'Checkout' }]);
    expect(publishedArtifacts({ urls: [FIGMA, MIRO], title: 'Checkout' })).toEqual([
      { url: FIGMA, name: null },
      { url: MIRO, name: null },
    ]);
  });

  it('counts only recognised links when deciding whether the title is unambiguous', () => {
    expect(publishedArtifacts({ urls: [FIGMA, 'https://example.org/x'], title: 'Checkout' })).toEqual([{ url: FIGMA, name: 'Checkout' }]);
  });

  it('gives nothing for no links', () => {
    expect(publishedArtifacts({ urls: [], title: 'x' })).toEqual([]);
  });
});

describe('unrecognisedArtifactDomain', () => {
  it('is null for a recognised platform', () => {
    expect(unrecognisedArtifactDomain(FIGMA)).toBeNull();
  });

  it.each(['http://localhost:3000/design', 'https://build-server/x', 'http://10.0.0.5/x', 'https://wiki.internal/page'])(
    'is null for the private host in %s',
    (link) => {
      expect(unrecognisedArtifactDomain(link)).toBeNull();
    },
  );

  it('treats a fully qualified name\'s trailing dot as not part of the host', () => {
    expect(unrecognisedArtifactDomain('https://example.com./a')).toBe('example.com');
    expect(unrecognisedArtifactDomain('https://example.com./a')).toBe(unrecognisedArtifactDomain('https://example.com/b'));
    expect(unrecognisedArtifactDomain('https://nas.local./x')).toBeNull();
  });

  it('is null for something that is not a link', () => {
    expect(unrecognisedArtifactDomain('not a link')).toBeNull();
    expect(unrecognisedArtifactDomain('ftp://example.org/x')).toBeNull();
  });

  it('is the host without www, in lower case, and never the path', () => {
    expect(unrecognisedArtifactDomain('https://www.Example.org/secret/path?token=1#frag')).toBe('example.org');
  });
});

describe('reporting unrecognised artifact domains', () => {
  beforeEach(() => {
    mocks.active = true;
    mocks.claimed.clear();
    mocks.reportHandledMessage.mockReset();
  });

  it('reports the host and source, and nothing else, once per host', () => {
    reportUnrecognisedArtifactDomains(['https://www.example.org/a?x=1', 'https://example.org/b', 'https://example.net/c'], 'agent');
    expect(mocks.reportHandledMessage).toHaveBeenCalledTimes(2);
    expect(mocks.reportHandledMessage).toHaveBeenNthCalledWith(
      1,
      'Unrecognised artifact domain',
      { artifact_domain: 'example.org', artifact_source: 'agent' },
      ['unrecognised-artifact-domain', 'example.org'],
    );
    expect(mocks.reportHandledMessage.mock.calls[1][1]).toEqual({ artifact_domain: 'example.net', artifact_source: 'agent' });
  });

  it('reports nothing for a recognised or private host', () => {
    reportUnrecognisedArtifactDomains([FIGMA, 'http://localhost:3000/x', 'https://wiki.internal/y'], 'user');
    expect(mocks.reportHandledMessage).not.toHaveBeenCalled();
  });

  it('reports nothing, and spends no claim, with error reporting off', () => {
    mocks.active = false;
    reportUnrecognisedArtifactDomains(['https://example.org/a'], 'user');
    expect(mocks.reportHandledMessage).not.toHaveBeenCalled();
    expect(mocks.claimed.size).toBe(0);
  });

  it('never throws into the write it follows', () => {
    mocks.reportHandledMessage.mockImplementation(() => { throw new Error('sentry down'); });
    expect(() => reportUnrecognisedArtifactDomains(['https://example.org/a'], 'user')).not.toThrow();
  });

  it('reportAddedArtifactDomains reports only the rows a write added', () => {
    const row = (url: string): TaskArtifact => ({ url, name: null, source: 'user', added_at: '2026-01-01T00:00:00.000Z' });
    reportAddedArtifactDomains(
      [row('https://example.org/old')],
      [row('https://example.org/old'), row('https://example.net/new')],
      'user',
    );
    expect(mocks.reportHandledMessage).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledMessage.mock.calls[0][1]).toEqual({ artifact_domain: 'example.net', artifact_source: 'user' });
  });

  it('reportAddedArtifactDomains does nothing for an empty result or with reporting off', () => {
    reportAddedArtifactDomains([], [], 'user');
    mocks.active = false;
    reportAddedArtifactDomains([], [{ url: 'https://example.org/x', name: null, source: 'user', added_at: '' }], 'user');
    expect(mocks.reportHandledMessage).not.toHaveBeenCalled();
  });
});
