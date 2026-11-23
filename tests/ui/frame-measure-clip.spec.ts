/**
 * `measureFrame` (tests/captures/helpers/frame-measure.ts) clips an element's text by the overflow
 * of the ancestors whose box CONTAINS it, as CSS does. The poster gate compares what it lists, so
 * the two directions matter: a popover escaping a static overflow-hidden wrapper must still be
 * measured (or its glyphs fall out of the pixel mask), and a row a real scroller hides must not be
 * (or an overscan row that differs by display scale reads as a layout change).
 *
 * It needs real layout and computed style only, so this is a UI-tier spec over `page.setContent`.
 */
import { test, expect } from '@playwright/test';
import { measureFrame } from '../captures/helpers/frame-measure';

const DOCUMENT = `<!doctype html><html><body style="margin:0;font:14px/20px sans-serif">
  <div id="anchor" style="position:relative;left:20px;top:20px;width:300px;height:150px">
    <div id="static-wrapper" style="overflow:hidden;width:40px;height:20px">
      <span>wrapper-text</span>
      <div id="popover" style="position:absolute;left:0;top:60px;width:200px;height:30px"><span>popover-text</span></div>
    </div>
  </div>
  <div id="scroller" style="overflow:auto;position:absolute;left:400px;top:20px;width:200px;height:100px">
    <div style="height:90px">visible-row</div>
    <div style="height:20px">half-row</div>
    <div style="height:400px">far-row</div>
  </div>
</body></html>`;

test('measureFrame follows CSS containing blocks when it clips text', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 400 });
  await page.setContent(DOCUMENT);

  await test.step('an absolute popover escapes the static overflow-hidden wrapper', async () => {
    const measure = await measureFrame(page);
    const popover = measure.textNodes.find((node) => node.text === 'popover-text');
    expect(popover, 'popover text is measured').toBeDefined();
    expect(popover?.clipped).toBeUndefined();
    // It lies below the wrapper's 20px box, which would have clipped it were it followed.
    expect(popover?.lines[0].y).toBeGreaterThan(60);
  });

  await test.step('a scroller drops a row scrolled out of view and marks a half-visible row clipped', async () => {
    // Scroll so visible-row (0-90) is gone, half-row (90-110) shows 10px of 20, far-row is below.
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('#scroller');
      if (scroller) scroller.scrollTop = 100;
    });
    const measure = await measureFrame(page);
    expect(measure.textNodes.find((node) => node.text === 'visible-row'), 'scrolled-out row is dropped').toBeUndefined();
    const half = measure.textNodes.find((node) => node.text === 'half-row');
    expect(half, 'half-visible row is present').toBeDefined();
    expect(half?.clipped).toBe(true);
    const far = measure.textNodes.find((node) => node.text === 'far-row');
    expect(far, 'a row inside the scroller stays measured').toBeDefined();
  });
});
