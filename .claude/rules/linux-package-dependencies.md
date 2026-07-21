---
paths:
  - "electron-builder.yml"
---
# Rule: rpm dependencies are sonames, not package names

`electron-builder.yml`'s `rpm.depends` declared `libXShmfence`, the package name Chromium's
own build scripts use. No RPM distro has ever shipped a package by that exact name: Fedora and
RHEL call it `libxshmfence`, openSUSE calls it `libxshmfence1`. `rpm -i` enforces `Requires`
without resolving them, so `npx kangentic` on Fedora 44 failed outright even though the library
was already installed - only its package name didn't match.

RPM package *names* vary per distro; `.so` sonames do not - `libxshmfence.so.1` is
`libxshmfence.so.1` everywhere, and every distro's rpmbuild auto-generates a `Provides:` for
it. Depending on the soname instead of the package name is the fix upstream Electron itself
recommends for this exact class of bug
([electron#41677](https://github.com/electron/electron/issues/41677)).

## The rule

- **`rpm.depends` entries are soname capabilities**, in the form `<soname>()(64bit)`
  (e.g. `libxshmfence.so.1()(64bit)`), never a bare package name (`libXShmfence`, `nss`,
  `gtk3`, ...). Get the exact soname string empirically - `rpm -q --provides <package>` on a
  real Fedora/RHEL system, filtered to the `()(64bit)` capability lines - never type one from
  memory or copy it from another project's config.
- If a soname genuinely cannot express the dependency, fall back to RPM's rich-dependency
  boolean form (`(libXtst or libXtst6)`), which is electron-builder's own default style for
  exactly this situation. Do not fall back to a plain package name.
- **`deb.depends` entries stay package names** - Debian has no soname-capability equivalent
  through fpm. Where a distro has renamed a package (Ubuntu 24.04+ renamed `libasound2` to
  `libasound2t64`), use alternation (`libasound2t64 | libasound2`) rather than picking one name
  and breaking the other release.
- Do not hand-derive a new dependency list from memory or from another Electron app's config.
  If you need to add or audit an entry, verify it against the actual built payload (see the
  Linux-CI install gate below) or a real distro package database - both `rpm -q --provides` and
  `objdump -p <binary> | grep NEEDED` are read-only and fast to run in a throwaway container.

## Enforcement (self-maintaining)

- **Test (shape only):** `tests/unit/linux-package-deps.test.ts` parses `electron-builder.yml`
  and fails if any `rpm.depends` entry is not a soname-capability or rich-dependency-boolean
  string. Runs in CI via `npm run test:unit`. This catches a package name creeping back in, but
  cannot catch a soname that is spelled wrong or genuinely absent - it is a shape check, not a
  correctness check.
- **CI (correctness):** the `release` workflow's Linux job actually installs the built `.rpm`
  and `.deb` via `dnf` / `zypper` / `apt-get install` in clean Fedora, openSUSE, Debian, and
  Ubuntu containers after building, one step per distro so all four report independently. A
  dependency that does not resolve on a real system fails the release before it ships. This is the check that would have caught the original bug, and the
  one that matters most - the unit test only catches the *shape* of a regression, not whether
  the string is actually correct.
- **Review:** `platform-guard` and `/code-review` flag a bare package name in `rpm.depends`
  during review of `electron-builder.yml` changes.

An earlier draft of this rule proposed deriving `rpm.depends` automatically from
`objdump -p`'s `NEEDED` entries across the built payload, diffed in CI. That was rejected:
Chromium loads some runtime dependencies (`libxshmfence` itself, among others) via `dlopen()`
rather than linking them, so they never appear as `NEEDED` - a pure link-time diff would have
silently deleted the one dependency this rule exists to keep correct. Do not resurrect that
approach without also covering `dlopen`'d dependencies.

## Scope

`electron-builder.yml`'s `linux`, `rpm`, and `deb` sections. Does not cover the launcher's
choice of installer command (`packages/launcher/bin/kangentic.js`) or which packages Electron
itself requires at runtime - only how already-decided dependencies are named.
