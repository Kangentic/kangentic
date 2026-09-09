/** Parse an Azure DevOps URL, returning the repository identifier with optional iteration path. */
export function parseAzureDevOpsUrl(url: string): { repository: string } {
  // Modern format: https://dev.azure.com/{org}/{project}[/any/sub/path...]
  const modernPattern = /https?:\/\/dev\.azure\.com\/([^/\s]+)\/([^/\s]+)(\/.*)?/;
  const modernMatch = modernPattern.exec(url);
  if (modernMatch) {
    const organization = decodeURIComponent(modernMatch[1]);
    const project = decodeURIComponent(modernMatch[2]);
    const subPath = modernMatch[3] ?? '';
    const iterationPath = extractIterationPath(subPath);
    return { repository: buildRepository(organization, project, iterationPath) };
  }

  // Legacy format: https://{org}.visualstudio.com/{project}[/any/sub/path...]
  const legacyPattern = /https?:\/\/([^.]+)\.visualstudio\.com\/([^/\s]+)(\/.*)?/;
  const legacyMatch = legacyPattern.exec(url);
  if (legacyMatch) {
    const organization = decodeURIComponent(legacyMatch[1]);
    const project = decodeURIComponent(legacyMatch[2]);
    const subPath = legacyMatch[3] ?? '';
    const iterationPath = extractIterationPath(subPath);
    return { repository: buildRepository(organization, project, iterationPath) };
  }

  throw new Error('Invalid Azure DevOps URL. Expected format: https://dev.azure.com/org/project');
}

const LEGACY_HOST_SUFFIX = '.visualstudio.com';

/**
 * Decide whether a download URL's host should receive our Azure DevOps bearer
 * token. Covers the modern `dev.azure.com` host and the legacy
 * `{org}.visualstudio.com` spelling this adapter still imports from.
 *
 * A substring test is not enough. Inline image URLs come out of user-authored
 * work item HTML, so `https://attacker.example/x.png?ref=dev.azure.com` and
 * `https://dev.azure.com.attacker.example/x.png` would both pass one and send
 * the token to a host the attacker controls. Never throws: a malformed or
 * relative URL is simply not authed.
 */
export function isAzureDevOpsAuthedDownloadUrl(url: string): boolean {
  let hostname: string;
  try {
    // hostname, not host: `host` carries the port, so a `dev.azure.com:443`
    // URL would fail the comparison and silently lose its token.
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  if (hostname === 'dev.azure.com') return true;
  // The leading dot rejects `evilvisualstudio.com`, the length check rejects a
  // bare `.visualstudio.com` with no org label.
  return hostname.endsWith(LEGACY_HOST_SUFFIX) && hostname.length > LEGACY_HOST_SUFFIX.length;
}

/** Build a human-readable label for an Azure DevOps source. */
export function buildAzureDevOpsLabel(repository: string): string {
  if (repository.includes('::')) {
    const [orgProject, iterationPath] = repository.split('::');
    const project = orgProject.split('/')[1] ?? orgProject;
    const readableIteration = iterationPath.replace(/\\/g, '/');
    // Strip the project prefix from the iteration if it starts with it
    const iterationDisplay = readableIteration.startsWith(project + '/')
      ? readableIteration.slice(project.length + 1)
      : readableIteration;
    return `${project} / ${iterationDisplay}`;
  }
  return repository;
}

/**
 * Extract iteration path from Azure DevOps sprint URLs.
 * Sprint URLs: /_sprints/taskboard/{team}/{project}/{iteration...}
 *          or: /_sprints/backlog/{team}/{project}/{iteration...}
 * Returns null if the URL is not a sprint URL or has no iteration segments.
 */
function extractIterationPath(subPath: string): string | null {
  const sprintPattern = /^\/_sprints\/(?:taskboard|backlog|capacity)\/([^/]+)\/(.+)/;
  const sprintMatch = sprintPattern.exec(subPath);
  if (!sprintMatch) return null;

  const rawIterationPath = sprintMatch[2];
  const segments = rawIterationPath.split('/').map((segment) => decodeURIComponent(segment)).filter(Boolean);

  if (segments.length === 0) return null;

  // Azure DevOps iteration paths use backslash separators in WIQL
  return segments.join('\\');
}

/**
 * Build the repository identifier for Azure DevOps.
 * Format: "org/project" or "org/project::iterationPath" when scoped to a sprint.
 */
function buildRepository(organization: string, project: string, iterationPath: string | null): string {
  if (iterationPath) {
    return `${organization}/${project}::${iterationPath}`;
  }
  return `${organization}/${project}`;
}
