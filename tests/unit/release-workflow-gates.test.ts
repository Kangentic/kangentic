import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// A gate that stops gating without saying so is worse than no gate, because it still reads as
// coverage. release.yml has been bitten by that four times now. The first two shapes are below;
// the later describe blocks pin the published-release re-run (v0.39.0) and the two upgrade-gate
// baselines (v0.39.0 upgrading from itself, v0.39.x downgrading from v0.40.0).
//
// The subtle one is the status-check function. GitHub normally skips a job when anything in its
// `needs:` failed, but naming always(), cancelled(), or failure() in the `if:` replaces that
// implied success() gate, so a job listed in `needs:` and NOT also named in the `if:` still runs
// when its dependency FAILED. release.yml carries always() on two jobs to tolerate the conditional
// create-tag and `!cancelled()` on the two publish jobs, the demo deploy, and the poster job, which
// means every future `needs:` entry added to any of the six has to be repeated in the `if:` by
// hand. The comment above create-draft-release warns about this; this test is what makes the
// warning binding.
//
// The blunt one is a gate simply going missing: preflight-symbols exists because v0.37.0 and
// v0.38.0 both shipped with zero sourcemaps and zero native debug files, the KANGENTIC_SENTRY_TOKEN
// secret never having been created. The build no-opped in total silence and every job reported
// success. Deleting that job, or unhooking it from the draft, would restore that exact hole.
//
// Follows release-asset-manifest.test.ts in regex-extracting YAML rather than adding a parser
// (js-yaml is only transitively present, not a declared dependency).
//
// Tier: Unit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const workflowSource = fs.readFileSync(WORKFLOW_PATH, 'utf8');

interface WorkflowJob {
  name: string;
  body: string;
  needs: string[];
  condition: string | null;
}

/**
 * Split the `jobs:` mapping into one entry per job. Job keys sit at exactly two spaces of
 * indentation, so a line matching /^ {2}([\w-]+):$/ starts a job and the body runs to the next
 * such line. Comment lines between jobs land in the PRECEDING job's body, which is harmless: no
 * assertion here reads a commented-out `needs:` or `if:`, since both are matched anchored to
 * their own four-space indentation.
 */
function parseJobs(source: string): WorkflowJob[] {
  const jobsBlock = source.slice(source.indexOf('\njobs:\n'));
  const lines = jobsBlock.split('\n');
  const jobs: WorkflowJob[] = [];
  let current: { name: string; lines: string[] } | null = null;

  for (const line of lines) {
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      if (current) jobs.push(buildJob(current));
      current = { name: header[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) jobs.push(buildJob(current));
  return jobs;
}

function buildJob(raw: { name: string; lines: string[] }): WorkflowJob {
  const body = raw.lines.join('\n');
  const needsMatch = body.match(/^ {4}needs:\s*(.+)$/m);
  const conditionMatch = body.match(/^ {4}if:\s*(.+)$/m);
  const needs = needsMatch
    ? needsMatch[1]
        .replace(/[[\]]/g, '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  return { name: raw.name, body, needs, condition: conditionMatch ? conditionMatch[1] : null };
}

const jobs = parseJobs(workflowSource);

/**
 * One step's block out of a job body. Steps open with `      - name: <name>` at six spaces and
 * run to the next line at that same indentation, so the returned text carries the step's `run:`
 * script and nothing from its neighbours.
 *
 * The end boundary is two patterns, not one. A step normally ends at the next step, but the LAST
 * step of a job has none: parseJobs leaves the comment block that introduces the next job inside
 * the previous job's body (harmless for its own indentation-anchored matches, not for this), so
 * an end test looking only for `      - ` runs off the end and swallows that header. A non-empty
 * line at exactly two spaces is the next job, and stops the block too.
 *
 * Throws rather than returning empty on a miss: a renamed step would otherwise silently turn
 * every assertion below into `expect('').not.toContain(...)`, which passes.
 */
function stepBody(jobName: string, stepName: string): string {
  const job = jobs.find((candidate) => candidate.name === jobName);
  if (!job) throw new Error(`release.yml has no job named ${jobName}`);
  const lines = job.body.split('\n');
  const startIndex = lines.findIndex((line) => line === `      - name: ${stepName}`);
  if (startIndex === -1) {
    throw new Error(`Job ${jobName} has no step named "${stepName}" (was it renamed?)`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => /^ {6}- /.test(line) || /^ {2}\S/.test(line));
  const block = rest.slice(0, endOffset === -1 ? rest.length : endOffset).join('\n');
  // The `throw` above covers a bad START. This covers a bad END: if the boundary regex ever stops
  // matching how a step opens, the block silently swallows its neighbours and every `not.toContain`
  // below keeps passing against the wrong text.
  if (block.includes('- name:')) {
    throw new Error(`Step "${stepName}" in ${jobName} absorbed a following step; the boundary regex is stale.`);
  }
  return block;
}

describe('release.yml job graph', () => {
  it('parses the jobs it is meant to guard (proves the regex still matches)', () => {
    const names = jobs.map((job) => job.name);
    expect(names).toContain('preflight-symbols');
    expect(names).toContain('preflight-signing');
    expect(names).toContain('create-draft-release');
    expect(names).toContain('release');
    expect(names).toContain('publish-release');
    expect(names).toContain('deploy-demo');
    expect(names).toContain('demo-posters');
  });

  // buildJob reads `if:` with a single-line regex, so a condition folded onto
  // continuation lines (`if: >`, `if: |`) would parse as just the fold marker.
  // A job folded that way would stop being RECOGNIZED as carrying a status
  // function and drop out of the check below entirely - the silent no-op this
  // rule exists to stop, in the test that enforces it. Fail loudly instead of
  // quietly skipping.
  it('keeps every if: on one line, which is what the condition regex can read', () => {
    for (const job of jobs) {
      if (job.condition === null) continue;
      expect(
        job.condition,
        `Job "${job.name}" folds its if: onto continuation lines. buildJob only reads the first `
          + 'line, so this job would silently stop being checked for status-function/needs: parity. '
          + 'Put the condition back on one line, or teach buildJob to join continuations.',
      ).not.toMatch(/^[>|]/);
    }
  });

  // GitHub implies success() on a job with no status-check function in its if:, and that implied
  // gate is what skips a job when a dependency failed. Naming ANY of always(), cancelled(), or
  // failure() replaces it, so every such job has to re-state each needs: entry by hand.
  // `!cancelled()` is the easy one to miss: it reads like a cancellation guard rather than a
  // dependency gate, but it defeats the implicit skip exactly the way always() does.
  const STATUS_FUNCTION_PATTERN = /\b(always|cancelled|failure)\(\)/;
  const selfGatedJobs = jobs.filter((job) => STATUS_FUNCTION_PATTERN.test(job.condition ?? ''));

  // An empty or shrunken filter would turn the it.each below into zero tests, which passes. The
  // six jobs that carry a status function are named here so dropping one from the workflow, or
  // a parse regression that stops recognizing one, fails rather than quietly reducing coverage.
  it('selects every job whose if: replaces the implied success() gate', () => {
    expect(selfGatedJobs.map((job) => job.name).sort()).toEqual([
      'create-draft-release',
      'demo-posters',
      'deploy-demo',
      'publish-npm',
      'publish-release',
      'release',
    ]);
  });

  // The load-bearing one. Without this, adding a dependency to one of those jobs reads as a gate
  // while doing nothing.
  it.each(selfGatedJobs.map((job) => [job.name, job] as const))(
    '%s replaces the implied success() gate, so every needs: entry is also named in its if:',
    (_name, job: WorkflowJob) => {
      expect(job.needs.length).toBeGreaterThan(0);
      const statusFunction = job.condition?.match(STATUS_FUNCTION_PATTERN)?.[0];
      for (const dependency of job.needs) {
        expect(
          job.condition,
          `Job "${job.name}" lists "${dependency}" in needs: but never references it in its if:. `
            + `${statusFunction} defeats the implicit "skip me if a dependency failed" behaviour, `
            + `so this job would still run when ${dependency} FAILED. Add `
            + `"&& needs.${dependency}.result == 'success'" (or the branch you actually want).`,
        ).toContain(`needs.${dependency}.result`);
      }
    },
  );

  it('gates the draft release on the symbol preflight, not just the build', () => {
    const draft = jobs.find((job) => job.name === 'create-draft-release');
    expect(draft).toBeDefined();
    // Gating the draft rather than only the matrix is what keeps a failed preflight from
    // leaving an orphaned draft release behind for a tag that never shipped.
    expect(draft?.needs).toContain('preflight-symbols');
  });

  it('keeps the symbol preflight required and free of an approval gate', () => {
    const preflight = jobs.find((job) => job.name === 'preflight-symbols');
    expect(preflight).toBeDefined();
    // It must actually fail rather than warn, or it is decoration.
    expect(preflight?.body).toContain('exit 1');
    expect(preflight?.body).toContain('KANGENTIC_SENTRY_TOKEN');
    // No environment: - a required reviewer or wait timer here would stall every release on an
    // approval gate, the same reason create-draft-release declares none.
    expect(preflight?.body).not.toMatch(/^ {4}environment:/m);
  });

  // build/afterSign.js only LOGS a skip when the notarization credentials are missing, so an unset
  // secret ships an app Gatekeeper refuses while every job is green. A new macOS leg in a new
  // release-<platform> environment is exactly when a secret scoped to one environment goes missing.
  it('gates the draft on the Apple signing preflight, which can fail and carries no approval gate', () => {
    const draft = jobs.find((job) => job.name === 'create-draft-release');
    expect(draft?.needs).toContain('preflight-signing');
    const preflight = jobs.find((job) => job.name === 'preflight-signing');
    expect(preflight).toBeDefined();
    expect(preflight?.body).toContain('exit 1');
    expect(preflight?.body).toContain('::error::');
    expect(preflight?.body).not.toMatch(/^ {4}environment:/m);
    for (const secret of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_CERTIFICATE_BASE64', 'APPLE_CERTIFICATE_PASSWORD']) {
      expect(preflight?.body).toContain(`${secret}: \${{ secrets.${secret} }}`);
      // ...and the loop that checks them names it too, or the env line is decoration.
      expect(preflight?.body).toMatch(new RegExp(`for name in [A-Z0-9_ ]*\\b${secret}\\b`));
    }
    // Every secret a mac leg signs or notarizes with is one the preflight checks.
    const appleSecretsUsed = new Set(
      [...(jobs.find((job) => job.name === 'release')?.body ?? '').matchAll(/secrets\.(APPLE_[A-Z_]+)/g)].map((match) => match[1]),
    );
    for (const secret of appleSecretsUsed) {
      expect(preflight?.body, `the release legs use ${secret}, which preflight-signing does not check`).toContain(secret);
    }
  });

  it('authorizes the release build\'s symbol upload explicitly, not through the runner\'s ambient CI', () => {
    // isSentryUploadAuthorized (scripts/build.js) needs CI or KANGENTIC_SENTRY_UPLOAD=1 beside the
    // token. Without the flag a runner that stopped setting CI would skip every upload while the
    // build went green, the v0.37.0 failure this rule exists for.
    const build = stepBody('release', 'Build and publish');
    expect(build).toContain('KANGENTIC_SENTRY_TOKEN: ${{ secrets.KANGENTIC_SENTRY_TOKEN }}');
    expect(build).toMatch(/^ {10}KANGENTIC_SENTRY_UPLOAD: '1'$/m);
  });

  it('reaches the build matrix from the preflight, transitively', () => {
    const releaseJob = jobs.find((job) => job.name === 'release');
    // `release` does not name preflight-symbols directly; it inherits the gate through
    // create-draft-release, whose result its if: already requires. If that clause is ever
    // dropped, a missing token stops failing the build.
    expect(releaseJob?.needs).toContain('create-draft-release');
    expect(releaseJob?.condition).toContain("needs.create-draft-release.result == 'success'");
  });

  // The web demo exists to show the SHIPPED app, so deploy-demo has to build the ref the release
  // was published from, spelled the same way publish-release spells its own checkout ref. A
  // reusable-workflow job has no steps, so the ref reaches deploy-demo.yml only through `with:`,
  // and a drift there (a hand-edited branch name, a bare `main`) would deploy a demo of something
  // other than what just shipped while the run stayed green. The called file is checked to exist
  // too: a rename would otherwise fail only at run time, after every platform build.
  it('deploys the web demo from the same ref the release was published from', () => {
    const deployDemo = jobs.find((job) => job.name === 'deploy-demo');
    const publishRelease = jobs.find((job) => job.name === 'publish-release');
    expect(deployDemo).toBeDefined();
    expect(publishRelease).toBeDefined();
    const usesMatch = deployDemo?.body.match(/^ {4}uses: (.+)$/m);
    expect(usesMatch?.[1]).toBe('./.github/workflows/deploy-demo.yml');
    expect(fs.existsSync(path.join(REPO_ROOT, '.github', 'workflows', 'deploy-demo.yml'))).toBe(true);
    const checkoutRef = publishRelease?.body.match(/^ {10}ref: (.+)$/m)?.[1];
    expect(checkoutRef).toBeDefined();
    expect(deployDemo?.body).toContain(`      ref: ${checkoutRef}`);
  });

  // The poster set kangentic.com's figures read is attached AFTER the release is published, from
  // the same ref, and is deliberately absent from scripts/release-assets.js (that manifest is
  // verified before this job runs). Four shapes keep it honest: the ref parity above, a version
  // gate that fails rather than names the zip after the wrong version, an upload that replaces
  // in place so a re-run of a finished release stays green, and both branches of that upload
  // saying which one they took.
  it('shoots the poster set after publishing, from the published ref, with leave to upload', () => {
    const posters = jobs.find((job) => job.name === 'demo-posters');
    const publishRelease = jobs.find((job) => job.name === 'publish-release');
    expect(posters).toBeDefined();
    expect(posters?.needs).toEqual(['publish-release']);
    expect(posters?.condition).toContain("needs.publish-release.result == 'success'");
    const checkoutRef = publishRelease?.body.match(/^ {10}ref: (.+)$/m)?.[1];
    expect(checkoutRef).toBeDefined();
    expect(posters?.body).toContain(`          ref: ${checkoutRef}`);
    // Uploading needs contents: write; the sibling deploy-demo narrows to read, so a copy-paste
    // of its permissions block would fail the upload at the end of a 10-minute shoot.
    expect(posters?.body).toMatch(/^ {6}contents: write$/m);
  });

  it('gates the shoot on the tag naming the version package.json carries', () => {
    const versionGate = stepBody('demo-posters', 'State the tag and version');
    expect(versionGate).toContain('exit 1');
    expect(versionGate).toContain('::error::');
    expect(versionGate).toContain('matches package.json');

    expect(stepBody('demo-posters', 'Shoot, verify, and pack the poster set')).toContain('npm run demo:posters');
  });

  it('uploads the poster set replacing in place, says which way it went, and stays out of the asset manifest', () => {
    const upload = stepBody('demo-posters', 'Attach the poster set to the release');
    expect(upload).toContain('set -euo pipefail');
    expect(upload).toContain('gh release upload');
    expect(upload).toContain('--clobber');
    expect(upload).toContain('Replacing');
    expect(upload).toContain('Attaching');

    // The comment carrying the "not an expected asset" decision is pinned against the whole file
    // because parseJobs files a job's header comment under the PRECEDING job's body.
    expect(workflowSource).toContain('It is NOT in scripts/release-assets.js');
  });

  // electron-updater skips an update only when latest-mac.yml carries minimumSystemVersion, and
  // electron-builder never writes it there, so without this step a Mac below the floor installs a
  // build macOS refuses to open. It belongs in publish-release, which runs after every platform
  // leg, so a re-run of the mac leg alone cannot put the unpatched file back. It runs before the
  // verify and the --draft=false, so a failure leaves the release a draft. The script itself
  // (value, Darwin mapping, feed shape) is pinned in patch-mac-update-info.test.ts.
  it('patches latest-mac.yml with the minimum system version before verifying and publishing', () => {
    const patch = stepBody('publish-release', 'Block macOS updates below the minimum system version');
    expect(patch).toContain('node scripts/patch-mac-update-info.js "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY"');
    expect(patch).toContain('RELEASE_TAG: ${{ steps.version.outputs.tag }}');
    expect(patch).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(patch).not.toContain('--dry-run');

    const body = jobs.find((job) => job.name === 'publish-release')?.body ?? '';
    const mergeAt = body.indexOf('      - name: Merge the macOS update feeds');
    const patchAt = body.indexOf('      - name: Block macOS updates below the minimum system version');
    const verifyAt = body.indexOf('      - name: Verify the release carries every expected asset');
    const publishAt = body.indexOf('      - name: Publish release with notes (remove draft status)');
    expect(mergeAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeLessThan(patchAt);
    expect(patchAt).toBeLessThan(verifyAt);
    expect(verifyAt).toBeLessThan(publishAt);
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'patch-mac-update-info.js'))).toBe(true);
  });

  // Each macOS leg's electron-builder writes a latest-mac.yml naming only its own files, and the
  // second upload replaces the first on the release, so whichever leg finished last decided every
  // Mac's updates. publish-release rebuilds one feed from the binaries on the release, before the
  // patch above edits the result and before the verify checks it lists every zip. It reads the
  // release, never workflow artifacts: those do not reliably carry across run attempts, and on a
  // re-run over a published release they would hold hashes of rebuilt binaries nobody downloads.
  it('rebuilds the macOS feed from the release in publish-release, with no artifact hand-off', () => {
    const merge = stepBody('publish-release', 'Merge the macOS update feeds');
    expect(merge).toContain('node scripts/merge-mac-update-feeds.js "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY"');
    expect(merge).toContain('RELEASE_TAG: ${{ steps.version.outputs.tag }}');
    expect(merge).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(merge).not.toContain('--dry-run');
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'merge-mac-update-feeds.js'))).toBe(true);
    expect(workflowSource).not.toContain('mac-update-feed-');

    // The merge downloads both arches' zip and dmg, about 800 MB, to hash them.
    const publishRelease = jobs.find((job) => job.name === 'publish-release');
    const timeoutMinutes = Number(publishRelease?.body.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
    expect(timeoutMinutes).toBeGreaterThanOrEqual(10);
  });

  // Every leg builds on a runner of its own arch: npm installs only the host's per-arch native
  // packages, and afterPack loads them with the packaged Electron binary. The macOS legs must be
  // exactly the arches the asset manifest expects zips for, or the merge refuses to run.
  it('builds every arch the asset manifest expects, each on its own runner', () => {
    const releaseBody = jobs.find((job) => job.name === 'release')?.body ?? '';
    const legs = [...releaseBody.matchAll(/^ {10}- os: (\S+)\n {12}platform: (\S+)$/gm)].map((match) => [match[1], match[2]]);
    expect(legs).toEqual([
      ['ubuntu-latest', 'linux'],
      ['ubuntu-24.04-arm', 'linux-arm64'],
      ['windows-latest', 'windows'],
      ['macos-latest', 'macos-arm64'],
      ['macos-26-intel', 'macos-x64'],
    ]);
    const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));
    const { MAC_ARCHES, LINUX_TARGETS } = requireFromRepo('./scripts/release-assets.js') as {
      MAC_ARCHES: string[];
      LINUX_TARGETS: { arch: string; debArch: string; rpmArch: string }[];
    };
    expect(legs.filter(([, platform]) => platform.startsWith('macos')).map(([, platform]) => platform.replace('macos-', '')).sort())
      .toEqual([...MAC_ARCHES].sort());

    // Each Linux leg carries electron-builder's arch names for its packages, matching the manifest.
    for (const target of LINUX_TARGETS) {
      const platform = target.arch === 'x64' ? 'linux' : `linux-${target.arch}`;
      const unpacked = target.arch === 'x64' ? 'linux-unpacked' : `linux-${target.arch}-unpacked`;
      expect(releaseBody).toContain(
        `            platform: ${platform}\n            deb_arch: ${target.debArch}\n            rpm_arch: ${target.rpmArch}\n            unpacked_dir: ${unpacked}`,
      );
    }
  });

  // A step keyed `== 'linux'` silently skips the arm64 leg, which would ship an aarch64 rpm and an
  // arm64 deb that no distro install ever tried: the exact gap release-gates-fail-loudly forbids.
  it('runs every Linux gate on every Linux leg, with no x64 names left in them', () => {
    expect(workflowSource).not.toContain("matrix.platform == 'linux'");
    const releaseBody = jobs.find((job) => job.name === 'release')?.body ?? '';
    const linuxSteps = [...releaseBody.matchAll(/^ {6}- name: (.+)\n {8}if: startsWith\(matrix\.platform, 'linux'\)$/gm)].map((match) => match[1]);
    expect(linuxSteps).toEqual([
      'Verify app-update.yml and package-type are packaged (Linux)',
      'Verify rpm installs on Fedora',
      'Verify rpm installs on openSUSE',
      'Verify deb installs on Debian',
      'Verify deb installs on Ubuntu',
      'Verify rpm upgrades from the previous release',
      'Verify deb upgrades from the previous release',
    ]);
    for (const name of linuxSteps) {
      const body = stepBody('release', name);
      expect(body, `${name} still names an x64 package or directory`).not.toMatch(/x86_64|amd64|linux-unpacked/);
    }
  });

  // A git ref name may contain `"`, `$` and a backtick, a dispatch's version input is free text,
  // and a `${{ }}` expression is pasted into the script text before the shell parses it, so either
  // value spliced into a `run:` line can run whatever it carries. Both only ever reach a step
  // through an env assignment. The one other place the input appears is the create-tag job's
  // `outputs:` value, which no shell reads.
  it('never splices the release tag or the version input into a run script', () => {
    const lines = workflowSource.split(/\r?\n/);
    for (const expression of ['${{ steps.version.outputs.tag }}', '${{ inputs.version }}']) {
      const uses = lines.filter((line) => line.includes(expression));
      expect(uses.length, `${expression} is no longer read at all; update this pin`).toBeGreaterThan(0);
      for (const line of uses) {
        const isEnvAssignment = line.trim() === `${line.trim().split(':')[0]}: ${expression}`
          && /^[A-Z_]+$/.test(line.trim().split(':')[0]);
        const isJobOutput = line.trim() === `tag: v${expression}`;
        expect(isEnvAssignment || isJobOutput, `${expression} is spliced into script text: ${line.trim()}`).toBe(true);
      }
    }
  });

  // The landing page shows the posters with no live frame beside them, so the job installs a face
  // the app's own font stack names before it shoots. Two ways that goes quiet: the install
  // resolving to something else (fc-match answers with SOME font for any name), and a Tailwind
  // bump dropping the family from the stack, after which the posters revert to the runner's
  // fallback with every step green. The first is the step's own gate; the second is pinned here.
  it('installs a font the app stack names before the shoot, and fails when it does not resolve', () => {
    const posters = jobs.find((job) => job.name === 'demo-posters');
    const stepLines = posters?.body.split('\n') ?? [];
    const fontIndex = stepLines.indexOf('      - name: Install the poster font');
    const shootIndex = stepLines.indexOf('      - name: Shoot, verify, and pack the poster set');
    expect(fontIndex, 'the poster job has no "Install the poster font" step').toBeGreaterThan(-1);
    expect(fontIndex).toBeLessThan(shootIndex);

    const fontStep = stepBody('demo-posters', 'Install the poster font');
    expect(fontStep).toContain('set -euo pipefail');
    expect(fontStep).toContain('fc-match');
    expect(fontStep).toContain('::error::');
    expect(fontStep).toContain('exit 1');
    const family = fontStep.match(/^ {10}POSTER_FONT_FAMILY: (.+)$/m)?.[1]?.trim();
    expect(family, 'the font step names no POSTER_FONT_FAMILY').toBeDefined();

    // The app sets no UI font of its own, so its text is Tailwind's default --font-sans.
    const themeSource = fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'tailwindcss', 'theme.css'), 'utf8');
    const stackText = themeSource.match(/--font-sans:([^;]+);/)?.[1];
    expect(stackText, 'tailwindcss/theme.css no longer declares --font-sans').toBeDefined();
    const stack = (stackText ?? '').split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
    expect(stack).toContain(family);
    // Being in the stack is not enough. The family decides the face only while every entry ahead of
    // it is one a Linux runner cannot have, so a bump that puts system-ui or ui-sans-serif first
    // fails here and asks for a re-measure instead of shooting the runner's default face.
    expect(
      stack.slice(0, stack.indexOf(family ?? '')),
      'Tailwind changed the families ahead of the poster font; re-measure the posters on a runner',
    ).toEqual(['-apple-system', 'BlinkMacSystemFont', 'Segoe UI']);

    // ...which holds only while the renderer's CSS overrides neither the stack nor the body
    // font: every font-family it declares is a monospace one (the terminal and code blocks).
    const rendererDir = path.join(REPO_ROOT, 'src', 'renderer');
    const cssFiles = fs.readdirSync(rendererDir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.css'));
    expect(cssFiles).toContain('index.css');
    const rendererCss = cssFiles.map((name) => fs.readFileSync(path.join(rendererDir, name), 'utf8')).join('\n');
    expect(rendererCss).not.toMatch(/--font-sans\s*:/);
    expect(rendererCss).not.toMatch(/--default-font-family\s*:/);
    const fontFamilies = [...rendererCss.matchAll(/font-family:\s*([^;]+);/g)].map((match) => match[1]);
    expect(fontFamilies.length).toBeGreaterThan(0);
    for (const value of fontFamilies) expect(value).toMatch(/mono/);
  });
});

// v0.39.0 sat published and empty because its draft was published by hand while the three
// platform builds were still running. electron-builder uploads only into a DRAFT, so it skipped
// all 11 artifacts with `existing type not compatible with publishing type` and every build still
// exited 0. Two shapes in release.yml let that reach the end of the run, and both are pinned here.
describe('release.yml cannot build into a published release', () => {
  const draftStep = stepBody('create-draft-release', 'Create the draft release if absent');

  it('fails on a published-but-incomplete release instead of reusing it', () => {
    // The old code reused ANY existing release for the tag. That is the branch that let a
    // hand-published release swallow every upload, so the step must be able to fail.
    expect(draftStep).toContain('exit 1');
    // "Complete" has exactly one definition, the same one publish-release trusts. An asset
    // count reimplemented in bash here could drift away from the manifest.
    expect(draftStep).toContain('scripts/verify-release-assets.js');
    // The error has to name the recovery, since the symptom shows up three jobs downstream.
    expect(draftStep).toContain('gh release delete');
  });

  it('still reuses a draft, and still short-circuits a finished release', () => {
    // Both green paths are load-bearing: reusing a draft is the normal re-run, and passing over
    // an already-complete published release is the idempotent backfill publish-npm also allows.
    expect(draftStep).toMatch(/select\(\.draft\)/);
    expect(draftStep).toContain('A draft release already exists');
    expect(draftStep).toContain('carries every expected asset');
  });

  it('reports the create path too, not only the branches that found something', () => {
    // The other three branches echo because they are explaining a decision. Creating the draft
    // is the branch with no natural reason to say anything, so it is the one whose line goes
    // missing - and release-gates-fail-loudly.md requires a step that can no-op to state which
    // way it went, on every run.
    expect(draftStep).toContain('Created the draft release for $tag.');
  });

  it('names the three causes rather than asserting the destructive one', () => {
    // verify-release-assets.js exits 1 for an unreachable API and for a tag resolving to several
    // release objects, not only for a verified-incomplete one. The old single message asserted
    // "incomplete, so delete this tag", which is wrong in two of the three cases and wrong in
    // the direction that destroys a good release.
    expect(draftStep).toContain('cannot tell the three causes apart');
    expect(draftStep).toContain('re-run this workflow and delete nothing');
    expect(draftStep).toContain('delete the EXTRAS');
  });
});

// The upgrade gates have picked a wrong baseline twice, in two directions. Through v0.39.0 they
// read /releases/latest, which returns the release being built the moment anything publishes it,
// so a re-run upgraded a version from ITSELF: dnf/apt install the same package twice, the version
// assertion passes, and the run reports green while testing nothing. Through v0.40.0 they took the
// newest published tag that was not their own, so re-running v0.39.1 after v0.40.0 had shipped
// baselined on v0.40.0 and ran 0.40.0 -> 0.39.1: apt refused the downgrade (red, and correct),
// while dnf downgraded without complaint and `rpm -q kangentic-0.39.1` passed (green, and wrong).
// That is what the 2026-09-10 tag scrub did to v0.39.0 and v0.39.1, and it recurs on any full
// re-run of an older tag, which the release skill prescribes for recovery.
//
// The baseline is now the newest published release whose version is numerically LOWER than the
// build's. The program is pinned whole below AND executed against fixtures, because a string pin
// proves only that the text did not change, not that the rule is the one the incident needs.
const BASELINE_PROGRAM =
  "'def ver: ltrimstr(\"v\") | split(\".\") | map(tonumber); "
  + '[.[] | select(.draft == false and .prerelease == false) | '
  + 'select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) | '
  + 'select((.tag_name | ver) < ($self | ver))] | max_by(.tag_name | ver) | .tag_name // empty\'';

const IGNORED_TAGS_PROGRAM =
  "'[.[] | select(.draft == false and .prerelease == false) | "
  + 'select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$") | not) | .tag_name] | join(" ")\'';

// The first release of a new arch (linux-arm64 joined after x64 had shipped for many releases)
// has a baseline with no package in that arch. The skip counts the arch over every published
// release OLDER than the build, never over the baseline alone: once one carries the arch the skip
// can never fire again, so a later baseline missing its package (a hand-published partial release)
// fails instead of quietly skipping forever.
const ARCH_HISTORY_PROGRAM =
  "'def ver: ltrimstr(\"v\") | split(\".\") | map(tonumber); "
  + '[.[] | select(.draft == false and .prerelease == false) | '
  + 'select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) | '
  + 'select((.tag_name | ver) < ($self | ver)) | '
  + 'select(any(.assets[]?; .name | endswith($suffix)))] | length\'';

const upgradeSteps = [
  ['rpm', stepBody('release', 'Verify rpm upgrades from the previous release')],
  ['deb', stepBody('release', 'Verify deb upgrades from the previous release')],
] as const;

/** Per step: the --arg suffix it passes, and the arm64 and x64 asset names that suffix must tell apart. */
const ARCH_SUFFIXES = {
  rpm: { suffixArgument: '--arg suffix "-1.$RPM_ARCH.rpm"', arm64Suffix: '-1.aarch64.rpm', x64Suffix: '-1.x86_64.rpm', asset: (version: string, suffix: string) => `kangentic-${version}${suffix}` },
  deb: { suffixArgument: '--arg suffix "_$DEB_ARCH.deb"', arm64Suffix: '_arm64.deb', x64Suffix: '_amd64.deb', asset: (version: string, suffix: string) => `kangentic_${version}${suffix}` },
} as const;

describe('release.yml upgrade gates baseline on the newest release OLDER than the build', () => {
  it.each(upgradeSteps)('the %s gate resolves the baseline by version, below this build\'s own', (_name, body) => {
    // Resolved from the built artifact's version, so the comparison holds however the ref is spelled.
    expect(body).toContain('--arg self "v$new_version"');
    // The whole jq program, not a clause of it. `.draft == false` keeps the release under
    // construction out of its own baseline on the normal path, `.prerelease` keeps a beta out, the
    // regex gate keeps `tonumber` off a tag it cannot parse, `< ($self | ver)` is the older-than
    // rule this block exists for, and `max_by` is what makes it the NEWEST whatever order the API
    // lists releases in. Asserting fragments lets any of the others be dropped while the test
    // stays green.
    expect(body).toContain(BASELINE_PROGRAM);
  });

  it.each(upgradeSteps)('the %s gate names the published tags it could not compare', (_name, body) => {
    // The regex gate above drops a tag it cannot parse rather than aborting on it. Dropping is
    // the right call, and it is also exactly the kind of silent narrowing this rule forbids, so
    // the step has to say which tags it ignored, on every run where it ignored any.
    expect(body).toContain(IGNORED_TAGS_PROGRAM);
    expect(body).toContain('Ignoring published release(s) whose tag is not a plain vX.Y.Z');
  });

  it.each(upgradeSteps)('the %s gate rejects a built version it cannot compare numerically', (_name, body) => {
    // The API tags get the regex gate; the build's own version cannot be dropped the same way,
    // because dropping it would leave nothing to compare against and skip the gate. It is
    // asserted instead. Without this the step still fails on a non-triple version, but on jq's
    // raw "Cannot parse" text, which names neither the version nor the step that produced it.
    expect(body).toContain("grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
    // Anchored to the echo line, not the bare phrase, for the same reason as the
    // /releases/latest test below: the comments around this guard discuss the shape it rejects,
    // and a phrase-only pin would stay green against a step that kept the comment and lost the
    // exit.
    expect(body).toMatch(/echo "::error::Built version '\$new_version' is not a plain X\.Y\.Z/);
  });

  it.each(upgradeSteps)('the %s gate reads the release LIST, not /releases/latest', (_name, body) => {
    // Anchored to the request line rather than the whole body: the comments above each step
    // explain the old endpoint on purpose, and must not trip this.
    expect(body).toMatch(/releases\?per_page=100"\)/);
    expect(body).not.toMatch(/releases\/latest"\)/);
  });

  it.each(upgradeSteps)('the %s gate still fails rather than skips on a transport failure', (_name, body) => {
    // Only "no published release older than this one" may skip. A 403 from the shared runner IP
    // used to be the way this went quiet.
    expect(body).toContain('Refusing to skip the upgrade check on a transport failure');
    expect(body).toMatch(/No published release older than v\$new_version/);
  });

  it.each(upgradeSteps)('the %s gate says how many releases it saw when it skips', (_name, body) => {
    // The skip is the one green path here, and an empty filter result has two causes the step
    // cannot separate: no baseline exists yet, or the filter is broken against a full history.
    // jq answers null for an unknown field rather than erroring, so a later typo in .draft or
    // .tag_name would skip every release from then on and still report green. The count is what
    // makes the log able to tell them apart.
    expect(body).toContain("jq 'length' /tmp/releases.json");
  });

  it.each(upgradeSteps)('the %s gate skips a first-arch release only by the arch history, and says so', (name, body) => {
    expect(body).toContain(ARCH_HISTORY_PROGRAM);
    expect(body).toContain(ARCH_SUFFIXES[name].suffixArgument);
    // Both branches say which way they went.
    expect(body).toMatch(/echo "No published release older than v\$new_version carries an \$(RPM|DEB)_ARCH (rpm|deb), so v\$new_version is the first/);
    expect(body).toMatch(/echo "\$arch_releases published release\(s\) older than v\$new_version carry an \$(RPM|DEB)_ARCH (rpm|deb); upgrading from \$prev_tag\."/);
    // After the no-baseline skip and before the download, so a baseline missing its package in an
    // arch that HAS shipped still reaches the download's failure.
    const historyAt = body.indexOf('arch_releases=$(');
    expect(historyAt).toBeGreaterThan(body.indexOf('if [ -z "$prev_tag" ]; then'));
    expect(historyAt).toBeLessThan(body.indexOf('if ! curl -fsSL'));
  });
});

// The pins above prove the text. This block proves the rule, by running the program the workflow
// actually carries through a real jq against release lists shaped like the incidents. jq is
// preinstalled on ubuntu-latest, where CI's unit job runs (and where release.yml itself calls it
// with no install step); a developer machine without it gets the skip notice below rather than a
// silent pass.
const HAS_JQ = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const RUNNING_ON_CI = Boolean(process.env.CI);

interface ReleaseRow {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets?: { name: string }[];
}

function published(tagName: string, assetNames: string[] = []): ReleaseRow {
  return { tag_name: tagName, draft: false, prerelease: false, assets: assetNames.map((assetName) => ({ name: assetName })) };
}

/**
 * The single-quoted jq program out of a step's `<assignment>jq -r ... '<program>' /tmp/releases.json)`
 * command substitution, with the bash quotes stripped so it can be handed to jq as one argument.
 *
 * Throws on a miss, and throws on a program missing its load-bearing operator, for the same reason
 * stepBody throws: a stale regex that returned '' or a fragment would hand jq an identity filter,
 * and an identity filter over these fixtures prints something rather than failing outright.
 */
function extractProgram(body: string, assignment: string, loadBearingOperator: string): string {
  const escaped = assignment.replace(/[$()]/g, '\\$&');
  const match = body.match(new RegExp(`${escaped}jq -r[^\\n]*\\\\\\n\\s*'([^']+)' \\\\\\n\\s*/tmp/releases\\.json\\)`));
  if (!match) {
    throw new Error(`Could not find the ${assignment} jq program in the step body; the extraction regex is stale.`);
  }
  if (!match[1].includes(loadBearingOperator)) {
    throw new Error(`The ${assignment} jq program no longer contains "${loadBearingOperator}"; the extraction caught a fragment.`);
  }
  return match[1];
}

function runJq(program: string, releases: ReleaseRow[], jqArguments: string[]): string {
  return execFileSync('jq', ['-r', ...jqArguments, program], {
    input: JSON.stringify(releases),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

describe.runIf(HAS_JQ)('release.yml upgrade baseline program, executed', () => {
  const programs = upgradeSteps.map(([name, body]) => [
    name,
    extractProgram(body, 'prev_tag=$(', 'max_by'),
    extractProgram(body, 'ignored_tags=$(', '| not'),
  ] as const);

  const baselineFor = (program: string, self: string, releases: ReleaseRow[]): string =>
    runJq(program, releases, ['--arg', 'self', self]);

  it.each(programs)('the %s gate re-run of v0.39.1 after v0.40.0 shipped upgrades FROM v0.39.0', (_name, program) => {
    // The incident. The old rule returned v0.40.0 here and the gate downgraded.
    const releases = [published('v0.40.0'), published('v0.39.1'), published('v0.39.0')];
    expect(baselineFor(program, 'v0.39.1', releases)).toBe('v0.39.0');
  });

  it.each(programs)('the %s gate normal path still picks the newest shipped release', (_name, program) => {
    const releases = [published('v0.40.0'), published('v0.39.1'), published('v0.39.0')];
    expect(baselineFor(program, 'v0.41.0', releases)).toBe('v0.40.0');
  });

  it.each(programs)('the %s gate compares versions numerically, not as text', (_name, program) => {
    // "v0.9.1" sorts ABOVE "v0.10.0" as a string, which would make v0.10.0 skip its upgrade check
    // with "no older release" while nine of them exist.
    const releases = [published('v0.9.1'), published('v0.9.0')];
    expect(baselineFor(program, 'v0.10.0', releases)).toBe('v0.9.1');
  });

  it.each(programs)('the %s gate does not depend on the order the API lists releases in', (_name, program) => {
    // The documented recovery (gh release delete, then a full re-run) re-creates the release
    // object for an OLD tag, and the list endpoint orders by object creation, so that old
    // release sits first. `[0]` would have handed it to the next build as the baseline.
    const releases = [published('v0.39.0'), published('v0.40.0'), published('v0.39.1')];
    expect(baselineFor(program, 'v0.41.0', releases)).toBe('v0.40.0');
  });

  it.each(programs)('the %s gate skips drafts, prereleases, and tags it cannot parse, and names the last', (_name, program, ignoredProgram) => {
    // v0.41.0-rc1 carries no prerelease flag and protocol-v1.2.0 is not a desktop version at all.
    // Either would throw inside tonumber and abort the step if the regex gate were not in front of
    // it. Both are reported by the companion program rather than dropped in silence.
    const releases = [
      { tag_name: 'v0.41.0', draft: true, prerelease: false },
      { tag_name: 'v0.40.1', draft: false, prerelease: true },
      published('v0.41.0-rc1'),
      published('protocol-v1.2.0'),
      published('v0.40.0'),
      published('v0.39.1'),
    ];
    expect(baselineFor(program, 'v0.41.0', releases)).toBe('v0.40.0');
    expect(runJq(ignoredProgram, releases, [])).toBe('v0.41.0-rc1 protocol-v1.2.0');
  });

  it.each(programs)('the %s gate returns nothing for the first release ever, which is the one green skip', (_name, program) => {
    const releases = [published('v0.40.0'), published('v0.1.0')];
    expect(baselineFor(program, 'v0.1.0', releases)).toBe('');
  });
});

describe.runIf(HAS_JQ)('release.yml first-arch upgrade skip, executed', () => {
  const cases = upgradeSteps.map(([name, body]) => [
    name,
    extractProgram(body, 'arch_releases=$(', 'endswith($suffix)'),
    ARCH_SUFFIXES[name],
  ] as const);

  const olderWithArch = (program: string, self: string, suffix: string, releases: ReleaseRow[]): string =>
    runJq(program, releases, ['--arg', 'self', self, '--arg', 'suffix', suffix]);

  it.each(cases)('the %s gate skips the first arm64 release, whose baseline predates arm64', (_name, program, names) => {
    const releases = [
      published('v0.45.0', [names.asset('0.45.0', names.x64Suffix)]),
      published('v0.44.0', [names.asset('0.44.0', names.x64Suffix)]),
    ];
    expect(olderWithArch(program, 'v0.46.0', names.arm64Suffix, releases)).toBe('0');
  });

  it.each(cases)('the %s gate still skips a re-run of that first arm64 release after it shipped', (_name, program, names) => {
    // Counted over releases OLDER than the build: the published first arm64 release carries arm64
    // itself, and counting it would turn its own re-run red against a baseline that never had it.
    const releases = [
      published('v0.46.0', [names.asset('0.46.0', names.x64Suffix), names.asset('0.46.0', names.arm64Suffix)]),
      published('v0.45.0', [names.asset('0.45.0', names.x64Suffix)]),
    ];
    expect(olderWithArch(program, 'v0.46.0', names.arm64Suffix, releases)).toBe('0');
  });

  it.each(cases)('the %s gate does NOT skip once arm64 has shipped, even past a baseline missing it', (_name, program, names) => {
    // v0.47.0 was published without its arm64 package. The baseline for v0.48.0 is v0.47.0, its
    // download fails, and the step goes red, which is the point: the skip cannot reach this.
    const releases = [
      published('v0.47.0', [names.asset('0.47.0', names.x64Suffix)]),
      published('v0.46.0', [names.asset('0.46.0', names.x64Suffix), names.asset('0.46.0', names.arm64Suffix)]),
    ];
    expect(olderWithArch(program, 'v0.48.0', names.arm64Suffix, releases)).toBe('1');
  });

  it.each(cases)('the %s gate never skips on x64, whose every release carries the arch', (_name, program, names) => {
    const releases = [
      published('v0.45.0', [names.asset('0.45.0', names.x64Suffix)]),
      published('v0.44.0', [names.asset('0.44.0', names.x64Suffix)]),
    ];
    expect(olderWithArch(program, 'v0.46.0', names.x64Suffix, releases)).toBe('2');
  });

  it.each(cases)('the %s gate counts no draft or prerelease as having shipped the arch', (_name, program, names) => {
    const releases = [
      { ...published('v0.46.0', [names.asset('0.46.0', names.arm64Suffix)]), draft: true },
      { ...published('v0.45.1', [names.asset('0.45.1', names.arm64Suffix)]), prerelease: true },
      published('v0.45.0', [names.asset('0.45.0', names.x64Suffix)]),
    ];
    expect(olderWithArch(program, 'v0.47.0', names.arm64Suffix, releases)).toBe('0');
  });

  it.each(cases)('the %s gate tells the arches apart by suffix, not by a substring', (_name, program, names) => {
    // An x64 package must not count as arm64 history, nor the reverse.
    const releases = [published('v0.45.0', [names.asset('0.45.0', names.x64Suffix)])];
    expect(olderWithArch(program, 'v0.46.0', names.arm64Suffix, releases)).toBe('0');
  });

  // The x64 case above cannot catch endswith decaying to contains or test: neither arch suffix is a
  // substring of the other. A sidecar of an arm64 package (a signature, a blockmap) CONTAINS the
  // suffix without ENDING with it, and must not count as a release that shipped the arch.
  it.each(cases)('the %s gate does not count a file that only contains the arm64 suffix', (_name, program, names) => {
    const releases = [
      published('v0.45.0', [
        names.asset('0.45.0', names.x64Suffix),
        `${names.asset('0.45.0', names.arm64Suffix)}.sig`,
        `${names.asset('0.45.0', names.arm64Suffix)}.blockmap`,
      ]),
    ];
    expect(olderWithArch(program, 'v0.46.0', names.arm64Suffix, releases)).toBe('0');
  });
});

describe.runIf(!HAS_JQ)('release.yml upgrade baseline program, executed (skipped)', () => {
  it('skipped - jq is not on PATH; CI runs this on ubuntu-latest where it is preinstalled', () => {
    expect(HAS_JQ).toBe(false);
  });
});

// A local machine without jq may skip the executed block; CI may not. The comment above HAS_JQ
// rests on ubuntu-latest shipping jq, and if that ever stops being true the six behavioural cases
// go uncollected and the file still reports green - the "reads as coverage but is not" shape this
// whole file exists to forbid. Nothing above can catch it, because the only assertion on HAS_JQ
// lives in the branch that runs when it is already false. This is the check that makes the
// comment binding, for the same reason the five-job list above pins its own filter.
describe.runIf(RUNNING_ON_CI)('release.yml upgrade baseline program, executed (CI invariant)', () => {
  it('finds jq on PATH, so CI never skips the executed block', () => {
    expect(HAS_JQ).toBe(true);
  });
});

// package-smoke.yml packages the app on the runners the release legs use, so a packaged build is
// launched before a tag exists. A runner the release gains and this workflow lacks is a platform
// whose first packaged launch happens after the tag, which is the gap the workflow was added to
// close. Its path filter has the mirror hazard: build/afterPack.js reads
// src/shared/embedding-runtime-gaps.json to decide whether a missing embed runtime is a known gap
// or a packaging fault, so an edit to that file changes the packaged result and must trigger the
// smoke run.
//
// Both reads go through a function that throws on a miss, and the runner lists are also pinned to
// a literal five entries. Two regexes that broke the same way would both return [] and an equality
// between them would pass with nothing checked.
const SMOKE_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'package-smoke.yml');
const smokeWorkflowSource = fs.readFileSync(SMOKE_WORKFLOW_PATH, 'utf8');

const RELEASE_RUNNERS = ['ubuntu-latest', 'ubuntu-24.04-arm', 'windows-latest', 'macos-latest', 'macos-26-intel'];

/** The `os:` of each matrix leg in a job body. Legs open with `- os: <runner>` at ten spaces. */
function matrixRunners(workflowName: string, jobBody: string): string[] {
  const runners = [...jobBody.matchAll(/^ {10}- os: (\S+)$/gm)].map((match) => match[1]);
  if (runners.length === 0) {
    throw new Error(`${workflowName} has no matrix legs at the indentation this test reads (was the matrix reshaped?)`);
  }
  return runners;
}

/** The `pull_request` path filter, entry by entry. */
function smokePathFilter(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '    paths:');
  if (start === -1) {
    throw new Error('package-smoke.yml has no pull_request `paths:` filter at four spaces (was it moved?)');
  }
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = line.match(/^ {6}- '(.+)'$/);
    if (!entry) break;
    entries.push(entry[1]);
  }
  return entries;
}

describe('package-smoke.yml mirrors the release workflow', () => {
  const smokeBody = parseJobs(smokeWorkflowSource).find((job) => job.name === 'smoke')?.body ?? '';
  const releaseBody = jobs.find((job) => job.name === 'release')?.body ?? '';

  it('packages on exactly the runners the release legs build on', () => {
    const smokeRunners = matrixRunners('package-smoke.yml', smokeBody);
    const releaseRunners = matrixRunners('release.yml', releaseBody);
    expect([...smokeRunners].sort()).toEqual([...releaseRunners].sort());
    // The literal list keeps the equality above from passing on two lists that shrank together.
    expect([...smokeRunners].sort()).toEqual([...RELEASE_RUNNERS].sort());
  });

  it('re-runs when the embedding runtime gap list changes', () => {
    expect(smokePathFilter(smokeWorkflowSource)).toContain('src/shared/embedding-runtime-gaps.json');
  });
});

// Every assertion above reaches its subject through stepBody, so a stepBody that silently returns
// the wrong text turns this whole file into passes that check nothing. Its two guards exist for
// that, which means the guards themselves are worth a test.
describe('stepBody keeps the assertions above honest', () => {
  it('throws on a step name that is no longer in the workflow', () => {
    // The failure this prevents: a renamed step yields no match, stepBody hands back '', and
    // every toContain above it passes against the empty string.
    expect(() => stepBody('create-draft-release', 'Renamed away at some point')).toThrow(
      /was it renamed/
    );
  });

  it('ends a step body at the next step instead of absorbing it', () => {
    // The rpm gate is immediately followed by the deb gate, so these two are what a stale
    // boundary regex would fuse. Fused, each `not.toContain` in this file would be asserting
    // against both steps at once and would still pass.
    expect(stepBody('release', 'Verify rpm upgrades from the previous release')).not.toContain(
      'Verify deb upgrades'
    );
  });

  it('ends the LAST step of a job at the next job, not at the end of the body', () => {
    // The case the `- name:` guard structurally cannot catch. The deb gate is the last step in
    // `release`, so there is no following step to stop at, and the text that follows it is
    // publish-release's comment header - which contains no `- name:` for the guard to see.
    // Unbounded, every negative assertion on the deb gate is quietly reading another job.
    expect(stepBody('release', 'Verify deb upgrades from the previous release')).not.toContain(
      'Publish the draft release'
    );
  });

  // extractProgram feeds the executed block, so it carries the same hazard: returning '' or a
  // fragment on a stale regex would hand jq an identity filter and let the rule's own test pass
  // against the wrong program.
  it('extractProgram throws on an assignment that is not in the step', () => {
    expect(() => extractProgram(upgradeSteps[0][1], 'renamed_away=$(', 'max_by')).toThrow(
      /extraction regex is stale/
    );
  });

  it('extractProgram throws when the program it found lacks its load-bearing operator', () => {
    // A body shaped exactly like the workflow's, with the program cut down to a fragment that
    // would still run under jq (and print every tag name, rather than nothing).
    const fragmentBody = [
      '          prev_tag=$(jq -r --arg self "v$new_version" \\',
      "            '[.[] | .tag_name][0] // empty' \\",
      '            /tmp/releases.json)',
    ].join('\n');
    expect(() => extractProgram(fragmentBody, 'prev_tag=$(', 'max_by')).toThrow(
      /caught a fragment/
    );
  });
});
