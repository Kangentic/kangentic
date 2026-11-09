import { ANNOTATION_LAYOUT_SOURCE } from './annotation-layout';

// The page layer that draws annotations INTO the guest page, so they scroll
// with it and land in every capture of it. Injected with
// `webview.executeJavaScript` (never the CDP driver: see
// .claude/rules/agent-driven-focus.md) and installed once per document.
//
// It mounts in a CLOSED shadow root on one host element at the document
// origin. The page's CSS never reaches the badges, and nothing outside the
// layer can see into it: the page's own `querySelector`, and an agent's
// `kangentic_browser_query_*`, never match a badge's "2".
//
// The renderer owns the state and hands it over whole on every change
// (`render`); the layer keeps the last one so it can redraw on scroll, resize
// and DOM changes by itself. A press in the guest never reaches the host
// window, so a badge click is answered through a long-lived call the
// renderer keeps armed (`nextBadgeClick`), the way Inspect waits for a pick.

/** The attribute on the layer's host element. Inspect skips it when it hit-tests. */
export const ANNOTATION_LAYER_HOST_ATTRIBUTE = 'data-kangentic-annotations';

/** An item as the page layer draws it. */
export type AnnotationLayerItem =
  | { id: string; kind: 'element'; selector: string; role?: string; name?: string; tag: string; testId?: string }
  | { id: string; kind: 'drawing'; strokes: Array<Array<{ x: number; y: number }>> };

export interface AnnotationLayerAnnotation {
  number: number;
  /** `strong` for the active annotation, `faded` for the rest. */
  emphasis: 'strong' | 'faded';
  items: AnnotationLayerItem[];
}

/** What the pointer is over in the pane's list: drawn stronger, without resending the marks. */
export interface AnnotationLayerHover {
  /** A hovered annotation row's number: drawn as strong as the active one. */
  hoveredNumber: number | null;
  /** An item the user is hovering in the item list: it shows, the rest dim. */
  hoveredItemId: string | null;
}

export interface AnnotationLayerState extends AnnotationLayerHover {
  hidden: boolean;
  /** The floating bar's rect in viewport px, which drawing badges keep clear of. */
  barRect: { x: number; y: number; width: number; height: number } | null;
  annotations: AnnotationLayerAnnotation[];
}

export interface AnnotationLayerStatus {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  url: string;
  items: Record<string, { onPage: boolean; inViewport: boolean }>;
}

const LAYER_SOURCE = String.raw`
(function () {
  if (window.__kangenticAnnotations) return;
  ${'$'}{LAYOUT}

  var HOST_ATTRIBUTE = '${'$'}{HOST_ATTRIBUTE}';
  var host = null;
  var root = null;
  var stage = null;
  var lastState = null;
  var elementCache = {};
  var badgeWaiters = [];
  var frameRequested = false;
  var mutationTimer = null;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute(HOST_ATTRIBUTE, '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;'
      + 'pointer-events:none;z-index:2147483646;margin:0;padding:0;border:0;';
    root = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = ''
      + '.outline{position:absolute;box-sizing:border-box;border:2px solid #3b82f6;'
      + 'background:rgba(59,130,246,0.08);pointer-events:none;}'
      + '.badge{position:absolute;width:18px;height:18px;border-radius:9px;background:#2563eb;color:#fff;'
      + 'font:700 11px/18px system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;'
      + 'box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,0.35);pointer-events:auto;cursor:pointer;'
      + 'user-select:none;}'
      + 'svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;}';
    root.appendChild(style);
    stage = document.createElement('div');
    root.appendChild(stage);
    // On the shadow root, not the document: a closed root hides its nodes from
    // composedPath() for any listener outside it. Stopping here also keeps the
    // click from reaching the page.
    root.addEventListener('click', onBadgeClick);
    document.documentElement.appendChild(host);
  }

  function accessibleName(element) {
    var aria = element.getAttribute('aria-label');
    if (aria) return aria.trim();
    var alt = element.getAttribute('alt');
    if (alt) return alt.trim();
    var placeholder = element.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    var text = (element.textContent || '').trim();
    return text.length > 100 ? text.slice(0, 100) + '...' : text;
  }

  function queryAll(selector) {
    try { return document.querySelectorAll(selector); } catch (error) { return []; }
  }

  // The element a selector names, or else the one element whose test id, or
  // tag and accessible name, still match. Never a guess between two.
  function resolveElement(item) {
    var cached = elementCache[item.id];
    if (cached && cached.isConnected) return cached;
    var matches = queryAll(item.selector);
    var found = null;
    if (matches.length === 1) found = matches[0];
    if (!found && item.testId) {
      var byTestId = queryAll('[data-testid="' + item.testId.replace(/["\\]/g, '\\$&') + '"]');
      if (byTestId.length === 1) found = byTestId[0];
    }
    if (!found && item.name) {
      var sameTag = document.getElementsByTagName(item.tag || '*');
      var named = [];
      for (var i = 0; i < sameTag.length && named.length < 2; i++) {
        if (accessibleName(sameTag[i]) === item.name) named.push(sameTag[i]);
      }
      if (named.length === 1) found = named[0];
    }
    if (found) elementCache[item.id] = found; else delete elementCache[item.id];
    return found;
  }

  function intersectsViewport(rect) {
    var left = rect.x - window.scrollX;
    var top = rect.y - window.scrollY;
    return left < window.innerWidth && left + rect.width > 0 && top < window.innerHeight && top + rect.height > 0;
  }

  function opacityFor(annotation, item, state) {
    if (state.hoveredItemId) return item.id === state.hoveredItemId ? 1 : 0.25;
    return annotation.emphasis === 'strong' || annotation.number === state.hoveredNumber ? 1 : 0.45;
  }

  function draw(state) {
    lastState = state;
    ensureHost();
    host.style.display = state.hidden ? 'none' : '';
    // The last drawing comes off before the page is measured: it adds to the
    // page's scrollable size, so a page that got shorter would never shrink.
    stage.textContent = '';
    var status = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      url: location.href,
      items: {},
    };
    var fragment = document.createDocumentFragment();
    var svgNamespace = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNamespace, 'svg');
    var pageWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    var pageHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    svg.setAttribute('width', String(pageWidth));
    svg.setAttribute('height', String(pageHeight));
    fragment.appendChild(svg);

    var layoutItems = [];
    var owners = {};
    for (var a = 0; a < state.annotations.length; a++) {
      var annotation = state.annotations[a];
      for (var i = 0; i < annotation.items.length; i++) {
        var item = annotation.items[i];
        owners[item.id] = { annotation: annotation, item: item };
        var opacity = opacityFor(annotation, item, state);
        if (item.kind === 'element') {
          var element = resolveElement(item);
          if (!element) {
            status.items[item.id] = { onPage: false, inViewport: false };
            continue;
          }
          var bounds = element.getBoundingClientRect();
          var rect = { x: bounds.left + window.scrollX, y: bounds.top + window.scrollY, width: bounds.width, height: bounds.height };
          status.items[item.id] = { onPage: true, inViewport: intersectsViewport(rect) };
          var outline = document.createElement('div');
          outline.className = 'outline';
          outline.style.left = (rect.x - 2) + 'px';
          outline.style.top = (rect.y - 2) + 'px';
          outline.style.width = (rect.width + 4) + 'px';
          outline.style.height = (rect.height + 4) + 'px';
          outline.style.opacity = String(opacity);
          fragment.appendChild(outline);
          layoutItems.push({ key: item.id, kind: 'element', rect: rect });
        } else {
          var box = kngStrokeBox(item.strokes);
          status.items[item.id] = { onPage: true, inViewport: !!box && intersectsViewport(box) };
          for (var s = 0; s < item.strokes.length; s++) {
            var stroke = item.strokes[s];
            if (stroke.length === 0) continue;
            var path = document.createElementNS(svgNamespace, 'path');
            var pathData = 'M' + stroke[0].x + ' ' + stroke[0].y;
            for (var p = 1; p < stroke.length; p++) pathData += ' L' + stroke[p].x + ' ' + stroke[p].y;
            if (stroke.length === 1) pathData += ' L' + (stroke[0].x + 0.1) + ' ' + stroke[0].y;
            path.setAttribute('d', pathData);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', '#ff3b3b');
            path.setAttribute('stroke-width', '3');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('opacity', String(opacity));
            svg.appendChild(path);
          }
          layoutItems.push({ key: item.id, kind: 'drawing', strokes: item.strokes });
        }
      }
    }

    var blocked = [];
    if (state.barRect) {
      blocked.push({
        x: state.barRect.x + window.scrollX,
        y: state.barRect.y + window.scrollY,
        width: state.barRect.width,
        height: state.barRect.height,
      });
    }
    var centers = kngPlaceBadges({ pageWidth: pageWidth, blocked: blocked, items: layoutItems });
    for (var key in centers) {
      var owner = owners[key];
      if (!owner) continue;
      var badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = String(owner.annotation.number);
      badge.style.left = (centers[key].x - 9) + 'px';
      badge.style.top = (centers[key].y - 9) + 'px';
      badge.style.opacity = String(opacityFor(owner.annotation, owner.item, state));
      badge.setAttribute('data-number', String(owner.annotation.number));
      fragment.appendChild(badge);
    }

    stage.appendChild(fragment);
    return status;
  }

  function scheduleRedraw() {
    if (!lastState || frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(function () {
      frameRequested = false;
      if (lastState) draw(lastState);
    });
  }

  function onBadgeClick(event) {
    var path = event.composedPath ? event.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node && node.getAttribute && node.getAttribute('data-number')) {
        event.preventDefault();
        event.stopPropagation();
        var number = Number(node.getAttribute('data-number'));
        var waiters = badgeWaiters;
        badgeWaiters = [];
        for (var w = 0; w < waiters.length; w++) waiters[w]({ activate: number });
        return;
      }
    }
  }

  window.addEventListener('scroll', scheduleRedraw, true);
  window.addEventListener('resize', scheduleRedraw);
  if (typeof MutationObserver !== 'undefined' && document.body) {
    new MutationObserver(function () {
      // Nothing drawn (cleared, or never rendered): a busy page sets no timers.
      if (!lastState) return;
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(function () {
        mutationTimer = null;
        elementCache = {};
        scheduleRedraw();
      }, 150);
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.__kangenticAnnotations = {
    render: function (state) { return draw(state); },
    hover: function (hover) {
      if (!lastState) return;
      lastState.hoveredNumber = hover.hoveredNumber;
      lastState.hoveredItemId = hover.hoveredItemId;
      scheduleRedraw();
    },
    nextBadgeClick: function () {
      return new Promise(function (resolve) { badgeWaiters.push(resolve); });
    },
    cancelBadgeWait: function () {
      var waiters = badgeWaiters;
      badgeWaiters = [];
      for (var w = 0; w < waiters.length; w++) waiters[w](null);
    },
    clear: function () {
      lastState = null;
      elementCache = {};
      if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
      if (stage) stage.textContent = '';
    },
    scroll: function () { return { x: window.scrollX, y: window.scrollY }; },
    // Resolves once what the last render drew has been painted: two frames,
    // the second starting after the first was presented. A page that paints
    // no frames (hidden) answers at the bound instead of never.
    afterPaint: function () {
      return new Promise(function (resolve) {
        var done = false;
        var finish = function () { if (!done) { done = true; resolve(true); } };
        requestAnimationFrame(function () { requestAnimationFrame(finish); });
        setTimeout(finish, 250);
      });
    },
  };
})();
`
  // Function replacers: a string replacement would read `$&` and friends.
  .replace('${LAYOUT}', () => ANNOTATION_LAYOUT_SOURCE)
  .replace('${HOST_ATTRIBUTE}', () => ANNOTATION_LAYER_HOST_ATTRIBUTE);

/**
 * A script that installs the layer if this document has none, then runs one
 * call on it and returns its value. Every call carries the installer, so a
 * page that reloaded since the last call is fixed by the call itself.
 */
function annotationLayerCall(expression: string): string {
  return `${LAYER_SOURCE}\nwindow.__kangenticAnnotations.${expression};`;
}

export function renderAnnotationLayerScript(state: AnnotationLayerState): string {
  return annotationLayerCall(`render(${JSON.stringify(state)})`);
}

/**
 * Restyles what the layer already drew for a hover in the pane's list. No
 * installer and no marks: a page with no layer has nothing to restyle, and a
 * pointer moving down the list must not resend every stroke into the page.
 */
export function hoverAnnotationLayerScript(hover: AnnotationLayerHover): string {
  return `window.__kangenticAnnotations && window.__kangenticAnnotations.hover(${JSON.stringify(hover)});`;
}

export const ANNOTATION_LAYER_SCROLL_SCRIPT = annotationLayerCall('scroll()');
export const ANNOTATION_LAYER_NEXT_BADGE_CLICK_SCRIPT = annotationLayerCall('nextBadgeClick()');
export const ANNOTATION_LAYER_CANCEL_BADGE_WAIT_SCRIPT = annotationLayerCall('cancelBadgeWait()');
export const ANNOTATION_LAYER_CLEAR_SCRIPT = annotationLayerCall('clear()');
export const ANNOTATION_LAYER_AFTER_PAINT_SCRIPT = annotationLayerCall('afterPaint()');
