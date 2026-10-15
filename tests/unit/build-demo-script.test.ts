import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scripts/build-demo.js spawns `vite build` for the web demo. Nothing else reads or runs it, and
// three of the things it does hold up the build without ever failing a run if they are dropped:
//
//  - `--configLoader bundle` ahead of `--config`. demo/vite.config.mts imports extensionless
//    src/ and tests/captures/ .ts files, which Vite's native loader cannot load. The pin keeps the
//    build working when a Vite major makes `native` the default.
//  - VITE_CONFIG_NATIVE_IGNORE_WARNING=true in the spawn env. The bundle loader prints a
//    native-compatibility warning on every build, and this env var silences it.
//  - NODE_ENV=production before Vite starts. A shell that exports "development" would otherwise
//    ship React's development build in a bundle that reports success.
//
// The test runs the real script in a child node process. A `--require` preload replaces
// `child_process.spawnSync` before the script loads (the script destructures it at load time), so
// the child records the argv and env it WOULD have given Vite and never starts Vite. The child gets
// an ambient NODE_ENV=development and no VITE_CONFIG_NATIVE_IGNORE_WARNING, so a passing
// assertion reflects the script's own pin and not a value inherited from this process.
//
// Red cases run the same harness against a copy of the script with one piece removed, and feed
// checkViteSpawn hand-built captures for the ordering mistakes. The real script is never edited.
//
// Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const BUILD_DEMO_SOURCE_PATH = path.join(REPO_ROOT, 'scripts', 'build-demo.js');
const CAPTURE_FILE_ENV = 'BUILD_DEMO_CAPTURE_FILE';

// Written to the sandbox and loaded with `--require`. CommonJS, like the script it wraps.
const SPAWN_RECORDER_SOURCE = `
const childProcess = require('node:child_process');
const fs = require('node:fs');
childProcess.spawnSync = function recordSpawnSync(command, args, options) {
  const env = (options && options.env) || {};
  fs.writeFileSync(process.env.${CAPTURE_FILE_ENV}, JSON.stringify({
    command,
    args,
    env: {
      NODE_ENV: env.NODE_ENV,
      VITE_CONFIG_NATIVE_IGNORE_WARNING: env.VITE_CONFIG_NATIVE_IGNORE_WARNING,
    },
  }));
  return { status: 0 };
};
`;

interface SpawnCapture {
  command: string;
  args: string[];
  env: {
    NODE_ENV?: string;
    VITE_CONFIG_NATIVE_IGNORE_WARNING?: string;
  };
}

interface BuildDemoRun {
  exitStatus: number | null;
  stdout: string;
  stderr: string;
  capture: SpawnCapture | null;
}

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Everything the script must hand to `vite build`, as a list of named problems. An empty list is a
 * correct spawn. The real-script tests and the red cases both read their verdict from here.
 */
function checkViteSpawn(capture: SpawnCapture, forwardedArgs: string[]): string[] {
  const problems: string[] = [];
  const { args, env } = capture;

  const loaderIndex = args.indexOf('--configLoader');
  const configIndex = args.indexOf('--config');

  if (loaderIndex === -1) {
    problems.push('missing --configLoader');
  } else {
    if (args[loaderIndex + 1] !== 'bundle') problems.push('--configLoader is not followed by bundle');
    if (configIndex !== -1 && loaderIndex > configIndex) problems.push('--configLoader comes after --config');
  }

  if (configIndex === -1) {
    problems.push('missing --config');
  } else {
    if (!toForwardSlashes(args[configIndex + 1] ?? '').endsWith('/demo/vite.config.mts')) {
      problems.push('--config does not name demo/vite.config.mts');
    }
    const tail = args.slice(configIndex + 2);
    if (JSON.stringify(tail) !== JSON.stringify(forwardedArgs)) {
      problems.push('forwarded arguments are not exactly the tail after the config path');
    }
  }

  if (env.VITE_CONFIG_NATIVE_IGNORE_WARNING !== 'true') problems.push('VITE_CONFIG_NATIVE_IGNORE_WARNING is not "true"');
  if (env.NODE_ENV !== 'production') problems.push('NODE_ENV is not "production"');

  return problems;
}

describe('scripts/build-demo.js', { timeout: 30_000 }, () => {
  let sandbox = '';
  let preloadPath = '';
  let runCounter = 0;

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-build-demo-'));
    preloadPath = path.join(sandbox, 'record-spawn.cjs');
    fs.writeFileSync(preloadPath, SPAWN_RECORDER_SOURCE);
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** Run a build-demo script in a child node with the spawn recorder preloaded. */
  function runBuildDemo(scriptPath: string, forwardedArgs: string[]): BuildDemoRun {
    runCounter++;
    const captureFile = path.join(sandbox, `capture-${runCounter}.json`);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', [CAPTURE_FILE_ENV]: captureFile };
    delete childEnv.VITE_CONFIG_NATIVE_IGNORE_WARNING;

    const result = spawnSync(process.execPath, ['--require', preloadPath, scriptPath, ...forwardedArgs], {
      env: childEnv,
      encoding: 'utf8',
      // If the recorder ever failed to take, the script would start a real `vite build`.
      timeout: 20_000,
    });
    return {
      exitStatus: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      capture: fs.existsSync(captureFile) ? (JSON.parse(fs.readFileSync(captureFile, 'utf8')) as SpawnCapture) : null,
    };
  }

  function requireCapture(run: BuildDemoRun): SpawnCapture {
    if (!run.capture) {
      throw new Error(
        `The spawn recorder never ran (exit ${run.exitStatus}).\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
      );
    }
    return run.capture;
  }

  /** The real script with one piece cut out, written where its own `..` resolves to the sandbox. */
  function writeMutatedScript(caseName: string, needle: string, replacement: string): string {
    const original = fs.readFileSync(BUILD_DEMO_SOURCE_PATH, 'utf8');
    if (!original.includes(needle)) {
      throw new Error(`The mutation needle ${JSON.stringify(needle)} is not in scripts/build-demo.js, so this red case would prove nothing.`);
    }
    const scriptsDirectory = path.join(sandbox, caseName, 'scripts');
    fs.mkdirSync(scriptsDirectory, { recursive: true });
    const scriptPath = path.join(scriptsDirectory, 'build-demo.js');
    fs.writeFileSync(scriptPath, original.split(needle).join(replacement));
    return scriptPath;
  }

  describe('the real script', () => {
    it('puts --configLoader bundle ahead of --config and hands Vite the pinned env', () => {
      const forwardedArgs = ['--base=/kangentic/'];
      const run = runBuildDemo(BUILD_DEMO_SOURCE_PATH, forwardedArgs);
      const capture = requireCapture(run);

      expect(run.exitStatus).toBe(0);
      expect(capture.command).toBe(process.execPath);
      expect(toForwardSlashes(capture.args[0])).toMatch(/\/node_modules\/vite\/bin\/vite\.js$/);
      expect(capture.args[1]).toBe('build');

      const loaderIndex = capture.args.indexOf('--configLoader');
      const configIndex = capture.args.indexOf('--config');
      expect(loaderIndex).toBeGreaterThan(-1);
      expect(capture.args[loaderIndex + 1]).toBe('bundle');
      expect(loaderIndex).toBeLessThan(configIndex);

      expect(capture.env.VITE_CONFIG_NATIVE_IGNORE_WARNING).toBe('true');
      expect(capture.env.NODE_ENV).toBe('production');
      expect(checkViteSpawn(capture, forwardedArgs)).toEqual([]);
    });

    it('forwards every extra argument, in order, after the config path', () => {
      const forwardedArgs = ['--base=/kangentic/', '--outDir', 'somewhere-else', '--mode', 'demo'];
      const capture = requireCapture(runBuildDemo(BUILD_DEMO_SOURCE_PATH, forwardedArgs));
      const configIndex = capture.args.indexOf('--config');
      expect(capture.args.slice(configIndex + 2)).toEqual(forwardedArgs);
      expect(checkViteSpawn(capture, forwardedArgs)).toEqual([]);
    });

    it('pins NODE_ENV to production over an ambient development value and says so', () => {
      const run = runBuildDemo(BUILD_DEMO_SOURCE_PATH, []);
      expect(requireCapture(run).env.NODE_ENV).toBe('production');
      expect(run.stdout).toContain('NODE_ENV pinned to production (shell had "development")');
    });

    it('refuses a --base that does not start with a slash, before it starts Vite', () => {
      // The shape a Git Bash shell on Windows hands over after it rewrites "/kangentic/".
      const run = runBuildDemo(BUILD_DEMO_SOURCE_PATH, ['--base=C:/Program Files/Git/kangentic/']);
      expect(run.exitStatus).toBe(1);
      expect(run.stderr).toContain('--base must start with a slash');
      expect(run.capture).toBeNull();
    });
  });

  describe('checkViteSpawn red cases (the real script cut down, then hand-built captures)', () => {
    it('catches --configLoader bundle dropped from the script', () => {
      const scriptPath = writeMutatedScript('no-config-loader', "'--configLoader', 'bundle', ", '');
      const capture = requireCapture(runBuildDemo(scriptPath, []));
      expect(checkViteSpawn(capture, [])).toEqual(['missing --configLoader']);
    });

    it('catches the native-warning silencer dropped from the script', () => {
      const scriptPath = writeMutatedScript('no-warning-silencer', ", VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true'", '');
      const capture = requireCapture(runBuildDemo(scriptPath, []));
      expect(checkViteSpawn(capture, [])).toEqual(['VITE_CONFIG_NATIVE_IGNORE_WARNING is not "true"']);
    });

    it('catches the NODE_ENV pin dropped from the script', () => {
      const scriptPath = writeMutatedScript('no-node-env-pin', "process.env.NODE_ENV = 'production';", '');
      const capture = requireCapture(runBuildDemo(scriptPath, []));
      expect(checkViteSpawn(capture, [])).toEqual(['NODE_ENV is not "production"']);
    });

    const goodCapture: SpawnCapture = {
      command: 'node',
      args: ['/repo/node_modules/vite/bin/vite.js', 'build', '--configLoader', 'bundle', '--config', '/repo/demo/vite.config.mts', '--base=/kangentic/'],
      env: { NODE_ENV: 'production', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
    };

    it('accepts a correct capture', () => {
      expect(checkViteSpawn(goodCapture, ['--base=/kangentic/'])).toEqual([]);
    });

    it('catches --configLoader moved after --config', () => {
      const capture: SpawnCapture = {
        ...goodCapture,
        args: ['/repo/node_modules/vite/bin/vite.js', 'build', '--config', '/repo/demo/vite.config.mts', '--configLoader', 'bundle'],
      };
      // The pair also lands in the tail where only forwarded arguments belong, so two problems show.
      expect(checkViteSpawn(capture, [])).toEqual([
        '--configLoader comes after --config',
        'forwarded arguments are not exactly the tail after the config path',
      ]);
    });

    it('catches --configLoader pinned to a loader other than bundle', () => {
      const capture: SpawnCapture = {
        ...goodCapture,
        args: ['/repo/node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native', '--config', '/repo/demo/vite.config.mts'],
      };
      expect(checkViteSpawn(capture, [])).toEqual(['--configLoader is not followed by bundle']);
    });

    it('catches a forwarded argument placed before the config path', () => {
      const capture: SpawnCapture = {
        ...goodCapture,
        args: ['/repo/node_modules/vite/bin/vite.js', 'build', '--base=/kangentic/', '--configLoader', 'bundle', '--config', '/repo/demo/vite.config.mts'],
      };
      expect(checkViteSpawn(capture, ['--base=/kangentic/'])).toEqual([
        'forwarded arguments are not exactly the tail after the config path',
      ]);
    });

    it('catches a missing or wrong env value', () => {
      const withoutWarning: SpawnCapture = { ...goodCapture, env: { NODE_ENV: 'production' } };
      expect(checkViteSpawn(withoutWarning, ['--base=/kangentic/'])).toEqual(['VITE_CONFIG_NATIVE_IGNORE_WARNING is not "true"']);
      const wrongNodeEnv: SpawnCapture = { ...goodCapture, env: { ...goodCapture.env, NODE_ENV: 'development' } };
      expect(checkViteSpawn(wrongNodeEnv, ['--base=/kangentic/'])).toEqual(['NODE_ENV is not "production"']);
    });
  });
});
