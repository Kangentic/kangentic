/**
 * Command-line parsing for demo/measure.mjs (demo/measure-args.mjs): `argValue`, `numberArg` and
 * `parseBuildEntries`.
 *
 * measure.mjs runs its whole measurement the moment it is imported, so the parsing lives in its own
 * module to be testable. A malformed flag has to stop the run with a message naming the flag, because
 * the failure it replaces was silent: `--dwell=15s` read as a looping frame's wait of zero, and the
 * heap was read before the frame had played.
 *
 * Nothing here touches the disk or a browser. `parseBuildEntries` takes a stub `labelFor`, and every
 * directory is built with `path.resolve`, so an absolute path is absolute on every OS.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { argValue, numberArg, parseBuildEntries } from '../../demo/measure-args.mjs';

describe('argValue', () => {
  it('returns the text after --name=', () => {
    expect(argValue(['--runs=3', '--dwell=15000'], 'dwell')).toBe('15000');
  });

  it('returns null when the flag is absent', () => {
    expect(argValue([], 'dwell')).toBeNull();
    expect(argValue(['--runs=3', 'positional'], 'dwell')).toBeNull();
  });

  it('returns an empty string, not null, for a flag given with no value', () => {
    expect(argValue(['--dwell='], 'dwell')).toBe('');
  });

  it('does not match a bare flag without =, or a flag whose name only starts with the same letters', () => {
    expect(argValue(['--dwell'], 'dwell')).toBeNull();
    expect(argValue(['--dwell-extra=5'], 'dwell')).toBeNull();
  });

  it('keeps every = after the first in the value, and takes the first occurrence of a repeated flag', () => {
    expect(argValue(['--dist=label=builds/one'], 'dist')).toBe('label=builds/one');
    expect(argValue(['--runs=2', '--runs=9'], 'runs')).toBe('2');
  });
});

describe('numberArg', () => {
  it('returns the fallback, whatever its type, when the flag is absent', () => {
    expect(numberArg([], 'runs', { fallback: 3, min: 1, integer: true })).toBe(3);
    expect(numberArg(['--other=1'], 'dwell', { fallback: null, min: 0 })).toBeNull();
  });

  it('returns the parsed number for a valid value', () => {
    expect(numberArg(['--runs=4'], 'runs', { fallback: 3, min: 1, integer: true })).toBe(4);
    expect(numberArg(['--dwell=2.5'], 'dwell', { fallback: 15000, min: 0 })).toBe(2.5);
  });

  it('accepts exactly the minimum, and returns a zero rather than the fallback', () => {
    expect(numberArg(['--dwell=0'], 'dwell', { fallback: 15000, min: 0 })).toBe(0);
    expect(numberArg(['--runs=1'], 'runs', { fallback: 3, min: 1, integer: true })).toBe(1);
  });

  it('throws, naming the flag and the offending value, for a value below the minimum', () => {
    expect(() => numberArg(['--runs=0'], 'runs', { fallback: 3, min: 1, integer: true })).toThrow(/--runs\b.*"0"/);
    expect(() => numberArg(['--dwell=-1'], 'dwell', { fallback: 15000, min: 0 })).toThrow(/--dwell\b.*"-1"/);
  });

  it('throws for a fractional value when the flag takes a whole number', () => {
    expect(() => numberArg(['--runs=2.5'], 'runs', { fallback: 3, min: 1, integer: true })).toThrow(/--runs\b.*"2.5"/);
  });

  it('throws for a value that is not a number, so a unit suffix cannot read as zero', () => {
    expect(() => numberArg(['--dwell=15s'], 'dwell', { fallback: 15000, min: 0 })).toThrow(/--dwell\b.*"15s"/);
    expect(() => numberArg(['--dwell=Infinity'], 'dwell', { fallback: 15000, min: 0 })).toThrow(/--dwell\b.*"Infinity"/);
  });

  it('throws for an empty or blank value, which Number() would otherwise read as 0', () => {
    expect(() => numberArg(['--dwell='], 'dwell', { fallback: 15000, min: 0 })).toThrow(/--dwell\b/);
    expect(() => numberArg(['--dwell=   '], 'dwell', { fallback: 15000, min: 0 })).toThrow(/--dwell\b/);
  });
});

describe('parseBuildEntries', () => {
  const stubLabelFor = (directory: string): string => `stamped:${path.basename(directory)}`;

  it('measures the default build alone, labelled by labelFor, when the flag is absent', () => {
    const labelFor = vi.fn(stubLabelFor);
    const defaultDirectory = path.join('dist', 'demo');
    const resolved = path.resolve(defaultDirectory);

    expect(parseBuildEntries(null, defaultDirectory, labelFor)).toEqual([{ label: 'stamped:demo', dir: resolved }]);
    expect(labelFor).toHaveBeenCalledTimes(1);
    expect(labelFor).toHaveBeenCalledWith(resolved);
  });

  it('labels a bare directory with labelFor and resolves it', () => {
    const labelFor = vi.fn(stubLabelFor);
    const builds = parseBuildEntries(path.join('builds', 'main'), path.join('dist', 'demo'), labelFor);

    expect(builds).toEqual([{ label: 'stamped:main', dir: path.resolve('builds', 'main') }]);
    expect(labelFor).toHaveBeenCalledWith(path.resolve('builds', 'main'));
  });

  it('splits label=directory at the first =, and never asks labelFor for a labelled entry', () => {
    const labelFor = vi.fn(stubLabelFor);
    const builds = parseBuildEntries('base=builds/main,pr=builds/a=b', 'dist/demo', labelFor);

    expect(builds).toEqual([
      { label: 'base', dir: path.resolve('builds/main') },
      { label: 'pr', dir: path.resolve('builds/a=b') },
    ]);
    expect(labelFor).not.toHaveBeenCalled();
  });

  it('accepts an absolute directory after a label', () => {
    const absoluteDirectory = path.resolve('builds', 'main');
    const builds = parseBuildEntries(`base=${absoluteDirectory}`, 'dist/demo', stubLabelFor);

    expect(builds).toEqual([{ label: 'base', dir: absoluteDirectory }]);
  });

  it('reads an absolute directory that contains = whole, with no label split', () => {
    const absoluteDirectory = path.resolve('builds', 'a=b');
    expect(path.isAbsolute(absoluteDirectory)).toBe(true);
    const labelFor = vi.fn(stubLabelFor);

    const builds = parseBuildEntries(absoluteDirectory, 'dist/demo', labelFor);

    expect(builds).toEqual([{ label: 'stamped:a=b', dir: absoluteDirectory }]);
    expect(labelFor).toHaveBeenCalledWith(absoluteDirectory);
  });

  it('numbers labels that collide by their position, and leaves a unique label alone', () => {
    const builds = parseBuildEntries('x=builds/one,y=builds/two,x=builds/three', 'dist/demo', stubLabelFor);

    expect(builds.map((build) => build.label)).toEqual(['x (1)', 'y', 'x (3)']);
  });

  it('numbers two unlabeled builds that stamp the same version', () => {
    const sameVersion = (): string => '1.2.3';
    const builds = parseBuildEntries(`${path.join('builds', 'one')},${path.join('builds', 'two')}`, 'dist/demo', sameVersion);

    expect(builds.map((build) => build.label)).toEqual(['1.2.3 (1)', '1.2.3 (2)']);
    expect(builds.map((build) => build.dir)).toEqual([path.resolve('builds', 'one'), path.resolve('builds', 'two')]);
  });
});
