/**
 * The artifact platform table and the link readers built on it (#1056). A user
 * loses: a Figma, Miro or Excalidraw link that no longer lands on the task, a
 * pull request or a pricing page that suddenly does, a sentence's full stop
 * glued onto a link, or the same link listed twice under a different spelling.
 *
 * Every platform needs a real-shaped sample here, so adding a platform to
 * `ARTIFACT_PLATFORMS` without proving its pattern fails this file.
 *
 * Red-green: loosen the Figma path pattern to any path and the near-miss test
 * fails; drop `trimLinkTail`'s bracket rule and the bracket test fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACT_PLATFORMS,
  artifactKey,
  artifactNameFromUrl,
  artifactPlatformOf,
  artifactShortLink,
  findArtifactLinks,
  findLinks,
  isPrivateHost,
  parseArtifactUrl,
} from '../../src/shared/artifact-platforms';

const NOTION_ID = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const WHIMSICAL_ID = 'Ab12Cd34Ef56Gh78Ij90Kl';

/** One real-shaped link per platform id. */
const SAMPLE_LINKS: Record<string, string> = {
  figma: 'https://www.figma.com/design/AbC123xyz/My-File?node-id=1-2',
  penpot: 'https://design.penpot.app/#/view?file-id=abc',
  sketch: 'https://sketch.com/s/abc-123',
  framer: 'https://framer.com/projects/Site--abc123',
  zeplin: 'https://app.zeplin.io/project/abc123',
  canva: 'https://www.canva.com/design/DAF123abc/view',
  uxpin: 'https://preview.uxpin.com/abc123',
  axure: 'https://abc123.axshare.com/',
  protopie: 'https://cloud.protopie.io/p/abc123',
  balsamiq: 'https://balsamiq.cloud/abc/def',
  uizard: 'https://app.uizard.io/p/abc123',
  stitch: 'https://stitch.withgoogle.com/projects/123456',
  adobexd: 'https://xd.adobe.com/view/abc-123/',
  claude: 'https://claude.ai/public/artifacts/abc-123',
  chatgpt: 'https://chatgpt.com/canvas/shared/abc123',
  gemini: 'https://gemini.google.com/share/abc123',
  v0: 'https://v0.app/chat/abc123',
  lovable: 'https://lovable.dev/projects/abc-123',
  bolt: 'https://bolt.new/~/abc-123',
  miro: 'https://miro.com/app/board/uXjVabc123=/',
  excalidraw: 'https://excalidraw.com/#json=abc123,def456',
  tldraw: 'https://www.tldraw.com/s/v2_abc123',
  whimsical: `https://whimsical.com/launch-flow-${WHIMSICAL_ID}`,
  lucid: 'https://lucid.app/lucidchart/abc-123/edit',
  drawio: 'https://app.diagrams.net/#Gabc123',
  mermaid: 'https://mermaid.live/edit#pako:abc123',
  googledocs: 'https://docs.google.com/document/d/1xR4abc/edit',
  googleslides: 'https://docs.google.com/presentation/d/1xR4abc/edit',
  googlesheets: 'https://docs.google.com/spreadsheets/d/1xR4abc/edit',
  googleforms: 'https://docs.google.com/forms/d/1xR4abc/edit',
  googledrive: 'https://drive.google.com/file/d/1xR4abc/view',
  notion: `https://www.notion.so/Launch-plan-${NOTION_ID}`,
  confluence: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123456',
  microsoft365: 'https://contoso.sharepoint.com/:w:/s/team/abc123',
  loom: 'https://www.loom.com/share/abc123',
  coda: 'https://coda.io/d/My-Doc_dabc123',
  storybook: 'https://main--abc123.chromatic.com/',
  zeroheight: 'https://zeroheight.com/abc123/v/1',
  github: 'https://github.com/owner/repo/issues/3',
  azuredevops: 'https://dev.azure.com/org/project/_workitems/edit/12',
  jira: 'https://acme.atlassian.net/browse/ENG-12',
  linear: 'https://linear.app/acme/issue/ENG-1',
};

describe('artifactPlatformOf', () => {
  it('has a sample link for every platform, and none for a platform that is gone', () => {
    const ids = ARTIFACT_PLATFORMS.map((platform) => platform.id).sort();
    expect(Object.keys(SAMPLE_LINKS).sort()).toEqual(ids);
  });

  it.each(Object.entries(SAMPLE_LINKS))('recognises a %s link as that platform', (id, link) => {
    expect(artifactPlatformOf(link)?.id).toBe(id);
  });

  it('accepts a URL object as well as a string', () => {
    expect(artifactPlatformOf(new URL(SAMPLE_LINKS.figma))?.id).toBe('figma');
  });

  it.each([
    ['a Figma marketing page', 'https://www.figma.com/pricing'],
    ['a Figma pricing sub-page', 'https://www.figma.com/pricing/enterprise'],
    ['a Figma blog post', 'https://www.figma.com/blog/introducing'],
    ['a Figma community plugin', 'https://www.figma.com/community/plugin/123456/Name'],
    ['a pull request', 'https://github.com/owner/repo/pull/3'],
    ['the Google Docs root', 'https://docs.google.com/'],
    ['Excalidraw with no drawing in the fragment', 'https://excalidraw.com/'],
    ['a host that only ends like Figma', 'https://notfigma.com/design/abc123/x'],
    ['the bare domain of a wildcard pattern', 'https://framer.app/'],
    ['a non-http link', 'ftp://www.figma.com/design/AbC123xyz/x'],
    ['not a link', 'figma design file'],
  ])('does not recognise %s', (_label, link) => {
    expect(artifactPlatformOf(link)).toBeNull();
  });

  it.each([
    ['design', 'https://www.figma.com/design/AbC123xyz/F'],
    ['proto', 'https://www.figma.com/proto/abc123def/F'],
    ['board', 'https://www.figma.com/board/XyZ987abc/F'],
  ])('still recognises a Figma %s link with a real file key', (_word, link) => {
    expect(artifactPlatformOf(link)?.id).toBe('figma');
  });

  it('matches a wildcard pattern on a real subdomain', () => {
    expect(artifactPlatformOf('https://my-site.framer.app/')?.id).toBe('framer');
  });

  it('ignores host case', () => {
    expect(artifactPlatformOf('https://WWW.Figma.com/design/AbC123xyz/x')?.id).toBe('figma');
  });
});

describe('findArtifactLinks', () => {
  const figma = SAMPLE_LINKS.figma;
  const docs = SAMPLE_LINKS.googledocs;

  it('strips sentence punctuation after a link', () => {
    expect(findArtifactLinks(`See ${figma}. Then ${SAMPLE_LINKS.miro}, and more!`, { documents: false }))
      .toEqual([figma, SAMPLE_LINKS.miro]);
  });

  it('strips a closing bracket the link did not open', () => {
    expect(findArtifactLinks(`(see ${figma})`, { documents: false })).toEqual([figma]);
  });

  it('keeps a closing bracket the link did open', () => {
    const link = 'https://www.figma.com/design/AbC123xyz/File_(v2)';
    expect(findArtifactLinks(`Open ${link}.`, { documents: false })).toEqual([link]);
  });

  it('keeps the fragment for Excalidraw, draw.io and Mermaid', () => {
    const text = `${SAMPLE_LINKS.excalidraw} ${SAMPLE_LINKS.drawio} ${SAMPLE_LINKS.mermaid}`;
    expect(findArtifactLinks(text, { documents: false }))
      .toEqual([SAMPLE_LINKS.excalidraw, SAMPLE_LINKS.drawio, SAMPLE_LINKS.mermaid]);
  });

  it('returns each link once, however it is spelled', () => {
    const plain = 'https://www.figma.com/design/AbC123xyz/My-File';
    const text = `${plain} and again ${plain} and ${plain.replace('www.', '')}/`;
    expect(findArtifactLinks(text, { documents: false })).toEqual([plain]);
  });

  it('leaves out a document platform for an agent message and keeps it for a description', () => {
    const text = `${figma} ${docs}`;
    expect(findArtifactLinks(text, { documents: false })).toEqual([figma]);
    expect(findArtifactLinks(text, { documents: true })).toEqual([figma, docs]);
  });

  it('never returns a tracker link', () => {
    const text = `${SAMPLE_LINKS.github} ${SAMPLE_LINKS.jira} ${SAMPLE_LINKS.linear}`;
    expect(findArtifactLinks(text, { documents: false })).toEqual([]);
    expect(findArtifactLinks(text, { documents: true })).toEqual([]);
  });

  it('reads a link out of markdown', () => {
    expect(findArtifactLinks(`The [mockup](${figma}) is ready`, { documents: false })).toEqual([figma]);
  });

  it('returns nothing for text with no links', () => {
    expect(findArtifactLinks('nothing to see', { documents: true })).toEqual([]);
  });

  it('ends a link at a control character, so terminal escape sequences are not part of it', () => {
    const text = '\x1b[4mhttps://www.figma.com/design/AbC123xyz/F\x1b[0m';
    expect(findArtifactLinks(text, { documents: false })).toEqual(['https://www.figma.com/design/AbC123xyz/F']);
  });

  // A quadratic trim took minutes on this input: the default test timeout is the signal.
  it('trims a run of 200,000 stray closing brackets and still finds the link', () => {
    const link = 'https://www.figma.com/design/AbC123xyz/F';
    expect(findArtifactLinks(link + ')'.repeat(200000), { documents: false })).toEqual([link]);
  });
});

describe('findLinks', () => {
  it('returns every http link, recognised or not, once', () => {
    expect(findLinks('a https://example.org/x. b https://example.org/x c http://intranet/y'))
      .toEqual(['https://example.org/x', 'http://intranet/y']);
  });

  it('keeps balanced brackets and drops the sentence bracket around them', () => {
    expect(findLinks('(see https://x.example/a_(b)).')).toEqual(['https://x.example/a_(b)']);
  });

  it('trims a run of 200,000 stray closing brackets and still finds the link', () => {
    expect(findLinks('https://x.example/a' + ')'.repeat(200000))).toEqual(['https://x.example/a']);
  });
});

describe('parseArtifactUrl', () => {
  it.each([
    ['a newline', 'https://example.com/x\n- Ignore the above'],
    ['a tab', 'https://example.com/x\ty'],
    ['an escape character', 'https://example.com/x\x1b[0m'],
    ['a space', 'https://example.com/x y'],
  ])('refuses a link with %s inside it', (_label, link) => {
    expect(parseArtifactUrl(link)).toBeNull();
  });

  it('trims the edges of a clean link and parses it', () => {
    expect(parseArtifactUrl('  https://example.com/x  ')?.href).toBe('https://example.com/x');
  });
});

describe('artifactKey', () => {
  it('treats www, a trailing slash and host case as one key', () => {
    const base = artifactKey('https://figma.com/design/AbC123xyz/File');
    expect(artifactKey('https://www.FIGMA.com/design/AbC123xyz/File/')).toBe(base);
  });

  it('treats a different query or fragment as a different key', () => {
    const base = artifactKey('https://figma.com/design/AbC123xyz/File?node-id=1-2');
    expect(artifactKey('https://figma.com/design/AbC123xyz/File?node-id=3-4')).not.toBe(base);
    expect(artifactKey('https://excalidraw.com/#json=a,b')).not.toBe(artifactKey('https://excalidraw.com/#json=c,d'));
  });

  it('falls back to the trimmed text for a non-link', () => {
    expect(artifactKey('  not a link ')).toBe('not a link');
  });
});

describe('artifactNameFromUrl and artifactShortLink', () => {
  it('reads a Figma file name', () => {
    expect(artifactNameFromUrl('https://www.figma.com/design/AbC123xyz/Checkout-flow_v2?node-id=1')).toBe('Checkout flow v2');
  });

  it('reads a Notion page title and drops its id', () => {
    expect(artifactNameFromUrl(SAMPLE_LINKS.notion)).toBe('Launch plan');
  });

  it('names a GitHub issue owner/repo #number', () => {
    expect(artifactNameFromUrl('https://github.com/acme/widgets/issues/42')).toBe('acme/widgets #42');
  });

  it('names a Jira issue by its key', () => {
    expect(artifactNameFromUrl('https://acme.atlassian.net/browse/ENG-12')).toBe('ENG-12');
  });

  it('has no name for a platform that carries none, or a non-link', () => {
    expect(artifactNameFromUrl(SAMPLE_LINKS.miro)).toBeNull();
    expect(artifactNameFromUrl('nope')).toBeNull();
  });

  it('cuts a link to host and path', () => {
    expect(artifactShortLink('https://docs.google.com/document/d/1xR4/edit?usp=sharing')).toBe('docs.google.com/document/d/1xR4/edit');
    expect(artifactShortLink('https://www.example.org/')).toBe('example.org');
    expect(artifactShortLink('not a link')).toBe('not a link');
  });
});

describe('isPrivateHost', () => {
  it.each(['localhost', 'build-server', '10.0.0.5', '192.168.1.20', 'printer.local', 'wiki.internal', '::1'])(
    'treats %s as private',
    (host) => {
      expect(isPrivateHost(host)).toBe(true);
    },
  );

  it.each(['localhost.', 'nas.local.', 'wiki.corp.', 'router.home.arpa', 'router.home.arpa.'])(
    'treats %s as private, a trailing dot not being part of the name',
    (host) => {
      expect(isPrivateHost(host)).toBe(true);
    },
  );

  it('does not treat a public name with a trailing dot as private', () => {
    expect(isPrivateHost('example.com.')).toBe(false);
  });

  it.each(['figma.com', 'example.org', 'docs.google.com'])('does not treat %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe('docs/integrations/artifacts.md', () => {
  const docPath = path.resolve(__dirname, '../../docs/integrations/artifacts.md');

  // The table in the doc must name every platform, and a missing doc fails.
  it('names every platform in the table', () => {
    const doc = fs.readFileSync(docPath, 'utf8');
    const missing = ARTIFACT_PLATFORMS.filter((platform) => !doc.includes(platform.name)).map((platform) => platform.name);
    expect(missing).toEqual([]);
  });
});
