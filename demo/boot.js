/**
 * Boot script for the web build of the desktop renderer.
 *
 * Runs as a classic script BEFORE tests/ui/mock-electron-api.js, so it owns everything the mock
 * reads at load time (window.__mockConfigOverrides) and everything the demo adds around the
 * renderer: the URL contract, the theme class, the still and embed styles, the scene applier
 * the seed script calls back into, and the boot-step runner that reveals the frame. On a frame
 * whose scene names a scene-only row it also writes that row's script in right after itself,
 * so the row's recorded sessions are on the page before the seed runs. It also keeps a visitor's
 * browser extensions out of the frame: each vendor's opt-out on every text field, and a sweep that
 * hides what an extension injects anyway (Browser extensions, below). That is why its very first
 * statements record every element the page creates.
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
 *                    replays it, and a scene's choreography plays by itself (demo/choreography.ts),
 *                    so a frame left running keeps moving. Off by default: a hero or a docs figure
 *                    must not reset state under a visitor who has taken control.
 *   fs=<px>          root font size for the UI (8..32) and the terminal font size
 *
 * A scene the registry does not know or a malformed state= blob renders a full-frame error card
 * and boots nothing: a page must never caption a scene the visitor is not looking at. The parent
 * frame is told either way (kangentic-demo-ready / kangentic-demo-error). Ready fires only once
 * the scene's `ready` element exists, and carries the rect around its `focus` elements (fractions
 * of the frame) so a host can crop a dialog scene to the dialog.
 */
(function () {
  'use strict';

  // Every element the page's own code creates goes through these two calls, so the set names what
  // the page made. A browser extension's content script runs in an isolated world with its own
  // prototypes, so its calls never pass through here, and that difference is what the extension
  // shield below reads (Browser extensions, further down). Installed before anything else on the
  // page builds an element.
  var pageCreated = new WeakSet();
  var nativeCreateElement = Document.prototype.createElement;
  var nativeCreateElementNS = Document.prototype.createElementNS;
  Document.prototype.createElement = function () {
    var element = nativeCreateElement.apply(this, arguments);
    pageCreated.add(element);
    return element;
  };
  Document.prototype.createElementNS = function () {
    var element = nativeCreateElementNS.apply(this, arguments);
    pageCreated.add(element);
    return element;
  };

  // Hand-maintained mirror of ThemeMode in src/shared/types.ts. Nothing ties the two
  // together, so a theme added there has to be added here or ?theme=<id> is refused.
  var APP_THEMES = ['dark', 'light', 'rust', 'clay',
    'moon', 'forest', 'ocean', 'ember', 'sand', 'mint', 'sky', 'peach'];
  // The site embeds this frame by URL, so a spelling it may already have written keeps
  // resolving rather than hitting the error card. The product pair shipped briefly as
  // kangentic-light / kangentic-dark before being named clay / rust.
  var THEME_ALIASES = { night: 'dark', kangentic: 'clay', 'kangentic-light': 'clay', 'kangentic-dark': 'rust' };
  // The same contract for a scene the site embeds by an earlier name. The Knowledge Graph
  // tab's scene was settings-memory until the tab id became knowledgeGraph.
  var SCENE_ALIASES = { 'settings-memory': 'settings-knowledgeGraph' };
  var STATE_KEYS = ['config', 'tasks', 'sessions', 'seeds', 'steps', 'rows'];
  // What a patch may say about a session the sample install seeds, and the values each takes. The
  // seed folds a patch in before it derives anything from the session, so the row, the Monitor,
  // the usage, and the clock all describe the same state (tests/captures/helpers/demo-dataset.ts).
  // `resuming` is the moment after a relaunch: main has respawned the agent on its own
  // conversation and it has not printed yet, which only a running session can be.
  var SESSION_PATCH_KEYS = ['activity', 'status', 'resuming'];
  var SESSION_ACTIVITIES = ['thinking', 'idle', 'permission'];
  var SESSION_STATUSES = ['running', 'suspended', 'queued'];
  // A boot step clicks, types into a field, or presses a hotkey (a keyboard combo or a mouse
  // button, in the registry's own spelling, held for the frame); anything else (a hover, a
  // drag, a right-click) is a pointer gesture, which only a scene's choreography carries.
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

  /** Reject a session patch the seed would misread: an unknown field, a value outside its set, or a resume on a stopped session. */
  function validateSessionPatch(patch, origin) {
    if (!isPlainObject(patch)) throw new Error(origin + ' must be an object');
    Object.keys(patch).forEach(function (key) {
      if (SESSION_PATCH_KEYS.indexOf(key) === -1) throw new Error(origin + ' has an unknown key "' + key + '" (allowed: ' + SESSION_PATCH_KEYS.join(', ') + ')');
    });
    if (patch.activity !== undefined && SESSION_ACTIVITIES.indexOf(patch.activity) === -1) throw new Error(origin + '.activity must be one of ' + SESSION_ACTIVITIES.join(', '));
    if (patch.status !== undefined && SESSION_STATUSES.indexOf(patch.status) === -1) throw new Error(origin + '.status must be one of ' + SESSION_STATUSES.join(', '));
    if (patch.resuming !== undefined && patch.resuming !== true) throw new Error(origin + '.resuming can only be true');
    if (patch.resuming && patch.status !== undefined && patch.status !== 'running') throw new Error(origin + ' resumes a session it also stops; a resuming session is running');
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
    if (state.sessions !== undefined) {
      if (!isPlainObject(state.sessions)) throw new Error(origin + '.sessions must be an object keyed by session id');
      Object.keys(state.sessions).forEach(function (sessionId) {
        validateSessionPatch(state.sessions[sessionId], origin + '.sessions.' + sessionId);
      });
    }
    if (state.rows !== undefined) {
      if (!Array.isArray(state.rows)) throw new Error(origin + '.rows must be an array of task ids');
      // The build emits the scene-only task ids it carries; any other id would add nothing.
      var sceneRowIds = window.__demoSceneRowIds || [];
      state.rows.forEach(function (taskId) {
        if (typeof taskId !== 'string' || sceneRowIds.indexOf(taskId) === -1) {
          throw new Error(origin + '.rows names "' + taskId + '", which is not a scene-only task (' + (sceneRowIds.join(', ') || 'none') + ')');
        }
      });
    }
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
          if (BOOT_STEP_KEYS.indexOf(key) === -1) throw new Error(origin + '.steps only support click, type, text, press, and waitFor here; "' + key + '" is not a boot step (a pointer gesture is a scene\'s choreography)');
        });
      });
    }
  }

  /**
   * Press a hotkey and hold it: a mouse button as one pointerdown, a keyboard combo as one
   * keydown, dispatched where the registry listens (a capture-phase listener on window sees
   * an event dispatched on the document). Nothing releases it, so a push-to-talk stays open
   * for the frame. Exposed as `__demoBoot.pressCombo` so a test can press a mouse hotkey the way a
   * boot step does, since Playwright's mouse has no back or forward button.
   * A mouse combo this table cannot press (a chord, a misspelled button) throws rather than
   * going out as a keydown nothing listens for, so the step fails with the combo's name.
   */
  function pressCombo(combo) {
    if (Object.prototype.hasOwnProperty.call(MOUSE_BUTTONS, combo)) {
      var mouse = MOUSE_BUTTONS[combo];
      document.dispatchEvent(new PointerEvent('pointerdown', { button: mouse.button, buttons: mouse.flag, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      return;
    }
    if (combo.indexOf('Mouse:') === 0) {
      throw new Error('Cannot press "' + combo + '": a mouse hotkey here is one of ' + Object.keys(MOUSE_BUTTONS).join(', '));
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
   * Let go of a mouse hotkey `pressCombo` held: one pointerup with the button's code and no buttons
   * left down, which is what the registry's release matcher reads. A choreography releases
   * push-to-talk this way and presses it again. Only a listed mouse button can be released.
   */
  function releaseCombo(combo) {
    if (!Object.prototype.hasOwnProperty.call(MOUSE_BUTTONS, combo)) {
      throw new Error('Cannot release "' + combo + '": only a held mouse hotkey is released, one of ' + Object.keys(MOUSE_BUTTONS).join(', '));
    }
    document.dispatchEvent(new PointerEvent('pointerup', { button: MOUSE_BUTTONS[combo].button, buttons: 0, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
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

  /**
   * Click the way a visitor would. A pointer click on a text field puts the caret in it, and
   * `element.click()` alone does not, so a text field is focused first. Dictation reads its target
   * from that focus. Only a field is focused this way. A button a pointer clicks takes focus too,
   * but focusing one from a script can paint a focus ring no visitor's click would. The selector
   * is the renderer's own test for a typing surface (`focusIsInTypingSurface`), minus `select`,
   * which a click opens.
   *
   * The boot veil hides the app with `visibility: hidden`, and Chromium will not focus anything
   * under a hidden ancestor, so a field click swaps the veil for opacity in the same task (nothing
   * paints in between) before it focuses. The swap happens only here, because under the opacity
   * veil an arriving terminal could take focus too, and every other scene keeps the veil it was
   * shot under. Once a field holds focus, a terminal that arrives later is refused it (arrival
   * focus reads it as occupied).
   *
   * The focus never scrolls: a focus scrolls its element into view through every box above it, and
   * in an embedded frame that carries on into the page embedding it.
   */
  function clickTarget(target) {
    if (target.matches('input, textarea, [contenteditable="true"]')) {
      var root = document.getElementById('root');
      if (root && root.style.visibility === 'hidden') {
        root.style.visibility = '';
        root.style.opacity = '0';
        root.style.pointerEvents = 'none';
      }
      target.focus({ preventScroll: true });
    }
    target.click();
  }

  /** Lift the boot veil, in whichever of its two forms the steps left it. */
  function unveil(root) {
    root.style.visibility = '';
    root.style.opacity = '';
    root.style.pointerEvents = '';
  }

  /**
   * Later sources win per key; arrays concatenate, except `rows`, which keeps each task id once
   * because the seed would add a row named twice twice; nested config objects are replaced whole.
   */
  function mergeStates(sources) {
    var merged = { config: {}, tasks: [], sessions: {}, seeds: {}, steps: [], rows: [] };
    sources.forEach(function (source) {
      if (!source) return;
      Object.assign(merged.config, source.config || {});
      (source.rows || []).forEach(function (taskId) {
        if (merged.rows.indexOf(taskId) === -1) merged.rows.push(taskId);
      });
      merged.tasks = merged.tasks.concat(source.tasks || []);
      Object.assign(merged.sessions, source.sessions || {});
      Object.assign(merged.seeds, source.seeds || {});
      merged.steps = merged.steps.concat(source.steps || []);
    });
    return merged;
  }

  // ---------------------------------------------------------------- resolve the URL
  var sceneName = params.get('view');
  if (sceneName !== null && SCENE_ALIASES[sceneName]) sceneName = SCENE_ALIASES[sceneName];
  if (sceneName === null && !params.has('state')) sceneName = 'board';
  var scene = null;
  if (sceneName !== null) {
    scene = scenes[sceneName] || null;
    if (!scene) errors.push('Unknown scene "' + sceneName + '". Scenes that boot here: ' + Object.keys(scenes).join(', ') + '.');
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

  // ---------------------------------------------------------------- scene-only rows' recordings
  // A scene-only row's recorded sessions (their frames, diff, peeks and trail) are not in the seed,
  // since only a frame that names the row shows them. Each row's script is written here, while the
  // parser is still in <head>, which makes it parser-inserted: it runs right after this script and
  // before the mock and the seed, so the seed folds the row in with its sessions already on the
  // page. A fetch, or a script added with createElement, would land after the renderer's deferred
  // modules had read the bridge. The build emits each row's URL (window.__demoSceneRowScripts). A
  // row with no URL writes nothing, and applyScene refuses it by name with a row that did not load.
  if (errors.length === 0) {
    var sceneRowScripts = window.__demoSceneRowScripts || {};
    effective.rows.forEach(function (taskId) {
      var scriptUrl = sceneRowScripts[taskId];
      if (typeof scriptUrl === 'string') document.write('<script src="' + scriptUrl + '"></script>');
    });
  }

  // ---------------------------------------------------------------- a recorded Send's rest frame
  // A session the matrix also recorded receiving a note from the Browser pane rests, when the scene
  // shows it finished, on the frame just before that note went in (demo-dataset.ts, sendRests). Only
  // such a frame needs it, so it ships as its own script, written here for the reason a row's is.
  var sendFrameSessions = [];
  if (errors.length === 0) {
    var sendFrameScripts = window.__demoSendFrameScripts || {};
    Object.keys(effective.sessions).forEach(function (sessionId) {
      var scriptUrl = sendFrameScripts[sessionId];
      if (effective.sessions[sessionId].activity !== 'idle' || typeof scriptUrl !== 'string') return;
      sendFrameSessions.push(sessionId);
      document.write('<script src="' + scriptUrl + '"></script>');
    });
  }

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

  // ---------------------------------------------------------------- browser extensions
  // A visitor's extensions run inside this frame whatever the page says: no web API turns them
  // off, and a content script ignores the CSP. So the frame does two things, here and never in
  // src/renderer, since Electron runs no extensions (demo/README.md, Browser extensions).
  //
  // First, every text field carries each vendor's own opt-out from the moment it mounts, before
  // anything focuses it. Each attribute is the one its vendor documents for a site owner:
  //   Grammarly: data-gramm, data-gramm_editor and data-enable-grammarly set to "false" (Grammarly
  //     support article 115000090392; the Telerik and CodeMirror integrations set all three, since
  //     the name has changed over time).
  //   LanguageTool: data-lt-active="false", the name its developers moved to from data-lt.
  //   1Password: data-1p-ignore, no value (1Password's developer guide, compatible website design).
  //   Bitwarden: data-bwignore (Bitwarden's announcement to web developers).
  //   Dashlane: data-form-type="other", the "not a form field it fills" label (Dashlane support).
  // LastPass is left out: no LastPass page names an attribute, and the sweep below covers its icon.
  //
  // Second, a sweep hides what an extension adds and no opt-out covers, including an extension
  // nobody has tested. A content script leaves two marks. Its world has no custom element registry,
  // so the hyphenated host element it adds (grammarly-extension, LanguageTool's lt-*) is a tag the
  // page never defined. And it does not create through the page's prototypes, so an element it
  // appends under <html> or <body> is not in `pageCreated`. A marked element is stamped
  // data-demo-foreign and hidden by a rule, never removed: an extension that sees its node go tends
  // to add it again. Signal two starts at DOMContentLoaded, when the parser's own children (#root,
  // the scripts) are adopted as the page's.
  //
  // Not covered: an extension that runs its script in the page's own world (MV3 `world: 'MAIN'`)
  // passes both signals, and only its own opt-out keeps it out. Neither is stage.html shielded: it
  // holds no field and runs none of this.
  var FIELD_OPT_OUTS = [
    ['data-gramm', 'false'],
    ['data-gramm_editor', 'false'],
    ['data-enable-grammarly', 'false'],
    ['data-lt-active', 'false'],
    ['data-1p-ignore', ''],
    ['data-bwignore', 'true'],
    ['data-form-type', 'other'],
  ];
  var TEXT_FIELD_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
  var FOREIGN_ATTRIBUTE = 'data-demo-foreign';
  var HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

  /**
   * Install the opt-outs and the sweep on a document: this frame's, and the Browser pane's guest
   * page, which is a document of its own that extensions inject into too (demo/webview-shim.js).
   * Returns a function that starts signal two, whose caller decides when the document's own
   * top-level children are all in place.
   */
  function shieldDocument(shieldedDocument) {
    var view = shieldedDocument.defaultView || window;
    var watchingTopLevel = false;
    shieldedDocument.documentElement.setAttribute('translate', 'no');
    var style = shieldedDocument.createElement('style');
    // The guest's prototypes are another realm's, so its elements never pass through the wrapper.
    pageCreated.add(style);
    style.setAttribute('data-demo-style', '');
    style.textContent = '[' + FOREIGN_ATTRIBUTE + '] { display: none !important; }';
    (shieldedDocument.head || shieldedDocument.documentElement).appendChild(style);

    function stampField(element) {
      for (var index = 0; index < FIELD_OPT_OUTS.length; index++) {
        if (element.getAttribute(FIELD_OPT_OUTS[index][0]) !== FIELD_OPT_OUTS[index][1]) {
          element.setAttribute(FIELD_OPT_OUTS[index][0], FIELD_OPT_OUTS[index][1]);
        }
      }
    }

    /** An HTML element whose tag the page never defined; SVG and MathML keep their own hyphenated names. */
    function isUndefinedCustomTag(element) {
      if (element.namespaceURI !== HTML_NAMESPACE || element.localName.indexOf('-') === -1) return false;
      if (pageCreated.has(element)) return false;
      return !(view.customElements && view.customElements.get(element.localName));
    }

    function isForeignTopLevel(element) {
      if (!watchingTopLevel || pageCreated.has(element)) return false;
      return element.parentNode === shieldedDocument.body || element.parentNode === shieldedDocument.documentElement;
    }

    function hide(element) {
      if (!element.hasAttribute(FOREIGN_ATTRIBUTE)) element.setAttribute(FOREIGN_ATTRIBUTE, '');
    }

    /** One element and everything under it: hide what is foreign, stamp the fields that are not. */
    function visit(element) {
      if (isUndefinedCustomTag(element) || isForeignTopLevel(element)) {
        hide(element);
        return;
      }
      if (element.matches(TEXT_FIELD_SELECTOR)) stampField(element);
      var descendants = element.getElementsByTagName('*');
      for (var index = 0; index < descendants.length; index++) {
        var descendant = descendants[index];
        if (isUndefinedCustomTag(descendant)) hide(descendant);
        else if (descendant.matches(TEXT_FIELD_SELECTOR)) stampField(descendant);
      }
    }

    function handle(records) {
      for (var index = 0; index < records.length; index++) {
        var record = records[index];
        if (record.type === 'attributes') {
          if (record.target.nodeType === 1 && record.target.matches(TEXT_FIELD_SELECTOR)) stampField(record.target);
          continue;
        }
        for (var nodeIndex = 0; nodeIndex < record.addedNodes.length; nodeIndex++) {
          var node = record.addedNodes[nodeIndex];
          if (node.nodeType === 1 && node.isConnected) visit(node);
        }
      }
    }

    var observer = new MutationObserver(handle);
    observer.observe(shieldedDocument.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable'] });
    // A content script that runs at document_start can add its node before this script does.
    visit(shieldedDocument.documentElement);
    // React's autoFocus focuses a field in the same task that inserts it, before the observer's
    // microtask; an extension attaches on focus. A window capture listener runs ahead of any
    // listener on the document or the field, so the field carries its opt-outs by then.
    view.addEventListener('focusin', function (event) {
      var target = event.target;
      if (target && target.nodeType === 1 && target.matches(TEXT_FIELD_SELECTOR)) stampField(target);
    }, true);

    return function startTopLevelSweep() {
      // Anything the parser placed is the page's own. Records still queued were made by it too.
      handle(observer.takeRecords());
      [shieldedDocument.documentElement, shieldedDocument.body].forEach(function (parent) {
        if (!parent) return;
        for (var index = 0; index < parent.children.length; index++) pageCreated.add(parent.children[index]);
      });
      watchingTopLevel = true;
    };
  }

  var startTopLevelSweep = shieldDocument(document);
  document.addEventListener('DOMContentLoaded', function () { startTopLevelSweep(); }, { once: true });

  /** The Browser pane's guest page: no script of its own runs there, so its children are all in place once it loads. */
  function shieldGuestDocument(guestDocument) {
    if (!guestDocument || !guestDocument.documentElement) return;
    shieldDocument(guestDocument)();
  }

  // The microphone is never requested: dictation's capture (src/renderer/audio/audio-capture.ts)
  // opens the mic with getUserMedia and runs it through the app's own worklet, and here the mic
  // is a silent stream from an audio graph, so the renderer's whole pipeline runs with no
  // permission prompt. The chip then shows its real listening state. What the engine "hears" is
  // a recorded utterance the seed replays from the press, typed into a focused text field as it
  // streams; in a terminal the words are the CLI's echo of what main typed, which cannot be shown
  // here (demo/README.md, Dictation).
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
    // unmount on animationend, which fires at 0s on nearly every close and never at none.
    // useOverlayPhase's fallback timer covers the few it drops, but at none every close would
    // wait on it. The activity marks are infinite loops with no listener, so those can stop
    // outright.
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
    // A Web Animation is not a CSS animation, so the zeroed durations above do not reach it.
    // A timed toast's countdown line is one, and it would otherwise be drawn wherever its clock
    // had got to when the frame was shot. A still holds that line where it starts, so it is
    // empty in every capture. Only that line: dnd-kit's drop animation is a Web Animation too,
    // and a drag overlay unmounts only once it finishes, so holding every animation left a
    // still's held card on screen after a visitor's click let go of the pose.
    var nativeAnimate = Element.prototype.animate;
    if (typeof nativeAnimate === 'function') {
      Element.prototype.animate = function () {
        var animation = nativeAnimate.apply(this, arguments);
        if (typeof this.closest === 'function' && this.closest('[data-testid="toast-countdown"]')) {
          animation.pause();
          animation.play = function () {};
        }
        return animation;
      };
    }
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
    // A row whose script did not load (a 404, a blocked request, no URL in the build) leaves the
    // seed nothing to fold in, so the frame refuses to boot rather than show the scene without its
    // card.
    var sceneRowData = window.__demoSceneRowData || {};
    var unloadedRows = effective.rows.filter(function (taskId) { return !sceneRowData[taskId]; });
    if (unloadedRows.length > 0) {
      errors.push('The recorded sessions of the scene-only task "' + unloadedRows.join('", "') + '" did not load.');
      return;
    }
    // The same for a recorded Send's rest frame: without it the session would rest on another
    // picture than the one its Send plays on from.
    var sendFrames = window.__demoSendFrames || {};
    var unloadedFrames = sendFrameSessions.filter(function (sessionId) { return typeof sendFrames[sessionId] !== 'string'; });
    if (unloadedFrames.length > 0) {
      errors.push('The frame the session "' + unloadedFrames.join('", "') + '" rests on before its recorded Send did not load.');
      return;
    }
    // Session patches are the SEED's input, not a pass over its output: the seed derives the
    // Monitor rows, the usage, the activity stats, and each working session's clock from the
    // session as it builds it, so a patch applied to the rows afterwards left all of those
    // describing the unpatched session (a paused card whose Monitor row still read working).
    // A queued, paused, or resuming card is a patch rather than a dataset row because adding one
    // to the sample install would change every docs figure already placed.
    window.__demoSessionPatches = effective.sessions;
    // Scene-only rows join the install the same way, as the seed's input: a card and its session
    // the sample install leaves out, because adding them would change every figure already placed.
    window.__demoSceneRows = effective.rows;
    // What main does on a session's replay clock (the scene's `timeline`), which the seed schedules
    // beside that session's peeks and trail. Published before the seed runs, which starts the
    // clocks; a scene's seeds land after it. A state= blob carries none.
    window.__demoSceneTimeline = (scene && scene.timeline) || [];
    if (typeof window.__demoApplyFixture === 'function') window.__demoApplyFixture();

    if (effective.tasks.length > 0 || Object.keys(effective.sessions).length > 0) {
      window.__mockPreConfigure(function (state) {
        effective.tasks.forEach(function (patch) {
          var row = state.tasks.find(function (task) { return task.id === patch.id; })
            || state.archivedTasks.find(function (task) { return task.id === patch.id; });
          if (!row) throw new Error('Scene patches task "' + patch.id + '", which the sample install does not contain');
          Object.assign(row, patch);
        });
        // The seed applied these; an id it does not seed would otherwise be a silent no-op.
        Object.keys(effective.sessions).forEach(function (sessionId) {
          var row = state.sessions.find(function (session) { return session.id === sessionId; });
          if (!row) throw new Error('Scene patches session "' + sessionId + '", which the sample install does not contain');
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
   * The rect of the elements a selector names, as fractions of the frame, so a host can crop a
   * dialog scene to the dialog without knowing the layout. A selector list (`a, b`) names several,
   * and the rect is the box around all of them: two cards a figure is about, say. Elements with no
   * size are left out. Null when nothing on screen matches; a host crops nothing on null. Exposed
   * as `__demoBoot.focusRectOf` for the capture rig, which measures the same rect for each poster
   * on the still it just shot.
   */
  function rectOf(selector) {
    var width = window.innerWidth;
    var height = window.innerHeight;
    if (!width || !height) return null;
    var left = Infinity;
    var top = Infinity;
    var right = -Infinity;
    var bottom = -Infinity;
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (element) {
      var rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    });
    if (left === Infinity) return null;
    var round = function (value) { return Math.round(value * 10000) / 10000; };
    return { x: round(left / width), y: round(top / height), w: round((right - left) / width), h: round((bottom - top) / height) };
  }

  /** The rect around the scene's `focus` elements, which the ready message carries; null without one. */
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
   * A window owns the first Escape, as it does on the desktop: on a scene with one open the
   * visitor presses Escape twice, once to close the window and once to close the host's dialog.
   * An open window frame is not always a window that will act on the key, though. Each case below
   * is handled here rather than in the renderer:
   *
   *  - A task window's terminal keeps Escape for the agent while the POINTER is over it
   *    (`releaseEscapeWhenPointerOutside` in `terminal-clipboard.ts`), so the window never sees
   *    the key. A card click leaves the pointer exactly there once the window opens. Here the
   *    terminal replays a recording with no agent to interrupt, so the key would do nothing and
   *    the visitor could not leave. `closeHoveredTerminalWindow` does what the desktop does with
   *    the pointer outside: the terminal never gets the key, and the window closes through its
   *    own guarded close.
   *  - Any OTHER terminal (the bottom panel's, a Command Terminal's) keeps Escape outright. xterm
   *    stops propagation of every key it handles (`cancel(event, true)` at the end of its
   *    `_keyDown`), so the document listener a window closes on never sees it. Measured with a
   *    task window open and the panel's terminal focused, 0 of 3 presses reached `document`. No
   *    frame is claimed for that key, so it is posted and the window stays open, as on the
   *    desktop. A visitor gets there by clicking the panel's terminal, which light dismiss
   *    deliberately does not treat as a click outside the window.
   *  - A Command Terminal renders through `WindowFrame` too, but its layer hides on the
   *    panel-close combo, the toggle, or a backdrop click, never on Escape. Its frame is never
   *    claimed.
   *  - A task window closed with a live Browser guest is PARKED, and one kept for a backgrounded
   *    project is RETAINED. Both stay mounted at zero opacity so the guest survives, and
   *    `WindowFrame` marks them `inert`. Neither has anything left to close, so neither is claimed.
   */
  function isEscapeTheAppOwns(event) {
    var activeElement = document.activeElement;
    var isHelperTextarea = isTerminalTextarea(activeElement);
    if (!isHelperTextarea && activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) return true;
    if (isOverlayOpen()) return true;
    // A window that closes on Escape owns it: a task-detail or conversation window, both of which
    // render through `WindowFrame`, which stamps this id. The comment above says why a terminal
    // outside a task window, an inert frame, and a Command Terminal frame are no sign of that. NOT
    // the pop-out's "a [data-window-layer-root] with children" test: in the MAIN window that host
    // always holds the overlay wrapper, so a child count is 1 with no window open and the guard
    // would swallow every Escape (measured on the board scene: one child, zero windows).
    var terminalKeepsKey = isHelperTextarea && !taskWindowOf(activeElement);
    if (!terminalKeepsKey) {
      var frames = document.querySelectorAll('[data-testid^="window-frame-"]');
      for (var index = 0; index < frames.length; index++) {
        if (frames[index].hasAttribute('inert')) continue;
        if (frames[index].querySelector('[data-testid="command-terminal-window"]')) continue;
        return true;
      }
    }
    // Monaco's find widget, which preventDefaults the keys it handles.
    var target = event.target instanceof HTMLElement ? event.target : null;
    if (target && target.closest('.find-widget')) return true;
    return false;
  }

  /** Whether an element is xterm's helper textarea, where every keystroke into a terminal lands. */
  function isTerminalTextarea(element) {
    return !!(element && element.classList && element.classList.contains('xterm-helper-textarea'));
  }

  /**
   * Whether an open dialog, context menu, popover, or tooltip is in the DOM. One owns any Escape
   * before a window does, so both paths below ask this one question rather than each keeping a
   * copy. An open Tooltip closes on the first Escape, through a window capture listener added
   * after this one, so it is checked here by its own marker: it deliberately carries no
   * `data-dismissable-layer`.
   */
  function isOverlayOpen() {
    return !!document.querySelector('[data-dismissable-layer], [data-tooltip]');
  }

  /** The task window frame an element sits in, told apart by its X; null outside one. */
  function taskWindowOf(element) {
    var frame = element.closest('[data-testid^="window-frame-"]');
    return frame && frame.querySelector('[data-testid="task-detail-close"]') ? frame : null;
  }

  /**
   * Close the task window whose terminal is focused AND under the pointer, the one case where the
   * renderer keeps Escape from the window. Returns true when it closed one and consumed the key.
   *
   * Every condition is load-bearing. The hover test is the terminal's own (`el.matches(':hover')`
   * on the element passed to `terminal.open()`, the `.xterm` element's parent), so with the
   * pointer anywhere else this steps aside and the desktop path closes the window unaided. That
   * also keeps it clear of `useWindowDrag`'s Esc-cancels-drag, a later capture listener on this
   * same `window`: during a title-bar drag the terminal is not hovered. An open overlay still owns
   * the key first. The close is the frame's own X, which calls the same guarded close Escape does.
   */
  function closeHoveredTerminalWindow(event) {
    var activeElement = document.activeElement;
    if (!isTerminalTextarea(activeElement)) return false;
    if (isOverlayOpen()) return false;
    var xtermElement = activeElement.closest('.xterm');
    var terminalHost = xtermElement && xtermElement.parentElement;
    if (!terminalHost || !terminalHost.matches(':hover')) return false;
    var taskWindow = taskWindowOf(activeElement);
    if (!taskWindow) return false;
    var closeButton = taskWindow.querySelector('[data-testid="task-detail-close"]');
    // The replay must not receive the key, exactly as the agent does not with the pointer outside.
    event.preventDefault();
    event.stopImmediatePropagation();
    closeButton.click();
    return true;
  }

  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    // A key a script dispatched (a choreography's, or a boot step's press) is the app's to act on,
    // never the host's: only a visitor's own Escape may close the dialog the frame sits in.
    if (!event.isTrusted) return;
    if (closeHoveredTerminalWindow(event)) return;
    if (isEscapeTheAppOwns(event)) return;
    notifyParent({ type: 'kangentic-demo-escape', scene: sceneName });
  }, true);

  function markReady() {
    document.documentElement.setAttribute('data-demo-ready', '1');
    document.documentElement.setAttribute('data-demo-scene', sceneName || 'state');
    notifyParent({ type: 'kangentic-demo-ready', scene: sceneName, version: version, focus: focusRect() });
  }

  // ---------------------------------------------------------------- choreography
  // A scene's pointer steps (its `choreography`), played by demo/choreography.ts, a chunk this
  // script loads only when the frame plays them: a still with a pose plays up to it before the
  // reveal, and a live frame under loop=1 cycles after it. Every other frame fetches nothing.
  var choreography = scene && Array.isArray(scene.choreography) && scene.choreography.length > 0 ? scene.choreography : null;
  var choreographyHasPose = !!choreography && choreography.some(function (step) { return step.pose === true; });
  var choreographyPlayer = null;
  // The input that is a visitor taking over, as demo/choreography.ts's watchForVisitor reads it.
  var VISITOR_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  function loadChoreography() {
    if (choreographyPlayer) return Promise.resolve(choreographyPlayer);
    if (typeof window.__demoLoadChoreography !== 'function') {
      return Promise.reject(new Error('this build carries no choreography player (demo/choreography-entry.ts)'));
    }
    return window.__demoLoadChoreography().then(function (module) {
      choreographyPlayer = module.createChoreography(choreography, {
        still: still,
        focus: scene.focus || null,
        // A timeline moves cards on a session's clock, which no cycle of the pointer undoes.
        compareLanes: !(scene.timeline && scene.timeline.length > 0),
      });
      return choreographyPlayer;
    });
  }

  function runBootSteps() {
    var root = document.getElementById('root');
    var deadline = Date.now() + BOOT_TIMEOUT_MS;
    var veiled = effective.steps.length > 0 || choreographyHasPose;
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
          if (typeof step.type === 'string') typeInto(target, step.text); else clickTarget(target);
        });
      }).then(function () {
        return step.waitFor ? waitForSelector(step.waitFor, deadline) : null;
      });
    });
    // The pose: the gesture a still shows in flight (a card held over a column, a menu open). The
    // pointer is hit-tested like a mouse, and `visibility: hidden` takes the app out of hit
    // testing, as `pointer-events: none` would, so the pose plays under the opacity veil alone.
    if (choreographyHasPose) {
      chain = chain.then(function () {
        if (root) {
          root.style.visibility = '';
          root.style.opacity = '0';
          root.style.pointerEvents = '';
        }
        return loadChoreography().then(function (player) { return player.playToPose(); });
      });
    }
    // A scene is built when its `ready` element exists, not when the board is up: a restored
    // task window mounts a beat after the swimlanes, and a host that lifts its poster on the
    // ready message must not see the board without the window the caption describes.
    if (scene && scene.ready) {
      chain = chain.then(function () { return waitForSelector(scene.ready, deadline); });
    }
    chain.then(function () {
      if (veiled && root) unveil(root);
      markReady();
      if (choreography && loop && !still) {
        // A visitor's own input stops the loop, and the player that listens for it may still be
        // loading. Input that lands before it does is noted here and ends the loop before it starts.
        var visitorTookOver = false;
        var noteVisitor = function (event) { if (event.isTrusted) visitorTookOver = true; };
        VISITOR_EVENTS.forEach(function (type) { window.addEventListener(type, noteVisitor, { capture: true, passive: true }); });
        var stopNoting = function () {
          VISITOR_EVENTS.forEach(function (type) { window.removeEventListener(type, noteVisitor, { capture: true }); });
        };
        loadChoreography().then(function (player) {
          stopNoting();
          if (visitorTookOver) player.stop(); else player.startLoop();
        }, function (error) {
          stopNoting();
          console.error('[kangentic-demo] the choreography did not load:', error && error.message ? error.message : String(error));
        });
      }
    }).catch(function (error) {
      if (veiled && root) unveil(root);
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
    pressCombo: pressCombo,
    releaseCombo: releaseCombo,
    shieldGuestDocument: shieldGuestDocument,
  };
})();
