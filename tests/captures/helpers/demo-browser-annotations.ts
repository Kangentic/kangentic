/**
 * The Browser pane annotation draft the `browser-annotations` scene opens on: three numbered
 * annotations a user left on the contoso page while reviewing the cancel flow, saved the way main
 * saves one (`src/main/browser/annotation-drafts.ts`) and served by the mock's
 * `browser.loadAnnotations` from `window.__mockBrowserAnnotationDrafts`.
 *
 * Each element is the fingerprint Inspect's own `captureFingerprint` (inspectScript.ts) takes of
 * that element on `demo/guest/contoso-web.html` in the scene's pane: the selector its
 * `buildSelector` writes, the tag, classes, role, name, text, outerHTML and ancestors read off the
 * page, and the rect and computed styles measured in the built frame. The notes are the one
 * authored part, as a user's typing always is. The pane re-resolves each element by its selector,
 * so a guest page edit that drops a target leaves its row "Not on page";
 * `tests/demo/static-demo.spec.ts` checks every selector still names one element, and
 * `tests/unit/demo-browser-annotations-seeded.test.ts` holds the draft to main's validator.
 *
 * Elements only, no drawing: an element is found again at any guest width, and a stroke is fixed
 * page pixels.
 */
import type { BrowserAnnotationDraft, BrowserPickedElement } from '../../../src/shared/types';
import { DEMO_PROJECTS, PROJECT_CONTOSO } from './demo-dataset';

const contoso = DEMO_PROJECTS.find((project) => project.id === PROJECT_CONTOSO);
if (!contoso?.dev_url) throw new Error('DEMO_PROJECTS no longer gives contoso-web the dev URL its Browser pane opens');
/** The page every annotation was made on: the URL the pane loads, so the layer draws them. */
const CONTOSO_DEV_URL = contoso.dev_url;

/** The computed style keys Inspect reads, in its order. */
function styles(values: {
  display: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  width: string;
  height: string;
  margin: string;
  padding: string;
  border: string;
  borderRadius: string;
}): Record<string, string> {
  return {
    display: values.display,
    position: 'static',
    color: values.color,
    backgroundColor: values.backgroundColor,
    fontSize: values.fontSize,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontWeight: values.fontWeight,
    lineHeight: values.lineHeight,
    width: values.width,
    height: values.height,
    margin: values.margin,
    padding: values.padding,
    border: values.border,
    borderRadius: values.borderRadius,
    opacity: '1',
    zIndex: 'auto',
  };
}

const CANCEL_BUTTON: BrowserPickedElement = {
  selector: 'div#root > main > section.card.subscription > div.subscription-foot > button.button',
  tagName: 'BUTTON',
  classes: ['button'],
  role: 'button',
  accessibleName: 'Cancel subscription',
  text: 'Cancel subscription',
  rect: { x: 624.1875, y: 304.84375, width: 166.3125, height: 39.75 },
  computedStyles: styles({
    display: 'block',
    color: 'rgb(180, 35, 24)',
    backgroundColor: 'rgb(255, 255, 255)',
    fontSize: '15px',
    fontWeight: '600',
    lineHeight: '21.75px',
    width: '166.312px',
    height: '39.75px',
    margin: '0px',
    padding: '8px 16px',
    border: '1px solid rgb(229, 180, 174)',
    borderRadius: '8px',
  }),
  outerHTML: '<button class="button" type="button">Cancel subscription</button>',
  ancestors: [
    { tagName: 'DIV', classes: ['subscription-foot'] },
    { tagName: 'SECTION', classes: ['card', 'subscription'] },
    { tagName: 'MAIN', classes: [] },
    { tagName: 'DIV', id: 'root', classes: [] },
  ],
};

const RENEWAL_DATE: BrowserPickedElement = {
  selector: 'section.card.subscription > div.subscription-head > div > div.renews > strong',
  tagName: 'STRONG',
  classes: [],
  accessibleName: 'Oct 1, 2026',
  text: 'Oct 1, 2026',
  rect: { x: 130.125, y: 247.65625, width: 80.078125, height: 21 },
  computedStyles: styles({
    display: 'inline',
    color: 'rgb(21, 32, 58)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    fontSize: '16px',
    fontWeight: '600',
    lineHeight: '23.2px',
    width: 'auto',
    height: 'auto',
    margin: '0px',
    padding: '0px',
    border: '0px none rgb(21, 32, 58)',
    borderRadius: '0px',
  }),
  outerHTML: '<strong>Oct 1, 2026</strong>',
  ancestors: [
    { tagName: 'DIV', classes: ['renews'] },
    { tagName: 'DIV', classes: [] },
    { tagName: 'DIV', classes: ['subscription-head'] },
    { tagName: 'SECTION', classes: ['card', 'subscription'] },
  ],
};

const DUE_BADGE: BrowserPickedElement = {
  selector: 'table.invoices > tbody > tr > td.status > span.badge.badge-due',
  tagName: 'SPAN',
  classes: ['badge', 'badge-due'],
  accessibleName: 'Due',
  text: 'Due',
  rect: { x: 746.015625, y: 453.6875, width: 44.484375, height: 24.84375 },
  computedStyles: styles({
    display: 'inline-block',
    color: 'rgb(135, 84, 0)',
    backgroundColor: 'rgb(253, 239, 211)',
    fontSize: '13px',
    fontWeight: '700',
    lineHeight: '18.85px',
    width: '44.4844px',
    height: '24.8438px',
    margin: '0px',
    padding: '3px 10px',
    border: '0px none rgb(135, 84, 0)',
    borderRadius: '999px',
  }),
  outerHTML: '<span class="badge badge-due">Due</span>',
  ancestors: [
    { tagName: 'TD', classes: ['status'] },
    { tagName: 'TR', classes: [] },
    { tagName: 'TBODY', classes: [] },
    { tagName: 'TABLE', classes: ['invoices'] },
  ],
};

/** The three elements in badge order, for the checks that each still names one element on the page. */
export const DEMO_BROWSER_ANNOTATION_ELEMENTS: readonly BrowserPickedElement[] = [CANCEL_BUTTON, RENEWAL_DATE, DUE_BADGE];

/** Fixed ids, since the built files are content-hashed and a random id would change every build. */
const ANNOTATION_IDS = [
  '5f1c2a8e-3b47-4d0a-9e61-7c2b8d4f1a01',
  '5f1c2a8e-3b47-4d0a-9e61-7c2b8d4f1a02',
  '5f1c2a8e-3b47-4d0a-9e61-7c2b8d4f1a03',
] as const;

const NOTES = [
  'Ask to confirm before the plan is cancelled.',
  'After a cancel this should say the plan ends Oct 1, 2026.',
  'Link Due to the invoice so it can be paid from here.',
] as const;

export const DEMO_BROWSER_ANNOTATION_DRAFT: BrowserAnnotationDraft = {
  version: 1,
  annotations: DEMO_BROWSER_ANNOTATION_ELEMENTS.map((element, index) => ({
    id: ANNOTATION_IDS[index],
    note: NOTES[index],
    url: CONTOSO_DEV_URL,
    items: [{ id: `${ANNOTATION_IDS[index]}-item`, kind: 'element' as const, element }],
    captureId: null,
  })),
  // The last annotation is the one being written, as a draft the user left mid-review reopens.
  activeId: ANNOTATION_IDS[2],
};
