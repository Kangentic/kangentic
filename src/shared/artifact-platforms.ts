/**
 * The platforms Kangentic recognises as a task artifact (#1056): a design, a
 * diagram, a requirements document, a prototype. THE one place to look for
 * which links are supported and how each is matched. A link to any other site
 * can still be added by hand or by an agent over MCP; it shows a generic link
 * icon and its host.
 *
 * Read by main (detection), the retrieval worker (links in agent messages) and
 * the renderer (the logo and name), so it is pure: no imports, no I/O.
 *
 * To add a platform, add one entry here, a logo keyed by its `id` in
 * `src/renderer/components/artifact-platform-marks.ts`, and its row in
 * `docs/integrations/artifacts.md` (`tests/unit/artifact-platforms.test.ts`
 * fails when the doc and this table disagree).
 *
 * Each pattern was checked against the vendor's own share links. A platform
 * whose link shape no source confirms is left out rather than guessed: a wrong
 * pattern either misses every link or claims another site's.
 */

/** What kind of thing a platform holds. Groups the docs table. */
export type ArtifactPlatformKind = 'design' | 'ai' | 'whiteboard' | 'document' | 'design-system' | 'tracker';

/**
 * Where a platform's links are picked up without anyone asking:
 * - `messages`: wherever a link appears, an agent's messages and terminal
 *   output included. Designs, diagrams and generated apps: a link to one is
 *   almost always about the task.
 * - `description`: only from the task description (and an agent's own publish).
 *   Documents: agents cite docs all the time, so a doc link in passing would
 *   flood the list.
 * - `manual`: never. Trackers and boards: agents name issues constantly, and
 *   the task's own PR and source issue have their own places.
 */
export type ArtifactDetection = 'messages' | 'description' | 'manual';

export interface ArtifactLinkPattern {
  /** The host, without `www.`. A leading `*.` matches any subdomain (and not the bare domain). */
  host: string;
  /** Tested against the URL's path. Absent: any path. */
  path?: RegExp;
  /** Tested against the URL's fragment, `#` included. Absent: any fragment. */
  hash?: RegExp;
}

export interface ArtifactPlatform {
  /** Stable id. Also the key of the platform's logo. */
  id: string;
  /** The product's name, as its maker writes it. Never translated. */
  name: string;
  kind: ArtifactPlatformKind;
  detection: ArtifactDetection;
  patterns: readonly ArtifactLinkPattern[];
  /** A readable name read out of the link itself, when the link carries one. */
  nameFromUrl?: (url: URL) => string | null;
}

function words(slug: string): string | null {
  let text: string;
  try {
    text = decodeURIComponent(slug);
  } catch {
    text = slug;
  }
  const cleaned = text.replace(/[-_]+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

function segment(url: URL, index: number): string | null {
  return url.pathname.split('/').filter((part) => part !== '')[index] ?? null;
}

/** Figma: `/design/<key>/<File-name>`. */
function figmaName(url: URL): string | null {
  const name = segment(url, 2);
  return name ? words(name) : null;
}

/** Notion and Whimsical end a readable slug with an id: `Launch-plan-1a2b3c...`. */
function slugBeforeId(url: URL): string | null {
  const last = url.pathname.split('/').filter((part) => part !== '').pop();
  if (!last) return null;
  const withoutId = last.replace(/-[A-Za-z0-9]{20,}$/, '');
  return withoutId === last || withoutId === '' ? null : words(withoutId);
}

/** GitHub: `owner/repo #12`, or the project's owner. */
function githubName(url: URL): string | null {
  const [owner, repository, kind, number] = url.pathname.split('/').filter((part) => part !== '');
  if (kind === 'issues' && number) return `${owner}/${repository} #${number}`;
  return null;
}

/** Jira: the issue key, `KEY-12`. */
function jiraName(url: URL): string | null {
  return /^\/browse\/([A-Z][A-Z0-9]*-\d+)/.exec(url.pathname)?.[1] ?? null;
}

export const ARTIFACT_PLATFORMS: readonly ArtifactPlatform[] = [
  // ── Design and prototyping ──
  {
    id: 'figma', name: 'Figma', kind: 'design', detection: 'messages', nameFromUrl: figmaName,
    // Figma keeps adding path words (design, file, proto, board, slides, deck,
    // buzz, site, make), so any word followed by a file key matches. A key
    // holds a capital or a digit; a second word of plain lowercase letters is
    // one of Figma's own pages (`/pricing/enterprise`, `/community/plugin`).
    patterns: [{ host: 'figma.com', path: /^\/[a-z]+\/(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{6,}/ }, { host: '*.figma.site' }],
  },
  { id: 'penpot', name: 'Penpot', kind: 'design', detection: 'messages', patterns: [{ host: 'design.penpot.app', hash: /^#\/(view|workspace)/ }] },
  { id: 'sketch', name: 'Sketch', kind: 'design', detection: 'messages', patterns: [{ host: 'sketch.com', path: /^\/(s|preview)\// }] },
  {
    id: 'framer', name: 'Framer', kind: 'design', detection: 'messages',
    patterns: [{ host: 'framer.com', path: /^\/(projects|share)\// }, { host: '*.framer.app' }, { host: '*.framer.website' }],
  },
  {
    id: 'zeplin', name: 'Zeplin', kind: 'design', detection: 'messages',
    patterns: [{ host: 'app.zeplin.io', path: /^\/(project|styleguide)\// }, { host: 'zpl.io', path: /^\/\w+/ }],
  },
  {
    id: 'canva', name: 'Canva', kind: 'design', detection: 'messages',
    patterns: [{ host: 'canva.com', path: /^\/design\/[^/]+/ }, { host: 'canva.link', path: /^\/\w+/ }],
  },
  { id: 'uxpin', name: 'UXPin', kind: 'design', detection: 'messages', patterns: [{ host: 'preview.uxpin.com', path: /^\/\w+/ }] },
  { id: 'axure', name: 'Axure', kind: 'design', detection: 'messages', patterns: [{ host: '*.axshare.com' }, { host: 'app.axure.cloud', path: /^\/\w+/ }] },
  { id: 'protopie', name: 'ProtoPie', kind: 'design', detection: 'messages', patterns: [{ host: 'cloud.protopie.io', path: /^\/p\// }] },
  { id: 'balsamiq', name: 'Balsamiq', kind: 'design', detection: 'messages', patterns: [{ host: 'balsamiq.cloud', path: /^\/\w+/ }] },
  { id: 'uizard', name: 'Uizard', kind: 'design', detection: 'messages', patterns: [{ host: 'app.uizard.io', path: /^\/p\// }] },
  { id: 'stitch', name: 'Stitch', kind: 'design', detection: 'messages', patterns: [{ host: 'stitch.withgoogle.com', path: /^\/(projects|preview)\// }] },
  // In maintenance mode; links to old prototypes still open.
  { id: 'adobexd', name: 'Adobe XD', kind: 'design', detection: 'messages', patterns: [{ host: 'xd.adobe.com', path: /^\/view\// }] },

  // ── Made by an AI tool ──
  {
    id: 'claude', name: 'Claude', kind: 'ai', detection: 'messages',
    patterns: [
      { host: 'claude.ai', path: /^\/(artifact|public\/artifacts|code\/artifact)\// },
      // The old artifact host. It redirects, and links to it are still around.
      { host: 'claude.site', path: /^\/artifacts\// },
    ],
  },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'ai', detection: 'messages', patterns: [{ host: 'chatgpt.com', path: /^\/canvas\/shared\// }] },
  {
    id: 'gemini', name: 'Gemini', kind: 'ai', detection: 'messages',
    patterns: [{ host: 'g.co', path: /^\/gemini\/share\// }, { host: 'gemini.google.com', path: /^\/share\// }],
  },
  { id: 'v0', name: 'v0', kind: 'ai', detection: 'messages', patterns: [{ host: 'v0.app', path: /^\/chat\// }, { host: 'v0.dev', path: /^\/(chat|t)\// }] },
  { id: 'lovable', name: 'Lovable', kind: 'ai', detection: 'messages', patterns: [{ host: 'lovable.dev', path: /^\/projects\// }, { host: '*.lovable.app' }] },
  { id: 'bolt', name: 'Bolt', kind: 'ai', detection: 'messages', patterns: [{ host: 'bolt.new', path: /^\/~\// }, { host: '*.bolt.host' }] },

  // ── Whiteboards and diagrams ──
  { id: 'miro', name: 'Miro', kind: 'whiteboard', detection: 'messages', patterns: [{ host: 'miro.com', path: /^\/app\/(board|live-embed)\// }] },
  {
    id: 'excalidraw', name: 'Excalidraw', kind: 'whiteboard', detection: 'messages',
    // The drawing, or its key, is in the fragment.
    patterns: [{ host: 'excalidraw.com', hash: /^#(json|room)=/ }, { host: 'link.excalidraw.com', path: /^\/p\/readonly\// }],
  },
  { id: 'tldraw', name: 'tldraw', kind: 'whiteboard', detection: 'messages', patterns: [{ host: 'tldraw.com', path: /^\/(f|p|r|ro|v|s)\// }] },
  { id: 'whimsical', name: 'Whimsical', kind: 'whiteboard', detection: 'messages', nameFromUrl: slugBeforeId, patterns: [{ host: 'whimsical.com', path: /-[A-Za-z0-9]{22}$/ }] },
  {
    id: 'lucid', name: 'Lucid', kind: 'whiteboard', detection: 'messages',
    patterns: [
      { host: 'lucid.app', path: /^\/(lucidchart|publicSegments)\// },
      { host: 'lucidchart.com', path: /^\/(documents|lucidchart|publicSegments)\// },
    ],
  },
  {
    id: 'drawio', name: 'draw.io', kind: 'whiteboard', detection: 'messages',
    // The fragment names where the diagram lives (Google Drive, OneDrive, GitHub, a URL, ...).
    patterns: [{ host: 'app.diagrams.net', hash: /^#[GWHAUR]/ }, { host: 'app.draw.io', hash: /^#[GWHAUR]/ }, { host: 'viewer.diagrams.net' }],
  },
  { id: 'mermaid', name: 'Mermaid', kind: 'whiteboard', detection: 'messages', patterns: [{ host: 'mermaid.live', path: /^\/(edit|view)/, hash: /^#(pako|base64):/ }] },

  // ── Documents and wikis ──
  { id: 'googledocs', name: 'Google Docs', kind: 'document', detection: 'description', patterns: [{ host: 'docs.google.com', path: /^\/document\/d\// }] },
  { id: 'googleslides', name: 'Google Slides', kind: 'document', detection: 'description', patterns: [{ host: 'docs.google.com', path: /^\/presentation\/d\// }] },
  { id: 'googlesheets', name: 'Google Sheets', kind: 'document', detection: 'description', patterns: [{ host: 'docs.google.com', path: /^\/spreadsheets\/d\// }] },
  { id: 'googleforms', name: 'Google Forms', kind: 'document', detection: 'description', patterns: [{ host: 'docs.google.com', path: /^\/forms\/d\// }] },
  { id: 'googledrive', name: 'Google Drive', kind: 'document', detection: 'description', patterns: [{ host: 'drive.google.com', path: /^\/file\/d\// }] },
  {
    id: 'notion', name: 'Notion', kind: 'document', detection: 'description', nameFromUrl: slugBeforeId,
    patterns: [{ host: 'app.notion.com', path: /^\/p\// }, { host: 'notion.so', path: /^\/.+/ }, { host: '*.notion.site', path: /^\/.+/ }],
  },
  { id: 'confluence', name: 'Confluence', kind: 'document', detection: 'description', patterns: [{ host: '*.atlassian.net', path: /^\/wiki\// }] },
  {
    id: 'microsoft365', name: 'Microsoft 365', kind: 'document', detection: 'description',
    // Word, Excel, PowerPoint, PDF and folder share links. Whiteboard and Loop files share this way too.
    patterns: [{ host: '*.sharepoint.com', path: /^\/:[wxpbf]:\// }, { host: '1drv.ms', path: /^\/\w/ }],
  },
  { id: 'loom', name: 'Loom', kind: 'document', detection: 'description', patterns: [{ host: 'loom.com', path: /^\/(share|embed)\// }] },
  { id: 'coda', name: 'Coda', kind: 'document', detection: 'description', patterns: [{ host: 'coda.io', path: /^\/d\// }, { host: 'docs.superhuman.com', path: /^\/d\// }] },

  // ── Design systems ──
  { id: 'storybook', name: 'Storybook', kind: 'design-system', detection: 'messages', patterns: [{ host: '*.chromatic.com' }] },
  { id: 'zeroheight', name: 'zeroheight', kind: 'design-system', detection: 'messages', patterns: [{ host: 'zeroheight.com', path: /^\/\w+\/(v|p)\// }, { host: '*.zeroheight.com', path: /^\/\w+\/(v|p)\// }] },

  // ── Trackers and boards: recognised, never detected ──
  {
    id: 'github', name: 'GitHub', kind: 'tracker', detection: 'manual', nameFromUrl: githubName,
    patterns: [{ host: 'github.com', path: /^\/[^/]+\/[^/]+\/issues\/\d+/ }, { host: 'github.com', path: /^\/(orgs|users)\/[^/]+\/projects\/\d+/ }],
  },
  { id: 'azuredevops', name: 'Azure DevOps', kind: 'tracker', detection: 'manual', patterns: [{ host: 'dev.azure.com', path: /\/_(workitems|boards|wiki)\// }] },
  { id: 'jira', name: 'Jira', kind: 'tracker', detection: 'manual', nameFromUrl: jiraName, patterns: [{ host: '*.atlassian.net', path: /^\/browse\/[A-Z][A-Z0-9]*-\d+/ }] },
  { id: 'linear', name: 'Linear', kind: 'tracker', detection: 'manual', patterns: [{ host: 'linear.app', path: /^\/[^/]+\/(issue|project)\// }] },
];

/**
 * Whitespace or a control character inside a link. The URL parser drops a tab
 * or a newline and parses what is left, but the link is stored as written, and
 * a newline in it would start a line of its own in an agent's prompt
 * (`{{artifacts}}`) and in a tool result.
 */
const UNSAFE_LINK_CHARACTER = /[\s\p{Cc}]/u;

/** A link parsed as an http(s) URL, or null for anything else. */
export function parseArtifactUrl(text: string): URL | null {
  const link = text.trim();
  if (UNSAFE_LINK_CHARACTER.test(link)) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** `host` is already lowercase with no leading `www.`. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

/** The platform a link belongs to, or null for a link to anywhere else. */
export function artifactPlatformOf(link: string | URL): ArtifactPlatform | null {
  const url = typeof link === 'string' ? parseArtifactUrl(link) : link;
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const platform of ARTIFACT_PLATFORMS) {
    for (const pattern of platform.patterns) {
      if (!hostMatches(pattern.host, host)) continue;
      if (pattern.path && !pattern.path.test(url.pathname)) continue;
      if (pattern.hash && !pattern.hash.test(url.hash)) continue;
      return platform;
    }
  }
  return null;
}

/**
 * One key per artifact, so the same link added twice is one row. The scheme and
 * host are lowercased and a trailing slash dropped. The query and the fragment
 * stay: for Figma they name the frame, and for Excalidraw, draw.io and Mermaid
 * the fragment IS the document.
 */
export function artifactKey(link: string): string {
  const url = parseArtifactUrl(link);
  if (!url) return link.trim();
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '';
  return `https://${host}${url.port ? `:${url.port}` : ''}${path}${url.search}${url.hash}`;
}

/** The name a link carries for itself, when its platform knows how to read one. */
export function artifactNameFromUrl(link: string): string | null {
  const url = parseArtifactUrl(link);
  if (!url) return null;
  return artifactPlatformOf(url)?.nameFromUrl?.(url) ?? null;
}

/** The link cut down to host and path, for a row with no name: `docs.google.com/document/d/1xR4`. */
export function artifactShortLink(link: string): string {
  const url = parseArtifactUrl(link);
  if (!url) return link;
  return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
}

// A control character ends a link: terminal output wraps a coloured or
// underlined link in escape sequences (`\x1b[4mhttps://...\x1b[0m`), and the
// closing one would otherwise be read as the link's last characters.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`\p{Cc}]+/gu;

const CLOSING_BRACKET_OPENERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Punctuation that ends a sentence or wraps a link, not the link itself.
 *
 * One pass to count the brackets, one backward pass to trim, and one slice:
 * agent output can hold a link-shaped run hundreds of kilobytes long, and a
 * trim that rescans the candidate for every character it drops is quadratic.
 */
function trimLinkTail(candidate: string): string {
  const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  for (const character of candidate) {
    if (character in counts) counts[character] += 1;
  }
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    if ('.,;:!?*_~'.includes(last)) {
      end -= 1;
      continue;
    }
    // A closing bracket belongs to the link only when the link opened it:
    // `File_(v2)` keeps its bracket, `(see https://x/y)` loses the stray one.
    const opener = CLOSING_BRACKET_OPENERS[last];
    if (opener !== undefined && counts[last] > counts[opener]) {
      counts[last] -= 1;
      end -= 1;
      continue;
    }
    break;
  }
  return candidate.slice(0, end);
}

/** Every link-shaped run in a piece of text, in the order written, with its trailing punctuation off. */
function* linkCandidates(text: string): Generator<string> {
  for (const match of text.matchAll(URL_IN_TEXT)) yield trimLinkTail(match[0]);
}

/**
 * The artifact links in a piece of text, in the order written, each once.
 * `documents: false` leaves out document platforms (an agent's messages);
 * `true` keeps them (a task description). Tracker links are never returned:
 * they are added only by a person or an agent.
 */
export function findArtifactLinks(text: string, options: { documents: boolean }): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const link of linkCandidates(text)) {
    const platform = artifactPlatformOf(link);
    if (!platform || platform.detection === 'manual') continue;
    if (platform.detection === 'description' && !options.documents) continue;
    const key = artifactKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(link);
  }
  return found;
}

/** Every http(s) link in a piece of text, recognised or not, for a source that adds any link (an agent's own publish). */
export function findLinks(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const link of linkCandidates(text)) {
    if (!parseArtifactUrl(link) || seen.has(link)) continue;
    seen.add(link);
    found.push(link);
  }
  return found;
}

const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.test', '.example', '.invalid'];

/**
 * Whether a host is one that only means something inside a private network: a
 * bare name, an IP address, or a reserved suffix. Such a host is never
 * reported anywhere. A fully qualified name's trailing dot (`nas.local.`) is
 * not part of the name.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || !host.includes('.')) return true;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
