/**
 * An iframe standing in for Electron's <webview> tag, for the web build only.
 *
 * The Browser pane renders a <webview> (src/renderer/components/browser/BrowserPane.tsx) and
 * drives it through the methods webview-types.ts declares. Outside Electron the tag is an
 * unknown element: it renders nothing and has none of those methods, so the pane sat on its
 * loading cover forever. This script is the mock of that one Electron surface, the way
 * tests/ui/mock-electron-api.js is the mock of the bridge: it watches for <webview> elements,
 * gives each an iframe and the method set the pane calls, and fires the events the pane waits
 * on (dom-ready, did-navigate, did-stop-loading) as the iframe loads. The renderer is untouched;
 * a custom element cannot do this because `webview` has no hyphen in its name.
 *
 * What the iframe loads is decided by window.__demoGuestPages, built at build time from the
 * sample install: the dev URL a project's tasks open (http://localhost:5173/) maps to a bundled
 * copy of what that project renders there, so the address bar shows the desktop's URL and the
 * page shows the desktop's page. Any other URL loads nothing (about:blank), stated rather than
 * spoofed: the pane's own empty state and error paths are the renderer's.
 *
 * Inert here: capturePage (rejects), executeJavaScript (resolves undefined, so Inspect finds
 * nothing), and history (canGoBack is always false). Each is a real method that does less,
 * never a missing one that throws.
 */
(function () {
  'use strict';
  var pages = window.__demoGuestPages || {};
  var nextWebContentsId = 1;

  function guestFor(url) {
    if (!url) return null;
    if (pages[url]) return pages[url];
    // A URL the seed wrote with or without its trailing slash still finds its page.
    var normalized = url.replace(/\/+$/, '') + '/';
    return pages[normalized] || null;
  }

  function fire(node, type) {
    node.dispatchEvent(new Event(type));
  }

  function decorate(node) {
    if (node.__demoWebview) return;
    node.__demoWebview = true;
    var webContentsId = nextWebContentsId++;
    var frame = document.createElement('iframe');
    frame.setAttribute('title', 'Browser pane');
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;display:block';
    if (getComputedStyle(node).display === 'inline') node.style.display = 'block';
    node.appendChild(frame);

    var currentUrl = node.getAttribute('src') || '';
    var zoom = 1;
    function applyZoom() {
      frame.style.transformOrigin = '0 0';
      frame.style.transform = 'scale(' + zoom + ')';
      frame.style.width = (100 / zoom) + '%';
      frame.style.height = (100 / zoom) + '%';
    }
    function load(url) {
      currentUrl = url || '';
      var guest = guestFor(currentUrl);
      frame.onload = function () {
        fire(node, 'dom-ready');
        fire(node, 'did-navigate');
        fire(node, 'did-stop-loading');
      };
      frame.src = guest || 'about:blank';
    }

    node.getWebContentsId = function () { return webContentsId; };
    node.getURL = function () { return currentUrl; };
    node.isLoading = function () { return false; };
    node.loadURL = function (url) { load(url); return Promise.resolve(); };
    node.reload = function () { load(currentUrl); };
    node.stop = function () {};
    node.canGoBack = function () { return false; };
    node.canGoForward = function () { return false; };
    node.goBack = function () {};
    node.goForward = function () {};
    node.setZoomFactor = function (factor) { zoom = factor; applyZoom(); };
    node.getZoomFactor = function () { return zoom; };
    node.executeJavaScript = function () { return Promise.resolve(undefined); };
    node.insertCSS = function () { return Promise.resolve(''); };
    node.capturePage = function () { return Promise.reject(new Error('capturePage is not available in the web build')); };
    node.getTitle = function () {
      try { return frame.contentDocument ? frame.contentDocument.title : ''; } catch (error) { return ''; }
    };
    node.openDevTools = function () {};
    node.closeDevTools = function () {};
    load(currentUrl);
  }

  function decorateWithin(root) {
    if (root.tagName === 'WEBVIEW') decorate(root);
    if (typeof root.querySelectorAll !== 'function') return;
    var found = root.querySelectorAll('webview');
    for (var index = 0; index < found.length; index++) decorate(found[index]);
  }

  var observer = new MutationObserver(function (mutations) {
    for (var index = 0; index < mutations.length; index++) {
      var added = mutations[index].addedNodes;
      for (var nodeIndex = 0; nodeIndex < added.length; nodeIndex++) {
        if (added[nodeIndex].nodeType === 1) decorateWithin(added[nodeIndex]);
      }
    }
  });
  function start() {
    decorateWithin(document.documentElement);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
