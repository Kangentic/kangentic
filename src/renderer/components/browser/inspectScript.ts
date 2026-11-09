// Element-picker script injected into the webview via
// `webview.executeJavaScript()`. Activates a hover-outline overlay and a
// one-shot click handler that captures a structured fingerprint of the
// clicked element. Esc cancels and resolves null.
//
// Select element mode stays on across picks, and the pane injects this again
// after each answer. Between one pick and the next script there is no picker,
// so a guard installed once per document (`__kangenticInspectMode`) swallows
// the page's presses for as long as the mode is on: a quick second click never
// activates the link or button under it. The pane clears the mode when it
// ends.
//
// The fingerprint is what an AI coding agent actually needs to grep the
// codebase: selector, ARIA role + accessible name (Playwright-style),
// data-testid, classes, ancestors, plus a tiny subset of computed styles
// and the element's own outerHTML. Mirrors Chrome DevTools MCP's
// "snapshot over screenshot" guidance: structured grep targets, not raw
// rendered HTML.

import { ANNOTATION_LAYER_HOST_ATTRIBUTE } from './annotations/annotationLayerScript';

export interface PickedElement {
  selector: string;
  tagName: string;
  id?: string;
  classes: string[];
  testId?: string;
  ariaLabel?: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  outerHTML: string;
  ancestors: Array<{
    tagName: string;
    id?: string;
    classes: string[];
    testId?: string;
    role?: string;
  }>;
}

export const INSPECT_SCRIPT = `
(function () {
  return new Promise((resolve) => {
    if (window.__kangenticInspectActive) {
      resolve(null);
      return;
    }
    window.__kangenticInspectActive = true;
    window.__kangenticInspectMode = true;

    // Installed once per document. A click the armed picker takes is its own;
    // every other press, and a click between two pickers, never reaches the
    // page. A press on the annotation layer is left to the layer's badges.
    if (!window.__kangenticInspectGuard) {
      const guard = (event) => {
        if (!window.__kangenticInspectMode) return;
        if (event.type === 'click' && window.__kangenticInspectActive) return;
        const target = event.target;
        if (target && target.hasAttribute && target.hasAttribute('${ANNOTATION_LAYER_HOST_ATTRIBUTE}')) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      };
      window.__kangenticInspectGuard = guard;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick']) {
        window.addEventListener(type, guard, true);
      }
    }

    const overlay = document.createElement('div');
    overlay.setAttribute('data-kangentic-inspector', '1');
    overlay.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'border:2px solid #ff3b3b',
      'background:rgba(255,59,59,0.12)',
      'box-sizing:border-box',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'transition:top 30ms ease-out,left 30ms ease-out,width 30ms ease-out,height 30ms ease-out',
    ].join(';');
    document.documentElement.appendChild(overlay);

    function isOurOverlay(el) {
      return el && el.hasAttribute && el.hasAttribute('data-kangentic-inspector');
    }

    const ROLE_MAP = {
      a: 'link', button: 'button', img: 'img',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
      aside: 'complementary', section: 'region', article: 'article',
      ul: 'list', ol: 'list', li: 'listitem',
      table: 'table', tr: 'row', td: 'cell', th: 'columnheader',
      form: 'form', select: 'combobox', textarea: 'textbox',
    };

    function getRole(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'submit' || t === 'button') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      return ROLE_MAP[tag];
    }

    function getAccessibleName(el) {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const target = document.getElementById(labelledBy);
        if (target && target.textContent) return target.textContent.trim();
      }
      const alt = el.getAttribute('alt');
      if (alt) return alt.trim();
      const title = el.getAttribute('title');
      if (title) return title.trim();
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
      const text = (el.textContent || '').trim();
      if (text) return text.length > 100 ? text.slice(0, 100) + '...' : text;
      return '';
    }

    function countMatches(selector) {
      try { return document.querySelectorAll(selector).length; } catch (caught) { return -1; }
    }

    function nthOfType(element) {
      let index = 1;
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === element.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      return index;
    }

    // A selector that names exactly this element. Two id-less inputs under the
    // same field wrapper would otherwise share one, and an annotation could
    // neither find its element again after a reload nor tell the agent which
    // one was meant. From the leaf up, :nth-of-type is added to one segment at
    // a time until the page has a single match.
    function buildSelector(el) {
      const escape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
      if (el.id) {
        const byId = el.tagName.toLowerCase() + '#' + escape(el.id);
        if (countMatches(byId) === 1) return byId;
      }
      const parts = [];
      let current = el;
      while (current && current !== document.body && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        let segment = tag;
        const testId = current.getAttribute('data-testid') || current.getAttribute('data-test-id');
        if (current.id) {
          parts.unshift({ element: current, segment: tag + '#' + escape(current.id) });
          break;
        } else if (testId) {
          segment += '[data-testid="' + testId.replace(/["\\\\]/g, '\\\\$&') + '"]';
        } else if (current.classList && current.classList.length) {
          segment += '.' + Array.from(current.classList).slice(0, 2).map(escape).join('.');
        }
        parts.unshift({ element: current, segment });
        current = current.parentElement;
      }
      const join = () => parts.map((part) => part.segment).join(' > ');
      for (let index = parts.length - 1; index >= 0 && countMatches(join()) !== 1; index -= 1) {
        const part = parts[index];
        if (part.element.parentElement) part.segment += ':nth-of-type(' + nthOfType(part.element) + ')';
      }
      return join();
    }

    function captureFingerprint(el) {
      const computed = window.getComputedStyle(el);
      const STYLE_KEYS = [
        'display', 'position', 'color', 'backgroundColor', 'fontSize',
        'fontFamily', 'fontWeight', 'lineHeight', 'width', 'height',
        'margin', 'padding', 'border', 'borderRadius', 'opacity', 'zIndex',
      ];
      const computedStyles = {};
      for (const key of STYLE_KEYS) {
        computedStyles[key] = computed[key];
      }
      const rect = el.getBoundingClientRect();
      const ancestors = [];
      let parent = el.parentElement;
      while (parent && parent !== document.body && ancestors.length < 4) {
        ancestors.push({
          tagName: parent.tagName,
          id: parent.id || undefined,
          classes: Array.from(parent.classList || []),
          testId: parent.getAttribute('data-testid') || parent.getAttribute('data-test-id') || undefined,
          role: parent.getAttribute('role') || undefined,
        });
        parent = parent.parentElement;
      }
      return {
        selector: buildSelector(el),
        tagName: el.tagName,
        id: el.id || undefined,
        classes: Array.from(el.classList || []),
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        role: getRole(el),
        accessibleName: getAccessibleName(el),
        text: (el.textContent || '').trim().slice(0, 200),
        // Page coordinates, so the rect still names the element's place
        // after the page scrolls.
        rect: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
        computedStyles,
        outerHTML: (el.outerHTML || '').slice(0, 800),
        ancestors,
      };
    }

    function cleanup() {
      window.__kangenticInspectActive = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      try { overlay.remove(); } catch (e) { /* ignore */ }
    }

    // The element under the pointer. An annotation badge sits over the page in
    // its own shadow root, so an event on it reads as the layer's host; the
    // pick is the page element beneath it, never the badge.
    function pageTarget(event) {
      const target = event.target;
      if (!target || !target.hasAttribute || !target.hasAttribute('${ANNOTATION_LAYER_HOST_ATTRIBUTE}')) return target;
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      for (const candidate of stack) {
        if (isOurOverlay(candidate)) continue;
        if (candidate.hasAttribute && candidate.hasAttribute('${ANNOTATION_LAYER_HOST_ATTRIBUTE}')) continue;
        return candidate;
      }
      return null;
    }

    function onMove(event) {
      const target = pageTarget(event);
      if (!target || isOurOverlay(target)) return;
      const rect = target.getBoundingClientRect();
      overlay.style.top = rect.top + 'px';
      overlay.style.left = rect.left + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
    }

    function onClick(event) {
      const target = pageTarget(event);
      if (!target || isOurOverlay(target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      const fingerprint = captureFingerprint(target);
      cleanup();
      resolve(fingerprint);
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.__kangenticInspectMode = false;
        cleanup();
        resolve(null);
      }
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
})();
`;
