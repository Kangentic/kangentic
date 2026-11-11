/**
 * Reads the artifact parameters of the task tools (#1056) and prints a task's
 * artifacts back. Parsed here and not only in the zod schema: the mobile
 * bridge and the devtools commands call the handlers directly.
 *
 * Every refusal says what to send instead, so an agent can correct its call
 * without a second look at the schema.
 */

import { artifactKey, artifactPlatformOf, parseArtifactUrl } from '../../../shared/artifact-platforms';
import { artifactDisplayName, MAX_ARTIFACT_URL_LENGTH, MAX_TASK_ARTIFACTS } from '../../../shared/task-artifacts';
import type { TaskArtifact, TaskArtifactInput } from '../../../shared/types';

const SHAPE_HINT = 'Send a list such as [{ "url": "https://www.figma.com/design/abc/Checkout", "name": "Checkout flow" }]; "name" is optional.';

function urlRefusal(parameter: string, value: string): string | null {
  if (value.length > MAX_ARTIFACT_URL_LENGTH) {
    return `${parameter}: a link is ${value.length} characters, over the ${MAX_ARTIFACT_URL_LENGTH} character limit.`;
  }
  if (!parseArtifactUrl(value)) {
    return `${parameter}: "${value.slice(0, 120)}" is not an http or https link. An artifact is a link to something online; attach a local file with "attachments" instead.`;
  }
  return null;
}

/** The artifacts to add, null when the parameter was not sent, or an error to return. */
export function parseArtifactInputs(value: unknown, parameter: string): TaskArtifactInput[] | { error: string } | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return { error: `${parameter} must be a list. ${SHAPE_HINT}` };
  if (value.length > MAX_TASK_ARTIFACTS) {
    return { error: `${parameter} holds ${value.length} links; a task keeps at most ${MAX_TASK_ARTIFACTS}.` };
  }
  const inputs: TaskArtifactInput[] = [];
  for (const entry of value) {
    // A bare link is accepted as an artifact with no name.
    const candidate: unknown = typeof entry === 'string' ? { url: entry } : entry;
    if (typeof candidate !== 'object' || candidate === null) return { error: `${parameter}: each entry needs a "url". ${SHAPE_HINT}` };
    const { url, name } = candidate as { url?: unknown; name?: unknown };
    if (typeof url !== 'string' || url.trim() === '') return { error: `${parameter}: each entry needs a "url". ${SHAPE_HINT}` };
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return { error: `${parameter}: "name" must be text. ${SHAPE_HINT}` };
    }
    const refusal = urlRefusal(parameter, url.trim());
    if (refusal) return { error: refusal };
    inputs.push({ url: url.trim(), name: typeof name === 'string' ? name : null });
  }
  return inputs;
}

/** The links to take off the task, null when the parameter was not sent, or an error to return. */
export function parseArtifactUrls(value: unknown, parameter: string): string[] | { error: string } | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { error: `${parameter} must be a list of links, each exactly as the task's Artifacts list shows it.` };
  }
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * The links in `urls` the task does not hold, so a removal that names nothing
 * is said and not silently ignored. Matched the way the repository matches
 * them (`artifactKey`), so `www.` or a trailing slash does not miss.
 */
export function unknownArtifactUrls(artifacts: readonly TaskArtifact[], urls: readonly string[]): string[] {
  const held = new Set(artifacts.map((artifact) => artifactKey(artifact.url)));
  return urls.filter((url) => !held.has(artifactKey(url)));
}

/**
 * The refusal for an update that would leave the task with more links than it
 * keeps, or null when they fit. The merge leaves a link past the limit off with
 * no word said, so an agent would report an artifact the task never got.
 * Counted the way the merge applies a change: removals first, then the adds
 * the task does not already hold.
 */
export function artifactRoomRefusal(
  artifacts: readonly TaskArtifact[],
  add: readonly TaskArtifactInput[],
  remove: readonly string[],
): string | null {
  const removedKeys = new Set(remove.map((url) => artifactKey(url)));
  const keptKeys = new Set(artifacts.map((artifact) => artifactKey(artifact.url)).filter((key) => !removedKeys.has(key)));
  const addedKeys = new Set(add.map((entry) => artifactKey(entry.url)).filter((key) => !keptKeys.has(key)));
  const total = keptKeys.size + addedKeys.size;
  if (total <= MAX_TASK_ARTIFACTS) return null;
  return `addArtifacts would leave the task with ${total} artifacts; a task keeps at most ${MAX_TASK_ARTIFACTS}. Take some off with removeArtifacts in the same call.`;
}

/** Who added an artifact, as a tool result says it. */
const SOURCE_TEXT: Record<TaskArtifact['source'], string> = {
  user: 'added by the user',
  agent: 'added by an agent',
  detected: 'detected',
};

/**
 * A task's artifacts as lines for a tool result: name, platform, link and who
 * added it. Empty when the task has none, so a caller prints no heading.
 */
export function formatArtifactLines(artifacts: readonly TaskArtifact[]): string[] {
  return artifacts.map((artifact) => {
    const platform = artifactPlatformOf(artifact.url)?.name;
    const name = artifactDisplayName(artifact);
    const label = platform ? `${name} (${platform})` : name;
    return `- ${label}: ${artifact.url} [${SOURCE_TEXT[artifact.source]}]`;
  });
}
