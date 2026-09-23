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
 * Ready fires only once the scene's `ready` element exists, and carries the rect of its `focus`
 * element (fractions of the frame) so a host can crop a dialog scene to the dialog.
 */
(function () {
  'use strict';

  // Hand-maintained mirror of ThemeMode in src/shared/types.ts. Nothing ties the two
  // together, so a theme added there has to be added here or ?theme=<id> is refused.
  var APP_THEMES = ['dark', 'light', 'rust', 'clay',
    'moon', 'forest', 'ocean', 'ember', 'sand', 'mint', 'sky', 'peach'];
  // The site embeds this frame by URL, so a spelling it may already have written keeps
  // resolving rather than hitting the error card. The product pair shipped briefly as
  // kangentic-light / kangentic-dark before being named clay / rust.
  var THEME_ALIASES = { night: 'dark', kangentic: 'clay', 'kangentic-light': 'clay', 'kangentic-dark': 'rust' };
  var STATE_KEYS = ['config', 'tasks', 'sessions', 'seeds', 'steps'];
  // A boot step clicks, types into a field, or presses a hotkey (a keyboard combo or a mouse
  // button, in the registry's own spelling, held for the frame); anything else (a hover, a
  // drag, a right-click) is the capture rig's and is refused here.
  var BOOT_STEP_KEYS = ['click', 'type', 'text', 'press', 'waitFor'];
  // Mouse buttons as src/shared/keybindings.ts spells them for a hotkey: `button` is the code a
  // pointer event reports, `flag` its bit in the event's `buttons` mask, which is what the
  // renderer's matcher reads on pointerdown (src/renderer/utils/keybindings.ts). The bit is not
  // 1 << code: middle is code 1 but bit 4, since bit 2 is the right button.
  // tests/unit/demo-boot-mouse-buttons.test.ts pins this table to the registry.
  var MOUSE_BUTTONS = {
    'Mouse:Middle': { button: 1, flag: 4 },
    'Mouse:Back': { button: 3, flag: 8 },
    'Mouse:Forward': { button: 4, flag: 16 },
  };
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
    if (state.config !== undefined) {
      if (!isPlainObject(state.config)) throw new Error(origin + '.config must be an object');
      // A nested block REPLACES the default rather than merging into it: the merge is a shallow
      // Object.assign here and again in the mock. Naming some of a block's fields therefore leaves
      // the rest undefined, on settings the frame never shows, which is a figure that is quietly
      // wrong rather than one that fails. Refuse it instead, and say which fields are missing.
      var shape = window.__demoConfigShape || {};
      Object.keys(state.config).forEach(function (key) {
        var fields = shape[key];
        var block = state.config[key];
        if (!fields || !isPlainObject(block)) return;
        var missing = fields.filter(function (field) { return !Object.prototype.hasOwnProperty.call(block, field); });
        if (missing.length > 0) {
          throw new Error(origin + '.config.' + key + ' replaces the whole block, so it must name every field; missing: ' + missing.join(', '));
        }
      });
    }
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
        if (!isPlainObject(step)) throw new Error(origin + '.steps entries must be objects');
        var isClick = typeof step.click === 'string';
        var isType = typeof step.type === 'string' && typeof step.text === 'string';
        var isPress = typeof step.press === 'string';
        if (!isClick && !isType && !isPress) throw new Error(origin + '.steps entries need a click selector, a type selector with text, or a press combo');
        Object.keys(step).forEach(function (key) {
          if (BOOT_STEP_KEYS.indexOf(key) === -1) throw new Error(origin + '.steps only support click, type, text, press, and waitFor here; "' + key + '" is a capture-rig step');
        });
      });
    }
  }

  /**
   * Press a hotkey and hold it: a mouse button as one pointerdown, a keyboard combo as one
   * keydown, dispatched where the registry listens (a capture-phase listener on window sees
   * an event dispatched on the document). Nothing releases it, so a push-to-talk stays open
   * for the frame.
   */
  function pressCombo(combo) {
    if (Object.prototype.hasOwnProperty.call(MOUSE_BUTTONS, combo)) {
      var mouse = MOUSE_BUTTONS[combo];
      document.dispatchEvent(new PointerEvent('pointerdown', { button: mouse.button, buttons: mouse.flag, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      return;
    }
    var parts = combo.split('+');
    var key = parts[parts.length - 1];
    var modifiers = parts.slice(0, -1);
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: key.length === 1 ? key.toLowerCase() : key,
      code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
      ctrlKey: modifiers.indexOf('Ctrl') !== -1 || modifiers.indexOf('Control') !== -1 || modifiers.indexOf('Mod') !== -1,
      metaKey: modifiers.indexOf('Meta') !== -1 || modifiers.indexOf('Cmd') !== -1,
      shiftKey: modifiers.indexOf('Shift') !== -1,
      altKey: modifiers.indexOf('Alt') !== -1,
      bubbles: true,
      cancelable: true,
    }));
  }

  /**
   * Type into a field the way a visitor would: the value goes through the element's own setter
   * (React watches the native one, not the instance property) and one input event, so a
   * controlled input takes it. No timing and no per-keystroke drama: a typed query is state.
   */
  function typeInto(target, text) {
    var prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(target, text); else target.value = text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
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

  // The microphone is never requested: dictation's capture (src/renderer/audio/audio-capture.ts)
  // opens the mic with getUserMedia and runs it through the app's own worklet, and here the mic
  // is a silent stream from an audio graph, so the renderer's whole pipeline runs with no
  // permission prompt and nothing heard. The chip then shows its real listening state; the
  // words themselves land in the terminal on release, which is the CLI's echo and cannot be
  // shown here (demo/README.md, Dictation).
  var silentMicrophone = null;
  function silentMicrophoneStream() {
    if (!silentMicrophone) {
      var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      silentMicrophone = new AudioContextCtor().createMediaStreamDestination().stream;
    }
    return Promise.resolve(silentMicrophone);
  }
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = silentMicrophoneStream;

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
  // Which install the seed builds: the sample install, or nothing at all for the welcome screen
  // a first launch lands on. Read by the seed before it installs a row.
  var emptyInstall = !!(scene && scene.install === 'empty');
  window.__demoInstall = emptyInstall ? 'empty' : 'sample';

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
          if (!patch) return;
          if (patch.activity) state.activityCache[sessionId] = patch.activity;
          // A queued or suspended row is what the board draws its queued and paused cards from
          // (SessionDisplayState reads the row's status). It is a patch rather than a dataset
          // row because the sample install has neither on contoso-web, and adding one there
          // would change every docs figure already placed.
          if (patch.status) {
            var row = state.sessions.find(function (session) { return session.id === sessionId; });
            if (!row) throw new Error('Scene patches session "' + sessionId + '", which the sample install does not contain');
            row.status = patch.status;
          }
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

  /**
   * The rect of the element a selector names, as fractions of the frame, so a host can crop a
   * dialog scene to the dialog without knowing the layout. Null when nothing matches or the
   * element is not on screen; a host crops nothing on null. Exposed as `__demoBoot.focusRectOf`
   * for the capture rig, which measures the same rect for each poster (after its gesture, on a
   * driver scene that booted from `state=` and so has no `scene` here).
   */
  function rectOf(selector) {
    var element = document.querySelector(selector);
    if (!element) return null;
    var rect = element.getBoundingClientRect();
    var width = window.innerWidth;
    var height = window.innerHeight;
    if (!width || !height || !rect.width || !rect.height) return null;
    var round = function (value) { return Math.round(value * 10000) / 10000; };
    return { x: round(rect.left / width), y: round(rect.top / height), w: round(rect.width / width), h: round(rect.height / height) };
  }

  /** The rect of the scene's `focus` element, which the ready message carries; null without one. */
  function focusRect() {
    return scene && scene.focus ? rectOf(scene.focus) : null;
  }

  /**
   * Tell a host page that Escape reached this frame and the app had nothing of its own to close,
   * so it can close whatever it is showing the frame in.
   *
   * A host cannot do this itself. The frame is cross-origin, and once keyboard focus is inside it
   * (the renderer's arrival-focus arbiter focuses a mounted terminal, exactly as it does on the
   * desktop) every keystroke goes to the terminal's textarea; only a real click back on the host
   * page moves focus out. Nothing in `demo/` takes that focus and nothing here can decline it:
   * the renderer never branches on being embedded, which is the whole point of the web build.
   *
   * The guard ladder is NOT invented here. `src/renderer/pop-out/PopOutWindowFrame.tsx` already
   * decides "is this Escape mine, or does something in the app own it" for a pop-out window, and
   * this mirrors it so the frame agrees with the app it is showing. Two deliberate differences:
   *
   *  - CAPTURE phase, where the pop-out uses bubble. xterm can consume Escape inside its own key
   *    pipeline (`enableTerminalClipboard`), so a bubble listener would never see the one case
   *    that matters. Capture also means the guards below are read while any overlay about to be
   *    dismissed is still in the DOM, which is the same property the pop-out's comment relies on.
   *    `event.defaultPrevented` is therefore dropped: nothing has run yet, so it is always false.
   *  - The xterm helper textarea is EXEMPTED from the focused-text-field guard. It is a textarea,
   *    so the pop-out's rule would return on it, and it is precisely the case that must post.
   *
   * A task window owns the first Escape, as it does on the desktop: on a scene with one open the
   * visitor presses Escape twice, once to close the window and once to close the host's dialog.
   */
  function isEscapeTheAppOwns(event) {
    var activeElement = document.activeElement;
    var isHelperTextarea = activeElement && activeElement.classList && activeElement.classList.contains('xterm-helper-textarea');
    if (!isHelperTextarea && activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) return true;
    // An open dialog, context menu, or popover owns this Escape.
    if (document.querySelector('[data-dismissable-layer]')) return true;
    // A task-detail or Command Terminal window owns it. Both render through `WindowFrame`, which
    // stamps this id, so one selector covers both layers. NOT the pop-out's "a
    // [data-window-layer-root] with children" test: in the MAIN window that host always holds the
    // overlay wrapper, so a child count is 1 with no window open and the guard would swallow
    // every Escape (measured on the board scene: one child, zero windows).
    if (document.querySelector('[data-testid^="window-frame-"]')) return true;
    // Monaco's find widget, which preventDefaults the keys it handles.
    var target = event.target instanceof HTMLElement ? event.target : null;
    if (target && target.closest('.find-widget')) return true;
    return false;
  }

  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (isEscapeTheAppOwns(event)) return;
    notifyParent({ type: 'kangentic-demo-escape', scene: sceneName });
  }, true);

  function markReady() {
    document.documentElement.setAttribute('data-demo-ready', '1');
    document.documentElement.setAttribute('data-demo-scene', sceneName || 'state');
    notifyParent({ type: 'kangentic-demo-ready', scene: sceneName, version: version, focus: focusRect() });
  }

  function runBootSteps() {
    var root = document.getElementById('root');
    var deadline = Date.now() + BOOT_TIMEOUT_MS;
    var veiled = effective.steps.length > 0;
    if (veiled && root) root.style.visibility = 'hidden';
    // The board is the gate every step waits behind; an empty install never mounts one, so its
    // gate is the app having rendered at all. It must NOT be the scene's own ready element: on an
    // empty-install scene whose steps are what REVEAL that element, the chain would wait for what
    // the first step is there to produce and time out having clicked nothing. Nothing is lost by
    // the weaker gate, because `scene.ready` is awaited after the steps below either way.
    var chain = waitForSelector(emptyInstall ? '#root > *' : '[data-swimlane-name]', deadline);
    effective.steps.forEach(function (step) {
      chain = chain.then(function () {
        if (typeof step.press === 'string') {
          pressCombo(step.press);
          return null;
        }
        // A step's target may mount a beat after the board (a restored window's panel, a lazy
        // chunk), so it is waited for like anything else, against the same deadline.
        var selector = typeof step.type === 'string' ? step.type : step.click;
        return waitForSelector(selector, deadline).then(function (target) {
          if (typeof step.type === 'string') typeInto(target, step.text); else target.click();
        });
      }).then(function () {
        return step.waitFor ? waitForSelector(step.waitFor, deadline) : null;
      });
    });
    // A scene is built when its `ready` element exists, not when the board is up: a restored
    // task window mounts a beat after the swimlanes, and a host that lifts its poster on the
    // ready message must not see the board without the window the caption describes.
    if (scene && scene.ready) {
      chain = chain.then(function () { return waitForSelector(scene.ready, deadline); });
    }
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
    focusRectOf: rectOf,
  };
})();
