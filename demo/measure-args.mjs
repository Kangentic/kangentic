/**
 * Command-line parsing for demo/measure.mjs, kept out of that script so it can be tested: the
 * script runs its whole measurement as soon as it is imported. Nothing here touches the disk or a
 * browser.
 */
import path from 'node:path';

/**
 * The value of `--name=value` in `argv`, or null when the flag is absent.
 *
 * @param {readonly string[]} argv
 * @param {string} name
 * @returns {string | null}
 */
export function argValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/**
 * `--name=<number>` as a number, or `fallback` when the flag is absent. A value that is not a
 * finite number, is below `min`, or is fractional where `integer` is set throws a message naming
 * the flag, so `--dwell=15s` stops the run instead of reading a looping frame at once.
 *
 * @template Fallback
 * @param {readonly string[]} argv
 * @param {string} name
 * @param {{ fallback: Fallback; min: number; integer?: boolean }} options
 * @returns {number | Fallback}
 */
export function numberArg(argv, name, { fallback, min, integer = false }) {
  const raw = argValue(argv, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} takes ${integer ? 'a whole number' : 'a number'} of at least ${min}, not "${raw}"`);
  }
  return value;
}

/**
 * `--dist=entry[,entry...]`: the builds to measure. An entry is a build directory, or
 * `label=directory`. An absolute directory never carries a label, so a Windows path with a drive
 * colon, or a path holding `=`, is read whole; a relative directory holding `=` needs a label in
 * front of it. A build with no label takes `labelFor(directory)` (measure.mjs passes the app version
 * the build stamped), and labels that collide get their position appended.
 *
 * @param {string | null} raw The flag's value, or null for the default build alone.
 * @param {string} defaultDir
 * @param {(directory: string) => string} labelFor
 * @returns {Array<{ label: string; dir: string }>}
 */
export function parseBuildEntries(raw, defaultDir, labelFor) {
  const entries = raw ? raw.split(',') : [defaultDir];
  const builds = entries.map((entry) => {
    const separator = path.isAbsolute(entry) ? -1 : entry.indexOf('=');
    const dir = path.resolve(separator === -1 ? entry : entry.slice(separator + 1));
    return { label: separator === -1 ? labelFor(dir) : entry.slice(0, separator), dir };
  });
  return builds.map((build, index) => (builds.some((other, otherIndex) => otherIndex !== index && other.label === build.label)
    ? { ...build, label: `${build.label} (${index + 1})` }
    : build));
}
