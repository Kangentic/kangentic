/**
 * What the harness's two command lines (translate.mjs and bake-off/run.mjs)
 * share: reading their flags, refusing to run under CI, and the app code they
 * bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTsModule } from '../lib/bundle-ts-module.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reads `argv` strictly. An unknown flag, a flag with no value, or a value that is
 * itself a flag throws, because a typo such as `--engine=local` would otherwise
 * fall back to a default and spend real model calls.
 *
 * - `valueFlags`: flags that take the next argument as their value.
 * - `switchFlags`: flags that stand alone.
 * - `positionalCount`: how many bare arguments may come before or between flags.
 */
export function readFlags(argv, { valueFlags, switchFlags, positionalCount = 0 }) {
  const values = new Map();
  const switches = new Set();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      if (positionals.length >= positionalCount) throw new Error(`Unexpected argument ${argument}`);
      positionals.push(argument);
      continue;
    }
    if (switchFlags.includes(argument)) {
      switches.add(argument);
      continue;
    }
    if (!valueFlags.includes(argument)) throw new Error(`Unknown option ${argument}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${argument} needs a value`);
    values.set(argument, next);
    index += 1;
  }
  const value = (flag) => values.get(flag) ?? null;
  return {
    positionals,
    value,
    has: (flag) => switches.has(flag),
    list: (flag) => (value(flag) ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    positive: (flag) => {
      const raw = value(flag);
      if (raw === null) return null;
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1) throw new Error(`${flag}: ${raw} is not a positive whole number`);
      return number;
    },
  };
}

/** Every harness run makes real model calls, so a CI job never starts one by accident. */
export function refuseIfAutomated(why) {
  const automated = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_NUMBER'].find((name) => process.env[name]);
  if (automated) throw new Error(`Refusing to run: ${automated} is set. ${why}`);
}

/**
 * `wcwidthV11` and the settings card scan (app-modules.ts), bundled once per run.
 * The constant is pinned as vitest pins it: the settings registry is app code.
 */
export function loadAppModules() {
  return importTsModule(path.join(here, 'app-modules.ts'), { external: ['typescript'], define: { __KANGENTIC_DEV__: 'false' } });
}

/** A source file reader for neighbours, cached, relative to the repo. */
export function sourceReader(repoRoot) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, fs.readFileSync(path.resolve(repoRoot, file), 'utf8'));
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file);
  };
}
