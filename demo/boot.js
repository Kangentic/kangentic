/**
 * Boot script for the web build of the desktop renderer.
 *
 * Runs as a classic script BEFORE tests/ui/mock-electron-api.js, so it owns everything the mock
 * reads at load time (window.__mockConfigOverrides) and everything the demo adds around the
 * renderer: the URL contract, the theme class, the still and embed styles, the scene applier
 * the seed script calls back into, and the boot-step runner that reveals the frame.
 *
 * The renderer knows nothing about any of this. Every demo behaviour lives here or in the scene
 * registry (tests/captures/scenes.ts); src/renderer never checks location or a demo flag.
 *
 * URL contract (all optional):
 *   view=<scene>     a named scene from the registry; default "board" unless state= is given
 *   state=<base64url JSON of DemoState>  declarative state merged over the scene (or standalone)
 *   theme=night|sand|<any app theme id>  "night" is the app's dark theme, the no-class default
 *   embed=1          hide the OS window controls and render edge to edge (a host sizes the iframe)
 *   stage=0          render edge to edge without a host; otherwise a page opened directly hands
 *                    over to stage.html, which hosts the frame at the site's 1600 by 1000, the
 *                    size every terminal recording was made for
 *   still=1          no motion: zero animation and transition durations, frozen marks and clocks,
 *                    and every terminal painted from its recording's final frame (without it,
 *                    each terminal replays its recording as it happened; demo/README.md)
 *   loop=1           a working session that reaches its recording's end goes back to working and
 *                    replays it, so a frame left running keeps moving. Off by default: a hero or
 *                    a docs figure must not reset state under a visitor who has taken control.
 *   fs=<px>          root font size for the UI (8..32) and the terminal font size
 *
 * A scene the registry does not know, a rig-only scene, or a malformed state= blob renders a
 * full-frame error card and boots nothing: a page must never caption a scene the visitor is not
 * looking at. The parent frame is told either way (kangentic-demo-ready / kangentic-demo-error).
 */
(function () {
  'use strict';

  // Hand-maintained mirror of ThemeMode in src/shared/types.ts. Nothing ties the two
  // together, so a theme added there has to be added here or ?theme=<id> is refused.
  var APP_THEMES = ['dark', 'light', 'kangentic-light', 'kangentic-dark',
    'moon', 'forest', 'ocean', 'ember', 'sand', 'mint', 'sky', 'peach'];
  // The site embeds this frame by URL, so a spelling it may already have written keeps
  // resolving rather than hitting the error card.
  var THEME_ALIASES = { night: 'dark', kangentic: 'kangentic-light' };
  var STATE_KEYS = ['config', 'tasks', 'sessions', 'seeds', 'steps'];
  var BOOT_TIMEOUT_MS = 10000;

  var scenes = window.__demoScenes || {};
  var version = window.__demoVersion || '0.0.0';
  var params = new URLSearchParams(window.location.search);
  var errors = [];

  function bootableSceneNames() {
    return Object.keys(scenes).filter(function (name) { return scenes[name].reach !== 'driver'; });
  }

  function decodeBase64Url(text) {
    var base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    var binary = window.atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** Reject anything a DemoState blob is not allowed to carry. Data only, never code. */
  function validateState(state, origin) {
    if (!isPlainObject(state)) throw new Error(origin + ' must be a JSON object');
    Object.keys(state).forEach(function (key) {
      if (STATE_KEYS.indexOf(key) === -1) throw new Error(origin + ' has an unknown key "' + key + '" (allowed: ' + STATE_KEYS.join(', ') + ')');
    });
    if (state.config !== undefined && !isPlainObject(state.config)) throw new Error(origin + '.config must be an object');
    if (state.tasks !== undefined) {
      if (!Array.isArray(state.tasks)) throw new Error(origin + '.tasks must be an array');
      state.tasks.forEach(function (task) {
        if (!isPlainObject(task) || typeof task.id !== 'string') throw new Error(origin + '.tasks entries need a string id');
      });
    }
    if (state.sessions !== undefined && !isPlainObject(state.sessions)) throw new Error(origin + '.sessions must be an object keyed by session id');
    if (state.seeds !== undefined) {
      if (!isPlainObject(state.seeds)) throw new Error(origin + '.seeds must be an object');
      Object.keys(state.seeds).forEach(function (key) {
        if (key.indexOf('__mock') !== 0) throw new Error(origin + '.seeds keys must start with __mock (got "' + key + '")');
      });
    }
    if (state.steps !== undefined) {
      if (!Array.isArray(state.steps)) throw new Error(origin + '.steps must be an array');
      state.steps.forEach(function (step) {
        if (!isPlainObject(step) || typeof step.click !== 'string') throw new Error(origin + '.steps entries need a click selector');
        Object.keys(step).forEach(function (key) {
          if (key !== 'click' && key !== 'waitFor') throw new Error(origin + '.steps only support click and waitFor here; "' + key + '" is a capture-rig step');
        });
      });
    }
  }

  /** Later sources win per key; arrays concatenate; nested config objects are replaced whole. */
  function mergeStates(sources) {
    var merged = { config: {}, tasks: [], sessions: {}, seeds: {}, steps: [] };
    sources.forEach(function (source) {
      if (!source) return;
      Object.assign(merged.config, source.config || {});
      merged.tasks = merged.tasks.concat(source.tasks || []);
      Object.assign(merged.sessions, source.sessions || {});
      Object.assign(merged.seeds, source.seeds || {});
      merged.steps = merged.steps.concat(source.steps || []);
    });
    return merged;
  }

  // ---------------------------------------------------------------- resolve the URL
  var sceneName = params.get('view');
  if (sceneName === null && !params.has('state')) sceneName = 'board';
  var scene = null;
  if (sceneName !== null) {
    scene = scenes[sceneName] || null;
    if (!scene) {
      errors.push('Unknown scene "' + sceneName + '". Scenes that boot here: ' + bootableSceneNames().join(', ') + '.');
    } else if (scene.reach === 'driver') {
      errors.push('Scene "' + sceneName + '" needs the capture rig (a hover, a drag, or an open menu) and cannot boot from a URL.');
      scene = null;
    }
  }

  var urlState = null;
  if (params.has('state')) {
    try {
      urlState = JSON.parse(decodeBase64Url(params.get('state') || ''));
      validateState(urlState, 'state=');
    } catch (error) {
      urlState = null;
      errors.push('The state= parameter is not usable: ' + (error && error.message ? error.message : String(error)));
    }
  }

  var themeParam = params.get('theme');
  var theme = themeParam ? (THEME_ALIASES[themeParam] || themeParam) : 'dark';
  if (APP_THEMES.indexOf(theme) === -1) {
    errors.push('Unknown theme "' + themeParam + '". Use night, sand, or an app theme id: ' + APP_THEMES.join(', ') + '.');
    theme = 'dark';
  }

  var embed = params.get('embed') === '1';
  // Opened directly, the page hands over to stage.html, which hosts this frame at the site's
  // 1600 by 1000: every terminal recording was made at that size, and a replay cannot follow a
  // window the way a live PTY does. A host that sizes the iframe itself passes embed=1;
  // stage=0 renders edge to edge in whatever window there is.
  if (!embed && params.get('stage') !== '0') {
    location.replace('stage.html' + location.search);
    return;
  }
  var still = params.get('still') === '1';
  // A still frame has no clock to loop, so asking for both is a contradiction rather than a
  // preference: say so instead of quietly dropping one.
  var loop = params.get('loop') === '1';
  if (loop && still) errors.push('loop=1 and still=1 cannot both be set: a still frame has no replay to loop.');
  var fontSize = null;
  if (params.has('fs')) {
    var parsed = parseInt(params.get('fs') || '', 10);
    if (Number.isNaN(parsed) || parsed < 8 || parsed > 32) errors.push('fs must be an integer between 8 and 32 (got "' + params.get('fs') + '").');
    else fontSize = parsed;
  }

  var effective = mergeStates([scene, urlState]);

  // ---------------------------------------------------------------- config overrides
  // Object.assign in the mock is shallow, so nested objects are re-supplied whole.
  var overrides = {
    theme: theme,
    terminal: {
      shell: null,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: fontSize || 12,
      showPreview: false,
      panelHeight: 280,
      cursorStyle: 'block',
      colors: {},
      backspaceSendsCtrlH: false,
    },
    // Wide enough that every project name in the sample install shows in full at the site
    // frame (the longest clips below 270px, measured), narrow enough to leave the board room.
    sidebar: { width: 280 },
    terminalPanelVisible: true,
    hasCompletedFirstRun: true,
    // The app ships Ticket Numbers ON (DEFAULT_CONFIG.showTaskNumbers in src/shared/types.ts),
    // and the frame has to show what a desktop install shows. Restated here because the mock
    // bridge carries false, which is drift against that default rather than a demo choice.
    showTaskNumbers: true,
    lastWhatsNewShownVersion: version,
  };
  if (still) overrides.animationsEnabled = false;
  Object.assign(overrides, effective.config);
  window.__mockConfigOverrides = overrides;

  // ---------------------------------------------------------------- document-level effects
  if (theme !== 'dark') document.documentElement.classList.add('theme-' + theme);
  if (fontSize !== null) document.documentElement.style.fontSize = fontSize + 'px';

  function injectStyle(css) {
    var style = document.createElement('style');
    style.setAttribute('data-demo-style', '');
    style.textContent = css;
    document.head.appendChild(style);
  }

  if (embed) {
    injectStyle('[data-testid="window-controls"] { display: none !important; }');
  }

  if (still) {
    // Zero durations, never `animation: none`, on the general rules: the overlay-* classes
    // unmount on animationend, which still fires at 0s and never at none. The activity marks
    // are infinite loops with no listener, so those can stop outright.
    injectStyle(
      '*, *::before, *::after {' +
      ' animation-duration: 0s !important; animation-delay: 0s !important;' +
      ' transition-duration: 0s !important; transition-delay: 0s !important; }' +
      ' .kng-spin, .kng-blink, .kng-march { animation: none !important; }' +
      ' svg[data-rest="drop-dash"] * { stroke-dasharray: none !important; }',
    );
    // The two ticking clocks seed their state synchronously and only tick through
    // setInterval; the mock has no intervals of its own; the seed installs none.
    window.setInterval = function () { return 0; };
  }

  // ---------------------------------------------------------------- scene application
  function applyScene() {
    // The version is stamped even when nothing else is: the mock reports 0.1.0 and the
    // overrides above already claim this build's version as seen, so a mismatch here would
    // open the What's New dialog behind the error card.
    window.electronAPI.app.getVersion = function () { return Promise.resolve(version); };
    if (errors.length > 0) return;
    if (typeof window.__demoApplyFixture === 'function') window.__demoApplyFixture();

    if (effective.tasks.length > 0 || Object.keys(effective.sessions).length > 0) {
      window.__mockPreConfigure(function (state) {
        effective.tasks.forEach(function (patch) {
          var row = state.tasks.find(function (task) { return task.id === patch.id; })
            || state.archivedTasks.find(function (task) { return task.id === patch.id; });
          if (!row) throw new Error('Scene patches task "' + patch.id + '", which the sample install does not contain');
          Object.assign(row, patch);
        });
        Object.keys(effective.sessions).forEach(function (sessionId) {
          var patch = effective.sessions[sessionId];
          if (patch && patch.activity) state.activityCache[sessionId] = patch.activity;
        });
      });
    }

    Object.keys(effective.seeds).forEach(function (key) {
      window[key] = effective.seeds[key];
    });
    // Terminal bytes are delivered by the dataset script through getScrollback (the production
    // mount-replay path); the demo adds no pump and no timer of its own.
  }

  // ---------------------------------------------------------------- boot-step runner
  function waitForSelector(selector, deadline) {
    return new Promise(function (resolve, reject) {
      (function poll() {
        var element = document.querySelector(selector);
        if (element) return resolve(element);
        if (Date.now() > deadline) return reject(new Error('Timed out waiting for ' + selector));
        window.requestAnimationFrame(poll);
      })();
    });
  }

  function notifyParent(message) {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
  }

  function renderErrorCard() {
    var card = document.createElement('div');
    card.setAttribute('data-testid', 'demo-error');
    card.setAttribute('role', 'alert');
    card.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;'
      + 'background:rgba(24,24,27,0.72);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#f4f4f5';
    var box = document.createElement('div');
    box.style.cssText = 'width:min(560px,90vw);background:#27272a;border:1px solid #3f3f46;border-radius:8px;'
      + 'box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);padding:24px 28px';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:16px;font-weight:600';
    title.textContent = 'This demo frame could not open';
    box.appendChild(title);
    errors.forEach(function (text) {
      var line = document.createElement('p');
      line.style.cssText = 'margin:12px 0 0;font-size:14px;line-height:20px;color:#d4d4d8';
      line.textContent = text;
      box.appendChild(line);
    });
    var hint = document.createElement('p');
    hint.style.cssText = 'margin:12px 0 0;font-size:12px;line-height:16px;color:#a1a1aa';
    hint.textContent = 'Nothing was seeded. The app behind this card booted empty so nothing hangs; it is not a fallback scene.';
    box.appendChild(hint);
    card.appendChild(box);
    document.body.appendChild(card);
  }

  function markReady() {
    document.documentElement.setAttribute('data-demo-ready', '1');
    document.documentElement.setAttribute('data-demo-scene', sceneName || 'state');
    notifyParent({ type: 'kangentic-demo-ready', scene: sceneName, version: version });
  }

  function runBootSteps() {
    var root = document.getElementById('root');
    var deadline = Date.now() + BOOT_TIMEOUT_MS;
    var veiled = effective.steps.length > 0;
    if (veiled && root) root.style.visibility = 'hidden';
    var chain = waitForSelector('[data-swimlane-name]', deadline);
    effective.steps.forEach(function (step) {
      chain = chain.then(function () {
        var target = document.querySelector(step.click);
        if (!target) throw new Error('Boot step could not find ' + step.click);
        target.click();
        return step.waitFor ? waitForSelector(step.waitFor, deadline) : null;
      });
    });
    chain.then(function () {
      if (veiled && root) root.style.visibility = '';
      markReady();
    }).catch(function (error) {
      if (veiled && root) root.style.visibility = '';
      errors.push('Boot step failed: ' + (error && error.message ? error.message : String(error)));
      console.error('[kangentic-demo]', errors[errors.length - 1]);
      renderErrorCard();
      notifyParent({ type: 'kangentic-demo-error', reason: errors.join(' ') });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (errors.length > 0) {
      errors.forEach(function (text) { console.error('[kangentic-demo] ' + text); });
      renderErrorCard();
      notifyParent({ type: 'kangentic-demo-error', reason: errors.join(' ') });
      return;
    }
    runBootSteps();
  }, { once: true });

  window.__demoBoot = {
    version: version,
    sceneName: sceneName,
    scene: effective,
    params: { theme: theme, embed: embed, still: still, loop: loop, fontSize: fontSize },
    errors: errors,
    afterSeed: applyScene,
  };
})();
