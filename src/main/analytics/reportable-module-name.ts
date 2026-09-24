/**
 * The name a foreign crash's `module` tag is allowed to carry.
 *
 * A foreign crash is a process that inherited our crash handler (see
 * native-crash-event.ts). Its main module's file name is what makes the one
 * Sentry issue useful: it says which program keeps leaking into our crash
 * database. A basename carries no path and no home directory, but it can still
 * say what the user works on. 0.43.0 reported several names of one user's own
 * project test binaries, which is exactly that.
 *
 * So the name is judged from the FULL path, before any basename is taken. A file
 * an OS installer or a package manager put in place has a published name, and
 * that name is kept. Anything else becomes `user-binary`: build outputs
 * (`target/`, `.build/`, Xcode's DerivedData), temp directories, external
 * volumes, and everything else under a project or a home directory.
 *
 * One leak is accepted on purpose. `cargo install --path .` and
 * `go install ./...` put a user's own binary in `~/.cargo/bin` and `~/go/bin`,
 * next to the published tools those directories exist for. They stay on the
 * list because the program that dominates the pre-release baseline lives in one
 * of them, and losing its name would blind the post-release check that the
 * exception-port reset worked. The same holds for `make install` into
 * `/usr/local`, which shares that root with Intel Homebrew and `.NET`.
 *
 * A directory missing from these lists degrades to `user-binary`, the safe
 * direction. Foreign dumps have only ever arrived from macOS, where exception
 * ports are inherited across exec; the Linux and Windows entries cover the same
 * question for paths from those systems.
 */

export const USER_BINARY_MODULE = 'user-binary';
export const UNKNOWN_MODULE = 'unknown';

/**
 * Roots an OS installer or a system-wide package manager owns, lowercased and
 * with any Windows drive letter already stripped (see normalizeModulePath).
 */
const SYSTEM_INSTALL_ROOTS: readonly string[] = [
  // macOS and Linux system images and apps.
  '/system/',
  '/bin/',
  '/sbin/',
  '/library/',
  '/applications/',
  // Includes Intel Homebrew and `.NET` under /usr/local.
  '/usr/',
  // Apple Silicon Homebrew, MacPorts, and vendor installs.
  '/opt/',
  '/nix/store/',
  '/snap/',
  // Windows.
  '/windows/',
  '/program files/',
  '/program files (x86)/',
];

/** A home directory: macOS and Windows `/users/<name>/`, Linux `/home/<name>/`, and root's. */
const HOME_DIRECTORY = /^(?:\/(?:users|home)\/[^/]+|\/root|\/var\/root)\//;

/** Directories under a home directory that package managers and installers own. */
const HOME_INSTALL_DIRECTORIES: readonly string[] = [
  '.cargo/bin/',
  '.rustup/',
  'go/bin/',
  // pipx, uv tools, and most curl-to-shell installers.
  '.local/bin/',
  // XDG data: mise, uv's Pythons, pnpm, and similar toolchain stores.
  '.local/share/',
  '.bun/',
  '.deno/',
  '.volta/',
  '.nvm/',
  '.fnm/',
  '.asdf/',
  '.pyenv/',
  '.rbenv/',
  '.sdkman/',
  '.npm/',
  '.dotnet/',
  '.nix-profile/',
  'library/pnpm/',
  // Browsers Puppeteer and Playwright download for their npm packages.
  '.cache/puppeteer/',
  '.cache/ms-playwright/',
  'library/caches/ms-playwright/',
  // Per-user app installs.
  'applications/',
  'appdata/local/programs/',
];

/**
 * A package manager's install directory wherever it sits, including inside a
 * project. What is in it is a published package's binary, such as another
 * project's own dev Electron Helper (DESKTOP-1D).
 */
const INSTALL_DIRECTORY_SEGMENTS: readonly string[] = ['/node_modules/'];

/**
 * The last path segment, splitting on either separator. `path.basename` splits
 * on the HOST's separator, and these paths come from the crashed machine, so a
 * Windows dump read on a Linux CI runner would come back whole.
 */
export function moduleBasename(modulePath: string): string {
  const separator = Math.max(modulePath.lastIndexOf('/'), modulePath.lastIndexOf('\\'));
  return separator === -1 ? modulePath : modulePath.slice(separator + 1);
}

/**
 * Forward slashes, lowercase, and no Windows long-path prefix or drive letter,
 * so one set of prefixes answers for every platform. `C:\Users\dev\x.exe` and
 * `/Users/dev/x` both become `/users/dev/...`. Case is folded everywhere, which
 * can only widen a match to an odd-cased spelling of a directory already listed.
 */
function normalizeModulePath(modulePath: string): string {
  return modulePath
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\//, '')
    .replace(/^[a-z]:\//i, '/')
    .toLowerCase();
}

function isInstalledByInstaller(normalizedPath: string): boolean {
  if (SYSTEM_INSTALL_ROOTS.some((root) => normalizedPath.startsWith(root))) return true;
  if (INSTALL_DIRECTORY_SEGMENTS.some((segment) => normalizedPath.includes(segment))) return true;
  const home = HOME_DIRECTORY.exec(normalizedPath);
  if (!home) return false;
  const underHome = normalizedPath.slice(home[0].length);
  return HOME_INSTALL_DIRECTORIES.some((directory) => underHome.startsWith(directory));
}

/**
 * The `module` tag for a foreign crash: the main module's file name when an
 * installer or package manager put it there, `user-binary` when it did not, and
 * `unknown` when the dump names no main module.
 */
export function reportableModuleName(mainModulePath: string | undefined): string {
  const basename = mainModulePath ? moduleBasename(mainModulePath) : '';
  if (!mainModulePath || basename.length === 0) return UNKNOWN_MODULE;
  return isInstalledByInstaller(normalizeModulePath(mainModulePath)) ? basename : USER_BINARY_MODULE;
}
