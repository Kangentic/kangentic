// Pure helpers extracted from browser.ts so they can be unit-tested without
// importing Electron (ipcMain). Nothing here does I/O; the item check comes
// from the draft store's module, which only loads `node:fs`. The handler
// module re-exports nothing from here publicly - the functions are imported
// directly.

import type {
  BrowserAnnotationSendInput,
  BrowserAnnotationStroke,
  BrowserCaptureInput,
  BrowserPickedElement,
} from '../../../shared/types';
import { escapeXml } from '../../agent/shared';
import { isAnnotationCaptureId, isAnnotationItem } from '../../browser/annotation-drafts';

export const SELECTION_INLINE_LIMIT = 800;

// Browser-default values that add no signal for an LLM.
export const STYLE_DEFAULT_DROPS = new Set<string>([
  'normal', 'auto', 'none', '0px', '0', '1', 'static',
  'rgba(0, 0, 0, 0)', 'rgb(0, 0, 0, 0)', 'transparent',
]);

// width/height duplicate the `rect` line; display value tracks the tag's
// natural default for text-flow elements. Drop both so the styles block
// stays focused on what's actually styled.
export const STYLE_KEYS_TO_DROP = new Set<string>(['width', 'height', 'display']);

export function isMeaningfulStyle(key: string, value: string): boolean {
  if (!value) return false;
  if (STYLE_KEYS_TO_DROP.has(key)) return false;
  if (STYLE_DEFAULT_DROPS.has(value)) return false;
  // Common no-op patterns
  if (value === '0px 0px 0px 0px') return false;
  if (key === 'border' && /^0px/.test(value)) return false;
  if (key === 'opacity' && value === '1') return false;
  return true;
}

export function formatStyles(styles: Record<string, string>): string[] {
  const meaningful = Object.entries(styles).filter(([key, value]) => isMeaningfulStyle(key, value));
  if (meaningful.length === 0) return ['(defaults)'];
  return meaningful.map(([key, value]) => `${key}: ${value}`);
}

export function formatAncestors(ancestors: BrowserPickedElement['ancestors']): string {
  if (ancestors.length === 0) return '(none)';
  return ancestors
    .map((ancestor) => {
      const parts: string[] = [ancestor.tagName.toLowerCase()];
      if (ancestor.id) parts.push(`#${ancestor.id}`);
      if (ancestor.testId) parts.push(`[data-testid="${ancestor.testId}"]`);
      if (ancestor.classes.length > 0) parts.push(`.${ancestor.classes.slice(0, 3).join('.')}`);
      if (ancestor.role) parts.push(`[role="${ancestor.role}"]`);
      return parts.join('');
    })
    .join(' > ');
}

// True when outerHTML is just the open tag + plain text + close tag with no
// nested elements. In that case the structured fields (classes, text) already
// cover everything and re-printing the markup is just noise.
export function isTrivialWrapper(outerHTML: string): boolean {
  const inner = outerHTML.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>\s*$/, '');
  return !/<[a-zA-Z]/.test(inner);
}

// Validates a UUID v4-style session ID. Used to guard the filesystem path
// derived from sessionId in the handler against traversal attacks.
export function isValidSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Detects when path.relative returned an absolute Windows path because the
// source and target are on different drives, or on different network shares
// (a UNC path).
export function isCrossDrivePath(relativePath: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\)/.test(relativePath);
}

/** The most annotations one Send names, matching the pane's own cap with room to spare. */
const MAX_SENT_ANNOTATION_NUMBER = 100;

/**
 * The annotations of a Send payload that are well formed, from outside the
 * type system (the renderer's IPC). The number goes into a file name and the
 * prompt, so only a small positive integer is accepted.
 */
export function validAnnotationInputs(value: unknown): BrowserAnnotationSendInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is BrowserAnnotationSendInput => {
    if (!candidate || typeof candidate !== 'object') return false;
    const annotation = candidate as Record<string, unknown>;
    return Number.isSafeInteger(annotation.number)
      && (annotation.number as number) >= 1
      && (annotation.number as number) <= MAX_SENT_ANNOTATION_NUMBER
      && typeof annotation.note === 'string'
      && typeof annotation.url === 'string'
      && typeof annotation.onPage === 'boolean'
      && typeof annotation.inViewport === 'boolean'
      && Array.isArray(annotation.items)
      && annotation.items.every(isAnnotationItem)
      && (annotation.captureId === null || isAnnotationCaptureId(annotation.captureId));
  });
}

// Anthropic + OpenAI canonical guidance: wrap prompt input data in XML tags
// so the model sees a clear data/instruction boundary. Aider/Codex/etc treat
// the markup as harmless prose; the structured fields stay readable.

/**
 * Past this many characters, an annotation paste moves each element's styles,
 * ancestors and HTML to a file and keeps only what finds it in the code inline.
 * A long paste is slow to deliver into a TUI and crowds the agent's context
 * with detail that matters only for visual fixes.
 */
export const ANNOTATIONS_INLINE_LIMIT = 6000;

const ANNOTATIONS_PREAMBLE = [
  'The user annotated this page. Each numbered annotation is one change to make; its',
  'number matches the badges in the screenshot. Coordinates are CSS pixels of the whole page.',
];

export interface AnnotationsPayloadPaths {
  /** The screenshot Send took, relative to the agent's cwd. */
  screenshot: string;
  /** Capture id to the path of its copy for the agent, relative to the agent's cwd. */
  captures: ReadonlyMap<string, string>;
  /** Where the full element detail goes if the paste runs long, relative to the agent's cwd. */
  details: string;
}

export interface AnnotationsPayload {
  payload: string;
  /** The full detail file to write at `paths.details`, or null when everything fit inline. */
  detailsXml: string | null;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/** The stroke count, bounding box and first point of a drawing, as the agent reads it. */
export function describeDrawing(strokes: BrowserAnnotationStroke[]): { strokes: number; box: string; start: string } | null {
  const points = strokes.flat();
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const first = points[0];
  return {
    strokes: strokes.filter((stroke) => stroke.length > 0).length,
    box: `${Math.round(minX)},${Math.round(minY)},${Math.round(maxX - minX)},${Math.round(maxY - minY)}`,
    start: `${Math.round(first.x)},${Math.round(first.y)}`,
  };
}

function elementAttributes(element: BrowserPickedElement): string {
  const attributes: string[] = [];
  if (element.role) attributes.push(`role="${escapeXml(element.role)}"`);
  const name = (element.accessibleName || '').trim();
  if (name) attributes.push(`name="${escapeXml(name)}"`);
  attributes.push(`tag="${escapeXml(element.tagName.toLowerCase())}"`);
  if (element.testId) attributes.push(`testid="${escapeXml(element.testId)}"`);
  if (element.id) attributes.push(`id="${escapeXml(element.id)}"`);
  const rect = element.rect;
  attributes.push(`rect="${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}"`);
  return attributes.join(' ');
}

/** The detail an element carries past its identity: what moves to the file when the paste runs long. */
function elementDetailLines(element: BrowserPickedElement, indent: string): string[] {
  const lines: string[] = [];
  const styleLines = formatStyles(element.computedStyles);
  if (!(styleLines.length === 1 && styleLines[0] === '(defaults)')) {
    lines.push(`${indent}<styles>${escapeXml(styleLines.join('; '))}</styles>`);
  }
  if (element.ancestors.length > 0) {
    lines.push(`${indent}<ancestors>${escapeXml(formatAncestors(element.ancestors))}</ancestors>`);
  }
  if (element.outerHTML && !isTrivialWrapper(element.outerHTML)) {
    lines.push(`${indent}<outer_html>`);
    for (const part of element.outerHTML.split('\n')) {
      lines.push(`${indent}  ${escapeXml(part)}`);
    }
    lines.push(`${indent}</outer_html>`);
  }
  return lines;
}

function annotationLines(
  annotation: BrowserAnnotationSendInput,
  pageUrl: string,
  withDetail: boolean,
): string[] {
  const attributes = [`n="${annotation.number}"`];
  if (annotation.url && annotation.url !== pageUrl) attributes.push(`url="${escapeXml(annotation.url)}"`);
  if (!annotation.onPage) attributes.push('on_page="false"');
  const lines = [`  <annotation ${attributes.join(' ')}>`];
  const note = annotation.note.trim();
  lines.push(note ? `    <note>${escapeXml(note)}</note>` : '    <note />');
  for (const item of annotation.items) {
    if (item.kind === 'element') {
      const element = item.element;
      lines.push(`    <element ${elementAttributes(element)}>`);
      lines.push(`      <selector>${escapeXml(element.selector)}</selector>`);
      if (element.classes.length > 0) {
        lines.push(`      <classes>${escapeXml(element.classes.join(' '))}</classes>`);
      }
      const name = (element.accessibleName || '').trim();
      const text = (element.text || '').trim();
      if (text && text !== name) lines.push(`      <text>${escapeXml(text)}</text>`);
      if (withDetail) lines.push(...elementDetailLines(element, '      '));
      lines.push('    </element>');
    } else {
      const drawing = describeDrawing(item.strokes);
      if (drawing) {
        lines.push(`    <drawing strokes="${drawing.strokes}" box="${drawing.box}" start="${drawing.start}" />`);
      }
    }
  }
  lines.push('  </annotation>');
  return lines;
}

function annotationsRootTag(input: BrowserCaptureInput, imageWidth: number | null): string {
  const attributes = [`url="${escapeXml(input.url)}"`];
  const viewport = input.viewport;
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (viewport && finite(viewport.width) && finite(viewport.height) && viewport.width > 0 && viewport.height > 0) {
    attributes.push(`viewport="${Math.round(viewport.width)}x${Math.round(viewport.height)}"`);
    if (finite(viewport.scrollX) && finite(viewport.scrollY)) {
      attributes.push(`scroll="${Math.round(viewport.scrollX)},${Math.round(viewport.scrollY)}"`);
    }
    if (imageWidth && imageWidth > 0) {
      const scale = Math.round((imageWidth / viewport.width) * 100) / 100;
      if (scale > 0 && scale !== 1) attributes.push(`scale="${scale}"`);
    }
  }
  return `<annotations ${attributes.join(' ')}>`;
}

function selectedTextLine(input: BrowserCaptureInput): string | null {
  const selection = input.selectedText.trim();
  if (!selection) return null;
  if (selection.length <= SELECTION_INLINE_LIMIT) {
    return `  <selected_text>${escapeXml(selection)}</selected_text>`;
  }
  return `  <selected_text truncated="true">${escapeXml(selection.slice(0, SELECTION_INLINE_LIMIT))}...</selected_text>`;
}

/**
 * The capture lines for annotations the screenshot does not show: one line
 * per capture, so annotations that share one are named together.
 */
function captureLines(input: BrowserCaptureInput, captures: ReadonlyMap<string, string>): string[] {
  const groups = new Map<string, BrowserAnnotationSendInput[]>();
  for (const annotation of input.annotations) {
    if (annotation.inViewport || !annotation.captureId) continue;
    if (!captures.has(annotation.captureId)) continue;
    const group = groups.get(annotation.captureId) ?? [];
    group.push(annotation);
    groups.set(annotation.captureId, group);
  }
  const lines: string[] = [];
  for (const [captureId, annotations] of groups) {
    const numbers = annotations.map((annotation) => annotation.number).join(', ');
    const label = annotations.length === 1 ? `Annotation ${numbers}` : `Annotations ${numbers}`;
    const elsewhere = annotations.every((annotation) => annotation.url && annotation.url !== input.url);
    const where = elsewhere ? 'captured on another page' : 'captured before the page scrolled';
    lines.push(`${label}, ${where}: @${toPosix(captures.get(captureId) ?? '')}`);
  }
  return lines;
}

/** Reads a PNG's pixel width from its IHDR chunk, or null when the bytes are not a PNG. */
export function pngWidth(pngBase64: string): number | null {
  if (!pngBase64) return null;
  let header: Buffer;
  try {
    header = Buffer.from(pngBase64.slice(0, 44), 'base64');
  } catch {
    return null;
  }
  if (header.length < 24 || header.toString('ascii', 12, 16) !== 'IHDR') return null;
  return header.readUInt32BE(16);
}

/**
 * The prompt for a Send that carries annotations: two plain sentences, the
 * screenshot and any captures as @ paths (outside the XML, so the agent's @
 * parser attaches them), then one `<annotations>` block with each note before
 * the evidence it points at.
 */
export function buildAnnotationsPayload(input: BrowserCaptureInput, paths: AnnotationsPayloadPaths): AnnotationsPayload {
  const head: string[] = [];
  const note = input.note.trim();
  if (note) head.push(note, '');
  head.push(...ANNOTATIONS_PREAMBLE, '');
  head.push(`Screenshot: @${toPosix(paths.screenshot)}`);
  head.push(...captureLines(input, paths.captures));

  const root = annotationsRootTag(input, pngWidth(input.pngBase64));
  const selection = selectedTextLine(input);
  const block = (withDetail: boolean): string[] => [
    root,
    ...input.annotations.flatMap((annotation) => annotationLines(annotation, input.url, withDetail)),
    ...(selection ? [selection] : []),
    '</annotations>',
  ];

  const full = [...head, '', ...block(true)].join('\n');
  // Only element detail moves to the file: a paste long for its notes alone
  // stays whole, since a file would hold nothing the paste lacks.
  const hasDetail = input.annotations.some((annotation) => annotation.items.some(
    (item) => item.kind === 'element' && elementDetailLines(item.element, '').length > 0,
  ));
  if (full.length <= ANNOTATIONS_INLINE_LIMIT || !hasDetail) return { payload: full, detailsXml: null };

  const short = [
    ...head,
    `Full styles and HTML for every element: ${toPosix(paths.details)}`,
    '',
    ...block(false),
  ].join('\n');
  return { payload: short, detailsXml: block(true).join('\n') + '\n' };
}

export function buildPromptPayload(input: BrowserCaptureInput, relativePngPath: string): string {
  const lines: string[] = [];
  const note = input.note.trim();
  if (note) {
    lines.push(note);
  } else {
    lines.push('Look at this browser capture and tell me what you see.');
  }
  lines.push('');

  // Screenshot @-mention stays at top-level (outside the XML envelope) so
  // Claude Code / Gemini CLI's bare-token @-parsers reliably auto-inject
  // it as multimodal input. POSIX-style path for cross-platform safety.
  const posixPath = relativePngPath.replace(/\\/g, '/');
  lines.push(`Screenshot: @${posixPath}`);
  lines.push('');

  // XML envelope for the structured browser context. Per Anthropic +
  // OpenAI prompt-engineering guidance, XML tags give the model a clear
  // data/instruction boundary. Non-XML-aware agents see harmless prose.
  lines.push('<browser_context>');
  lines.push(`  <url>${escapeXml(input.url)}</url>`);

  const selection = selectedTextLine(input);
  if (selection) lines.push(selection);

  lines.push('</browser_context>');

  return lines.join('\n');
}
