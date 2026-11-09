/**
 * The `browser-annotations` scene opens the Browser pane on a seeded draft. The mock's
 * `browser.loadAnnotations` hands back whatever it is given, so a draft main would refuse (a
 * missing fingerprint field, a malformed capture id) or one made on a page the pane does not load
 * would still pass every structural check, and the scene would show a composer the desktop never
 * could. This holds the draft to main's own reader and to the guest page the pane opens.
 */
import { describe, expect, it } from 'vitest';
import { normalizeAnnotationDraft } from '../../src/main/browser/annotation-drafts';
import { DEMO_BROWSER_ANNOTATION_DRAFT } from '../captures/helpers/demo-browser-annotations';
import { DEMO_PROJECTS } from '../captures/helpers/demo-dataset';

describe('the browser-annotations scene draft', () => {
  it('is a draft main reads back whole', () => {
    expect(normalizeAnnotationDraft(JSON.parse(JSON.stringify(DEMO_BROWSER_ANNOTATION_DRAFT)))).toEqual(DEMO_BROWSER_ANNOTATION_DRAFT);
  });

  it('was made on a page the sample install serves to its Browser pane', () => {
    const guestUrls = DEMO_PROJECTS.filter((project) => project.guest_page).map((project) => project.dev_url);
    for (const annotation of DEMO_BROWSER_ANNOTATION_DRAFT.annotations) expect(guestUrls).toContain(annotation.url);
  });
});
