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
 * Build the rewriter for one capture.
 *
 * `options.project` is the sample install's project name (contoso-web, spring-petclinic,
 * online-boutique) and `options.cwd` is the scratch directory the agent actually ran in.
 */
function buildSanitizer(options) {
  const home = os.homedir();
  const user = os.userInfo().username;
  const host = os.hostname();
  // The sample install is a Windows machine, as the recording machine and the mock's platform
  // are, so every agent's PowerShell tool calls, backslash paths, and .bat scripts stay
  // consistent with the home directory they print. Only the identity changes: the user is
  // "dev", the home is C:\Users\dev, and the scratch clone becomes the project's real home.
  const demoGroup = options.project === 'contoso-web' ? 'work' : 'oss';
  const demoHome = 'C:\\Users\\dev';
  const demoHomeRelative = `${demoGroup}\\${options.project}`;
  const demoPath = `${demoHome}\\${demoHomeRelative}`;
  const demoTemp = `${demoHome}\\AppData\\Local\\Temp`;
  // Agents print the cwd relative to the home directory too ("~\AppData\Local\Temp\...").
  const homeRelative = path.relative(home, options.cwd);
  const tempRelative = path.relative(home, os.tmpdir());
  // Codex escapes backslashes in its log lines ("cwd=C:\\Users\\...") and elides the middle of
  // the directory in its status box ("~\AppData\Local\...\kng-demo\<project>").
  const doubled = (value) => value.replace(/\\/g, '\\\\');
  const scratchParent = path.basename(path.dirname(options.cwd));
  const replacements = [
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
  ];
  return {
    apply(text) {
      let output = text;
      let collapsed = collapse(text);
      for (const [pattern, to, needle] of patterns) {
        if (!collapsed.includes(needle)) continue;
        const before = output;
        output = output.replace(pattern, () => to);
        if (output !== before) collapsed = collapse(output);
      }
      return output;
    },
    assertClean(text, label) {
      const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      for (const [what, pattern] of leaks) {
        const hit = pattern.exec(plain);
        if (hit) {
          // The surrounding text, so the missing replacement can be named.
          const context = JSON.stringify(plain.slice(Math.max(0, hit.index - 160), hit.index + hit[0].length + 80));
          throw new Error(`[capture] ${label} still contains ${what} after sanitization; refusing to write. Context: ${context}`);
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

module.exports = { buildSanitizer, forwardSlash, sanitizeDeep };
