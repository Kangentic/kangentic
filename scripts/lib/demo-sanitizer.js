/**
 * The sample install's identity rewrite, shared by every writer of a demo recording.
 *
 * The recording machine is somebody's actual computer, so a capture's bytes carry their home
 * directory, user name, and host name. This turns that identity into the sample install's
 * ("dev", C:\Users\dev, the scratch clone at the project's real home) and REFUSES to let a
 * writer proceed when a personal marker survives. tests/unit/demo-fixtures-sanitized.test.ts is
 * the CI backstop for the same property.
 *
 * It lives here rather than inside capture-agent-scrollback.js because two writers need it: the
 * capture script at record time, and scripts/backfill-demo-message-trails.mjs, which adds
 * assistant prose to recordings already on disk. Assistant prose quotes absolute paths routinely,
 * so a backfill that skipped this would reintroduce exactly what the capture script refuses.
 */
const os = require('node:os');
const path = require('node:path');

function forwardSlash(value) {
  return value.replace(/\\/g, '/');
}

/**
 * Claude starts its Remote Control bridge on its own where the account's rollout turns it on, and
 * its footer then links "/rc" to the recording account's own claude.ai session (an OSC 8
 * hyperlink). The link's target goes, and the empty OSC 8 left in its place ends a link without
 * starting one, so the "/rc" text still draws in the same cells and only stops being a link.
 */
const ACCOUNT_SESSION_LINK = /\x1b\]8;[^;\x07\x1b]*;https?:\/\/claude\.ai\/code\/session_[^\x07\x1b]*(\x07|\x1b\\)/g;
const ACCOUNT_SESSION_URL = /claude\.ai\/code\/session_/;

function stripAccountLinks(text) {
  return text.replace(ACCOUNT_SESSION_LINK, (_match, terminator) => `\x1b]8;;${terminator}`);
}

/**
 * An email address other than the placeholder domain. tests/unit/demo-fixtures-sanitized.test.ts
 * scans every committed fixture with this same pattern, so a capture refuses at record time what CI
 * would refuse at the push (an author line `git show` printed, for one).
 */
const FIXTURE_EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Notices a CLI prints about the recording machine's own install or account rather than the
 * session: a launch announcement for a new model, an offer on the account's plan, the hint to
 * install the GitHub CLI, and the notices after an update. None is part of the work a recording
 * shows, and editing one out of a recorded stream would leave the rows around it wrong, so a
 * capture that carries one is made again. Matched with every space and escape removed, because a
 * full-screen CLI repaints a row as cell diffs whose words arrive with cursor moves between them.
 */
const MACHINE_NOTICES = [
  ['a model launch announcement', /Switchwith\/model/i],
  ['an offer on the recording account\'s plan', /Claimthemat|clau\.de\//i],
  ['the hint to install the GitHub CLI', /installghfor/i],
  ['an update notice', /Updateinstalled|Restarttoupdate|Updated:\d+features|changelogfordetails/i],
];

/**
 * What says a recording was made in a WSL distro on Windows, which the sample install's Linux host
 * is not: a Windows drive mounted into the distro, the subsystem's name, its kernel's release
 * string, and the share Windows reaches a distro through.
 */
const WSL_MARKERS = [
  ['a Windows drive mounted into the distro', /\/mnt\/[a-z]\//i],
  ['the name of the Windows Subsystem for Linux', /\bWSL2?\b|microsoft-standard|wsl\.localhost|\\\\wsl\$/],
];

/**
 * Who a recording made in a WSL distro says it ran as: the sample install's Linux host. The
 * distro's user, home and host name are rewritten to these, so they have to match the host the
 * dataset lists and the folder its project names there (tests/unit/demo-sanitizer-deep.test.ts).
 */
const HOST_IDENTITY = Object.freeze({ user: 'dev', host: 'build-box', home: '/home/dev' });

/** Text as a terminal shows it, with every space and escape sequence removed. */
function compactText(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\s+/g, '');
}

/**
 * Build the rewriter for one capture.
 *
 * `options.project` is the sample install's project name (contoso-web, spring-petclinic,
 * online-boutique) and `options.cwd` is the scratch directory the agent actually ran in.
 *
 * A capture in a WSL distro (`options.wsl`) records a project on the sample install's Linux host,
 * so its target is the POSIX folder `options.demoPath` (/home/dev/redis), and the distro's own
 * identity goes: its user becomes "dev", its home /home/dev, and its host name build-box, the
 * host's address in the SSH tab. `options.wsl` carries `user`, `host`, `home` (the distro's
 * $HOME), `homeUnc` (that home as Windows reaches it) and `linuxCwd` (the scratch clone as the
 * distro sees it; `options.cwd` is the same folder as Windows reaches it).
 */
function buildSanitizer(options) {
  const home = os.homedir();
  const user = os.userInfo().username;
  const host = os.hostname();
  const wsl = options.wsl || null;
  if (wsl && !(typeof options.demoPath === 'string' && options.demoPath.startsWith('/'))) {
    throw new Error('[capture] a WSL capture needs the POSIX folder it stands for (demoPath)');
  }
  // The sample install is a Windows machine, as the recording machine and the mock's platform
  // are, so every agent's PowerShell tool calls, backslash paths, and .bat scripts stay
  // consistent with the home directory they print. Only the identity changes: the user is
  // "dev", the home is C:\Users\dev, and the scratch clone becomes the project's real home.
  const demoGroup = options.project === 'contoso-web' ? 'work' : 'oss';
  const demoHome = 'C:\\Users\\dev';
  const demoHomeRelative = `${demoGroup}\\${options.project}`;
  const demoPath = wsl ? options.demoPath : `${demoHome}\\${demoHomeRelative}`;
  const demoTemp = `${demoHome}\\AppData\\Local\\Temp`;
  // Agents print the cwd relative to the home directory too ("~\AppData\Local\Temp\...").
  const homeRelative = path.relative(home, options.cwd);
  const tempRelative = path.relative(home, os.tmpdir());
  // Codex escapes backslashes in its log lines ("cwd=C:\\Users\\...") and elides the middle of
  // the directory in its status box ("~\AppData\Local\...\kng-demo\<project>").
  const doubled = (value) => value.replace(/\\/g, '\\\\');
  const scratchParent = path.basename(path.dirname(options.cwd));
  // The distro's own identity, ahead of the Windows one: a distro takes this computer's host name
  // by default, and on a Linux host that name is build-box, not the Windows install's DEV-PC.
  const posixDemoHome = HOST_IDENTITY.home;
  // The share forms go first: the forward-slash share path holds the distro's own path inside it,
  // which would otherwise be rewritten in place and leave the share's prefix in front of it.
  const distroReplacements = wsl ? [
    [options.cwd, demoPath],
    [forwardSlash(options.cwd), demoPath],
    [wsl.linuxCwd, demoPath],
    [`~/${path.posix.relative(wsl.home, wsl.linuxCwd)}`, `~/${path.posix.relative(posixDemoHome, demoPath)}`],
    [wsl.homeUnc, posixDemoHome],
    [forwardSlash(wsl.homeUnc), posixDemoHome],
    [wsl.home, posixDemoHome],
    [`/home/${wsl.user}`, posixDemoHome],
    [wsl.host, HOST_IDENTITY.host],
    [wsl.user, HOST_IDENTITY.user],
  ] : [];
  const replacements = [
    ...distroReplacements,
    [options.cwd, demoPath],
    [doubled(options.cwd), doubled(demoPath)],
    [forwardSlash(options.cwd), forwardSlash(demoPath)],
    [`~\\${homeRelative}`, `~\\${demoHomeRelative}`],
    [`~/${forwardSlash(homeRelative)}`, `~/${forwardSlash(demoHomeRelative)}`],
    [`~\\AppData\\Local\\\u2026\\${scratchParent}\\${path.basename(options.cwd)}`, `~\\${demoHomeRelative}`],
    [`~/AppData/Local/\u2026/${scratchParent}/${path.basename(options.cwd)}`, `~/${forwardSlash(demoHomeRelative)}`],
    [homeRelative, demoHomeRelative],
    [doubled(homeRelative), doubled(demoHomeRelative)],
    [forwardSlash(homeRelative), forwardSlash(demoHomeRelative)],
    // Some CLIs log to the temp directory itself (Cursor's retrieval trace, for one).
    [os.tmpdir(), demoTemp],
    [doubled(os.tmpdir()), doubled(demoTemp)],
    [forwardSlash(os.tmpdir()), forwardSlash(demoTemp)],
    [`~\\${tempRelative}`, `~\\AppData\\Local\\Temp`],
    [`~/${forwardSlash(tempRelative)}`, '~/AppData/Local/Temp'],
    [home, demoHome],
    [doubled(home), doubled(demoHome)],
    [forwardSlash(home), forwardSlash(demoHome)],
    [`C:\\Users\\${user}`, demoHome],
    [`C:\\\\Users\\\\${user}`, doubled(demoHome)],
    [`C:/Users/${user}`, forwardSlash(demoHome)],
    [`/Users/${user}`, '/Users/dev'],
    [`/home/${user}`, '/home/dev'],
    [host, 'DEV-PC'],
    [user, 'dev'],
  ];
  // A terminal wraps a long path across rows, so the literal can be interrupted by escape
  // sequences, row breaks, and padding. Match each literal with those allowed between its
  // characters, and collapse the whole match to the replacement.
  const GAP = '(?:\\x1b\\[[0-9;?]*[A-Za-z]|\\s)*';
  const tolerant = (literal) => new RegExp(
    literal.split('').map((character) => character.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join(GAP),
    'g',
  );
  // A tolerant pattern can only match where the text, with escape sequences and whitespace
  // removed, contains the literal collapsed the same way. That check is one pass per window;
  // the pattern itself rescans the run of padding after every occurrence of its first
  // character, which on a full-screen repaint is thousands of cells per occurrence, and a long
  // Codex session (a 1.2 MB stream of them) stalled in here for longer than the matrix
  // watchdog allows. So each pattern runs only on a window that can contain its literal.
  const collapse = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\s/g, '');
  const patterns = replacements
    .filter(([from, to]) => from && from.length > 2 && from !== to)
    .map(([from, to]) => [tolerant(from), to, collapse(from)]);
  // What may not survive: any home directory that is not dev's, the scratch root, and the
  // recording machine's own user and host names. Checked on the text with escape sequences
  // removed, so a wrapped path is one string again.
  const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const leaks = [
    ['a home directory other than dev', /C:[\\/]{1,2}Users[\\/]{1,2}(?!dev\b)[A-Za-z0-9._-]+/i],
    ['a home directory other than dev', /\/(?:Users|home)\/(?!dev\b)[A-Za-z0-9._-]+/],
    ['the capture scratch root', /kng-demo/],
    [`the user name "${user}"`, new RegExp(`\\b${escape(user)}\\b`, 'i')],
    [`the host name "${host}"`, new RegExp(`\\b${escape(host)}\\b`, 'i')],
    ['an email address', FIXTURE_EMAIL_PATTERN],
    // A distro name that already is the host's has nothing to leak, and checking for it would
    // refuse every capture, since the rewritten text carries that name.
    ...(wsl && wsl.user.toLowerCase() !== HOST_IDENTITY.user ? [[`the distro's user name "${wsl.user}"`, new RegExp(`\\b${escape(wsl.user)}\\b`, 'i')]] : []),
    ...(wsl && wsl.host.toLowerCase() !== HOST_IDENTITY.host ? [[`the distro's host name "${wsl.host}"`, new RegExp(`\\b${escape(wsl.host)}\\b`, 'i')]] : []),
    ...(wsl ? WSL_MARKERS : []),
  ];
  return {
    apply(text) {
      let output = stripAccountLinks(text);
      let collapsed = collapse(output);
      for (const [pattern, to, needle] of patterns) {
        if (!collapsed.includes(needle)) continue;
        const before = output;
        output = output.replace(pattern, () => to);
        if (output !== before) collapsed = collapse(output);
      }
      return output;
    },
    assertClean(text, label) {
      // Checked before the escape sequences go, since the link lives inside one.
      if (ACCOUNT_SESSION_URL.test(text)) {
        throw new Error(`[capture] ${label} still links the recording account's claude.ai session after sanitization; refusing to write`);
      }
      const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      for (const [what, pattern] of leaks) {
        const hit = pattern.exec(plain);
        if (hit) {
          // The surrounding text, so the missing replacement can be named.
          const context = JSON.stringify(plain.slice(Math.max(0, hit.index - 160), hit.index + hit[0].length + 80));
          throw new Error(`[capture] ${label} still contains ${what} after sanitization; refusing to write. Context: ${context}`);
        }
      }
      const compact = compactText(text);
      for (const [what, pattern] of MACHINE_NOTICES) {
        if (pattern.test(compact)) {
          throw new Error(`[capture] ${label} carries ${what}, a notice about the recording machine's install; record it again without it`);
        }
      }
    },
  };
}

/**
 * The rewrite applied to every string inside a JSON value, keys included, returning a rewritten
 * copy. A transcript carries the identity in more places than a terminal does (tool inputs,
 * tool results, the file paths the agent quotes), so it is walked whole rather than field by
 * field, and the writer then runs assertClean over the serialized result.
 */
function sanitizeDeep(value, sanitizer) {
  if (typeof value === 'string') return sanitizer.apply(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, sanitizer));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[sanitizer.apply(key)] = sanitizeDeep(item, sanitizer);
    return output;
  }
  return value;
}

module.exports = { buildSanitizer, forwardSlash, sanitizeDeep, stripAccountLinks, FIXTURE_EMAIL_PATTERN, HOST_IDENTITY, MACHINE_NOTICES, WSL_MARKERS };
