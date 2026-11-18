/**
 * Checks that the browser sign-ins Kangentic ships still work: Trello, Jira,
 * Linear and GitLab. .github/workflows/integrations.yml runs it every day and on
 * a pull request that changes a value it reads, and `npm run check:integrations`
 * runs it by hand. It holds no secret and needs no install. Every probe is a
 * request a stranger could make, and none of them signs anyone in.
 *
 * It checks the values this checkout ships, read from the source text of the
 * files in SOURCE_FILES. It cannot import them. It runs before any install, and
 * they import each other without a file extension. A constant that is gone or
 * written another way fails the run, and tests/unit/check-integrations.test.ts
 * holds every value read here equal to what the real module exports.
 *
 * A sign-in whose id is empty is not shipped yet. Its checks report as pending
 * and do not fail the run, so the summary doubles as the list of owner steps
 * left. Set TRELLO_API_KEY, JIRA_OAUTH_CLIENT_ID, LINEAR_OAUTH_CLIENT_ID or
 * GITLAB_COM_OAUTH_CLIENT_ID in the environment to check a value before it is
 * committed, and DOCS_BASE_URL to point the page checks at another origin, such
 * as a preview deployment. An empty variable counts as unset, so it can never
 * turn a shipped id's checks into pending ones.
 *
 * The probes. Each answer was seen against the live service on 2026-11-17,
 * except the three marked "not yet seen" below. The answers a stranger can get
 * today are recorded in tests/fixtures/sign-in-check-live-answers.json.
 * - Trello key: with a key and no token, Trello's API answers 400 "invalid
 *   token" for a live key and 401 "invalid key" for one it does not know.
 * - Trello origin: signed out, Trello's approval page answers 200 when the key
 *   allows the return page's origin, 400 "Invalid return_url" when it does not,
 *   and 404 for a key it does not know.
 * - Trello return page: the served script and style must hash to the values in
 *   the page's own Content-Security-Policy, or a browser runs nothing and the
 *   desktop waits until it times out. An edge rewrite shows up here.
 * - Jira callback: a bad state gets a 400, and a good one with no code is sent
 *   to the loopback with `error=invalid_request`, without calling Atlassian.
 * - Jira token service: a made-up refresh token sent through the refresh route.
 *   500 `server_error` means the Pages secrets are not set. With them set,
 *   Atlassian's docs name `invalid_grant` for a refresh token it will not take,
 *   so that answer means Atlassian accepted the client. Developers also report
 *   `unauthorized_client` with the description "refresh_token is invalid" for
 *   the same case, so that pair passes too, and the same code with any other
 *   description is a refused client. Neither has been seen with a real client.
 *   The first run after the secrets are set shows which one Atlassian sends.
 * - Linear client: a made-up code exchanged for the shipped client id. Linear
 *   answers `invalid_client` for a client it does not know, which was seen. A
 *   known client should get as far as `invalid_grant`, not yet seen. The check
 *   never uses the refresh grant, which answers `invalid_grant` for a made-up
 *   client too.
 * - GitLab client: a made-up code exchanged at gitlab.com for the shipped client
 *   id, with the form `exchangeGitLabAuthorizationCode` sends. gitlab.com
 *   answers 401 `invalid_client` for a client it does not know, which was seen.
 *   A known client should get as far as `invalid_grant`, not yet seen.
 *
 * Any answer not named above fails its check, and so does no answer at all.
 *
 * Exits 1 when any check fails. In GitHub Actions it also writes the step
 * summary, an `::error` annotation per failure and a `::notice` per pending
 * check.
 */
import { createECDH, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';
import {
  annotationLines,
  exitCodeFor,
  markdownCell,
  messageOf,
  result,
  sendRequest,
  singleLine,
  snippet,
  summaryTable,
  tableLines,
} from './lib/check-report.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAME = 'scripts/check-integrations.mjs';

const DOCS_LINKS_FILE = 'src/shared/docs-links.ts';
const LOOPBACK_FILE = 'src/main/boards/shared/loopback-sign-in.ts';
const TRELLO_FILE = 'src/main/boards/adapters/trello/constants.ts';
const JIRA_FILE = 'src/main/boards/adapters/jira/constants.ts';
const LINEAR_FILE = 'src/main/boards/adapters/linear/constants.ts';
const GITLAB_FILE = 'src/main/boards/adapters/gitlab/constants.ts';

/** Every file a value is read from. The workflow's path filter names each of them. */
const SOURCE_FILES = [DOCS_LINKS_FILE, LOOPBACK_FILE, TRELLO_FILE, JIRA_FILE, LINEAR_FILE, GITLAB_FILE];

/** Trello's approval page. The desktop spells it out inside `buildAuthorizeUrl`. */
const TRELLO_AUTHORIZE_URL = 'https://trello.com/1/authorize';
/** gitlab.com's token route, under `GITLAB_COM_BASE`. The desktop spells it out inside `postTokenForm`. */
const GITLAB_TOKEN_PATH = '/oauth/token';
/**
 * How Atlassian describes a refresh token it will not take when it answers `unauthorized_client`
 * and not `invalid_grant`. Developers report "refresh_token is invalid" for a healthy client.
 */
const REFUSED_REFRESH_TOKEN = /refresh[_ ]token is invalid/i;

const PROBE = 'kangentic-integration-check';
/** A loopback port for the state. Nothing listens on it, and nothing here follows a redirect. */
const STATE_PORT = 43123;
/** The desktop's nonce length (`NONCE_BYTES` in sealed-token.ts). */
const STATE_NONCE_BYTES = 32;

/** @typedef {import('./lib/check-report.mjs').Result} Result */
/** @typedef {import('./lib/check-report.mjs').SendRequest} SendRequest */
/** @typedef {{ value: string, source: string }} ShippedId */
/**
 * @typedef {object} ShippedValues
 * @property {string} site The docs site's origin, with no trailing slash.
 * @property {ShippedId} trelloKey
 * @property {ShippedId} jiraClientId
 * @property {ShippedId} linearClientId
 * @property {ShippedId} gitlabClientId
 * @property {string} trelloApiBase
 * @property {string} trelloReturnUrl
 * @property {string} jiraCallbackUrl
 * @property {string} jiraRefreshUrl
 * @property {string} jiraLoopbackPath
 * @property {string} loopbackHost
 * @property {string} linearTokenUrl
 * @property {string} linearRedirectUri
 * @property {string} gitlabTokenUrl
 * @property {string} gitlabRedirectUri
 */

// ---------------------------------------------------------------------------
// The values this checkout ships
// ---------------------------------------------------------------------------

function readSource(repoRoot, file) {
  let text;
  try {
    text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  } catch (problem) {
    if (problem?.code === 'ENOENT') {
      throw new Error(`${file} is gone. Update ${SCRIPT_NAME} to read its constants where they went.`, { cause: problem });
    }
    throw new Error(`${file} could not be read (${problem?.code ?? 'no error code'}).`, { cause: problem });
  }
  return text.replace(/\r\n/g, '\n');
}

function moved(name, file, shape) {
  return new Error(`${name} is no longer ${shape} in ${file}. Update ${SCRIPT_NAME} to read it where it went.`);
}

/** The text between `export const NAME = ` and the `;` that ends its line. */
function declarationOf(source, file, name, shape) {
  const match = new RegExp(`^export const ${name}(?:: [^=\\n]+)? = (.+);$`, 'm').exec(source);
  if (!match) throw moved(name, file, shape);
  return match[1];
}

function stringConstant(source, file, name) {
  const shape = 'a quoted string';
  const match = /^'([^'\\]*)'$/.exec(declarationOf(source, file, name, shape));
  if (!match) throw moved(name, file, shape);
  return match[1];
}

function numberListConstant(source, file, name) {
  const shape = 'a list of numbers';
  const match = /^\[(\d+(?:, ?\d+)*)\]$/.exec(declarationOf(source, file, name, shape));
  if (!match) throw moved(name, file, shape);
  return match[1].split(',').map((item) => Number(item.trim()));
}

/** The path of a constant written as `${DOCS_BASE_URL}/path`. */
function sitePathConstant(source, file, name) {
  const shape = 'a path on DOCS_BASE_URL';
  const match = /^`\$\{DOCS_BASE_URL\}(\/[^`$]*)`$/.exec(declarationOf(source, file, name, shape));
  if (!match) throw moved(name, file, shape);
  return match[1];
}

/**
 * Everything the probes need, read from `repoRoot`. Throws when a constant is
 * gone or written another way, naming it and its file.
 *
 * @param {string} [repoRoot]
 * @param {Record<string, string | undefined>} [env]
 * @returns {ShippedValues}
 */
function readShippedValues(repoRoot = REPO_ROOT, env = process.env) {
  const docsLinks = readSource(repoRoot, DOCS_LINKS_FILE);
  const loopback = readSource(repoRoot, LOOPBACK_FILE);
  const trello = readSource(repoRoot, TRELLO_FILE);
  const jira = readSource(repoRoot, JIRA_FILE);
  const linear = readSource(repoRoot, LINEAR_FILE);
  const gitlab = readSource(repoRoot, GITLAB_FILE);

  // The constant is read even when the environment overrides it, so a moved one never hides behind an override.
  const overridable = (source, file, name) => {
    const shippedValue = stringConstant(source, file, name);
    const override = env[name]?.trim();
    return override ? { value: override, source: 'the environment' } : { value: shippedValue, source: file };
  };

  const site = overridable(docsLinks, DOCS_LINKS_FILE, 'DOCS_BASE_URL').value.replace(/\/+$/, '');

  if (declarationOf(linear, LINEAR_FILE, 'LINEAR_OAUTH_REDIRECT_HOST', 'LOOPBACK_HOST') !== 'LOOPBACK_HOST') {
    throw moved('LINEAR_OAUTH_REDIRECT_HOST', LINEAR_FILE, 'LOOPBACK_HOST');
  }
  const loopbackHost = stringConstant(loopback, LOOPBACK_FILE, 'LOOPBACK_HOST');
  const redirectPorts = numberListConstant(linear, LINEAR_FILE, 'LINEAR_OAUTH_REDIRECT_PORTS');
  const redirectPath = stringConstant(linear, LINEAR_FILE, 'LINEAR_OAUTH_REDIRECT_PATH');

  return {
    site,
    trelloKey: overridable(trello, TRELLO_FILE, 'TRELLO_API_KEY'),
    jiraClientId: overridable(jira, JIRA_FILE, 'JIRA_OAUTH_CLIENT_ID'),
    linearClientId: overridable(linear, LINEAR_FILE, 'LINEAR_OAUTH_CLIENT_ID'),
    trelloApiBase: stringConstant(trello, TRELLO_FILE, 'TRELLO_API_BASE'),
    trelloReturnUrl: site + sitePathConstant(trello, TRELLO_FILE, 'TRELLO_RETURN_URL'),
    jiraCallbackUrl: site + sitePathConstant(jira, JIRA_FILE, 'JIRA_OAUTH_REDIRECT_URI'),
    jiraRefreshUrl: site + sitePathConstant(jira, JIRA_FILE, 'JIRA_OAUTH_REFRESH_URL'),
    jiraLoopbackPath: stringConstant(jira, JIRA_FILE, 'JIRA_OAUTH_CALLBACK_PATH'),
    loopbackHost,
    linearTokenUrl: stringConstant(linear, LINEAR_FILE, 'LINEAR_OAUTH_TOKEN_URL'),
    // The first registered port, as `redirectUriFor` in linear/oauth.ts builds it.
    linearRedirectUri: `http://${loopbackHost}:${redirectPorts[0]}${redirectPath}`,
    gitlabClientId: overridable(gitlab, GITLAB_FILE, 'GITLAB_COM_OAUTH_CLIENT_ID'),
    gitlabTokenUrl: stringConstant(gitlab, GITLAB_FILE, 'GITLAB_COM_BASE') + GITLAB_TOKEN_PATH,
    // GitLab ignores a loopback redirect's port, and the desktop sends whichever port is free, in
    // the shape `signInWithGitLab` in gitlab/oauth.ts builds. The state's port stands in for it here.
    gitlabRedirectUri: `http://${stringConstant(gitlab, GITLAB_FILE, 'GITLAB_OAUTH_REDIRECT_HOST')}:${STATE_PORT}${stringConstant(gitlab, GITLAB_FILE, 'GITLAB_OAUTH_REDIRECT_PATH')}`,
  };
}

// ---------------------------------------------------------------------------
// What the desktop sends
// ---------------------------------------------------------------------------

/**
 * A state the return page and the Jira callback accept: the shape
 * `createSealedSignInKeys().stateFor(port)` sends, for a port nothing listens on.
 */
function signInState() {
  const ecdh = createECDH('prime256v1');
  const publicKey = ecdh.generateKeys().toString('base64url');
  const nonce = randomBytes(STATE_NONCE_BYTES).toString('base64url');
  const value = Buffer.from(JSON.stringify({ port: STATE_PORT, pub: publicKey, nonce }), 'utf8').toString('base64url');
  return { value, nonce, port: STATE_PORT };
}

/** The return page's address for one state, as `buildTrelloReturnUrl` builds it. */
function trelloReturnPageUrl(values, state) {
  const url = new URL(values.trelloReturnUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

/** Trello's approval page for Kangentic's key, as `buildAuthorizeUrl` builds it with a return state. */
function trelloAuthorizeUrl(values, apiKey, state) {
  const params = new URLSearchParams();
  params.set('key', apiKey);
  params.set('name', 'Kangentic');
  params.set('scope', 'read');
  params.set('expiration', 'never');
  params.set('response_type', 'token');
  params.set('return_url', trelloReturnPageUrl(values, state));
  params.set('callback_method', 'fragment');
  return `${TRELLO_AUTHORIZE_URL}?${params.toString()}`;
}

function sha256(text) {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/** The OAuth `error` code and `error_description` of a JSON answer, each '' when the answer is not JSON or carries none. */
async function errorOf(answer) {
  // A body that is not JSON reads as no code, which every caller fails on.
  const body = await answer.json().catch(() => ({}));
  return {
    code: typeof body?.error === 'string' ? snippet(body.error) : '',
    description: typeof body?.error_description === 'string' ? snippet(body.error_description) : '',
  };
}

/** The OAuth `error` code of a JSON answer, or '' when the answer is not JSON or carries none. */
async function errorCodeOf(answer) {
  return (await errorOf(answer)).code;
}

/** @returns {Result} */
function unexpectedAnswer(area, check, answer, code) {
  return result(area, check, 'fail', `unexpected answer ${answer.status} ${code || 'with no error code'}`);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * @param {ShippedValues} values
 * @param {SendRequest} send
 * @returns {Promise<Result[]>}
 */
async function checkTrelloPage(values, send) {
  const area = 'trello';
  const check = 'return page';
  try {
    const good = await send(trelloReturnPageUrl(values, signInState().value));
    const html = await good.text();
    const policy = good.headers.get('content-security-policy') ?? '';
    if (good.status !== 200) return [result(area, check, 'fail', `${values.trelloReturnUrl} answered ${good.status}`)];
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    if (script === undefined || style === undefined) return [result(area, check, 'fail', 'the page has no inline script or style')];
    const broken = [];
    if (!policy.includes(`script-src '${sha256(script)}'`)) broken.push('script');
    if (!policy.includes(`style-src '${sha256(style)}'`)) broken.push('style');
    if (broken.length > 0) {
      return [result(area, check, 'fail', `the served ${broken.join(' and ')} no longer match the page's CSP hash, so browsers will block them`)];
    }
    const bad = await send(trelloReturnPageUrl(values, 'bad'));
    if (bad.status !== 400) return [result(area, check, 'fail', `a bad state answered ${bad.status}, not 400`)];
    return [result(area, check, 'ok', 'serves the page, its script and style match its CSP, and a bad state gets a 400')];
  } catch (problem) {
    return [result(area, check, 'fail', `no answer from ${values.site}: ${messageOf(problem)}`)];
  }
}

/**
 * @param {ShippedValues} values
 * @param {SendRequest} send
 * @returns {Promise<Result[]>}
 */
async function checkTrelloKey(values, send) {
  const area = 'trello';
  const key = values.trelloKey;
  if (!key.value) {
    return [
      result(area, 'api key', 'pending', `TRELLO_API_KEY is empty in ${key.source}, so Sign in with Trello is not shipped`),
      result(area, 'allowed origin', 'pending', 'no key to check yet'),
    ];
  }

  const results = [];
  try {
    const answer = await send(`${values.trelloApiBase}/members/me?key=${encodeURIComponent(key.value)}`);
    const text = (await answer.text()).trim();
    if (answer.status === 400 && text === 'invalid token') {
      results.push(result(area, 'api key', 'ok', `Trello knows the key from ${key.source}`));
    } else if (answer.status === 401 && text === 'invalid key') {
      results.push(result(area, 'api key', 'fail', `Trello no longer knows the key from ${key.source}`));
    } else {
      results.push(result(area, 'api key', 'fail', `unexpected answer ${answer.status} "${snippet(text)}"`));
    }
  } catch (problem) {
    results.push(result(area, 'api key', 'fail', `no answer from Trello's API: ${messageOf(problem)}`));
  }

  try {
    const answer = await send(trelloAuthorizeUrl(values, key.value, signInState().value));
    const text = await answer.text();
    if (answer.status === 200) {
      results.push(result(area, 'allowed origin', 'ok', `the key allows ${values.site}`));
    } else if (answer.status === 400 && text.includes('Invalid return_url')) {
      results.push(result(area, 'allowed origin', 'fail', `${values.site} is not an allowed origin on the key`));
    } else if (answer.status === 404) {
      results.push(result(area, 'allowed origin', 'fail', "Trello's approval page does not know the key (404)"));
    } else {
      results.push(result(area, 'allowed origin', 'fail', `unexpected answer ${answer.status} from Trello's approval page`));
    }
  } catch (problem) {
    results.push(result(area, 'allowed origin', 'fail', `no answer from Trello's approval page: ${messageOf(problem)}`));
  }
  return results;
}

/**
 * @param {ShippedValues} values
 * @param {SendRequest} send
 * @returns {Promise<Result[]>}
 */
async function checkJiraCallback(values, send) {
  const area = 'jira';
  const check = 'callback';
  try {
    const bad = await send(`${values.jiraCallbackUrl}?state=bad`);
    if (bad.status !== 400) return [result(area, check, 'fail', `a bad state answered ${bad.status}, not 400`)];
    const probe = signInState();
    const answer = await send(`${values.jiraCallbackUrl}?state=${probe.value}`);
    const location = answer.headers.get('location') ?? '';
    const target = URL.canParse(location) ? new URL(location) : null;
    const loopback =
      answer.status === 302 &&
      target !== null &&
      target.origin === `http://${values.loopbackHost}:${probe.port}` &&
      target.pathname === values.jiraLoopbackPath &&
      target.searchParams.get('error') === 'invalid_request' &&
      target.searchParams.get('nonce') === probe.nonce;
    if (loopback) return [result(area, check, 'ok', 'checks the state and redirects only to the loopback')];
    return [result(area, check, 'fail', `a good state with no code answered ${answer.status} ${location ? snippet(location) : 'with no Location'}`)];
  } catch (problem) {
    return [result(area, check, 'fail', `no answer from ${values.site}: ${messageOf(problem)}`)];
  }
}

/**
 * @param {ShippedValues} values
 * @param {SendRequest} send
 * @returns {Promise<Result[]>}
 */
async function checkJiraService(values, send) {
  const area = 'jira';
  const check = 'token service';
  const client = values.jiraClientId;
  const shipped = client.value.length > 0;
  // A service that is not ready fails only once the desktop ships the client id that needs it.
  const notReady = (detail) => {
    if (shipped) return result(area, check, 'fail', detail);
    return result(area, check, 'pending', `${detail} (JIRA_OAUTH_CLIENT_ID is empty in ${client.source}, so Sign in with Atlassian is not shipped)`);
  };
  try {
    const answer = await send(values.jiraRefreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: PROBE }),
    });
    const { code, description } = await errorOf(answer);
    if (answer.status === 500 && code === 'server_error') return [notReady('JIRA_OAUTH_CLIENT_ID or JIRA_OAUTH_CLIENT_SECRET is not set on the Pages project')];
    if (code === 'invalid_grant') return [result(area, check, 'ok', 'Atlassian accepted the client and refused the made-up refresh token')];
    // Atlassian's other answer for a refresh token it will not take. The description names the
    // token, so the client was accepted. The same code with any other description is a refusal.
    if (code === 'unauthorized_client' && REFUSED_REFRESH_TOKEN.test(description)) {
      return [result(area, check, 'ok', `Atlassian accepted the client and refused the made-up refresh token (${code}: ${description})`)];
    }
    if (['unauthorized_client', 'invalid_client', 'access_denied'].includes(code)) return [notReady(`Atlassian refused the client: ${answer.status} ${code}`)];
    return [unexpectedAnswer(area, check, answer, code)];
  } catch (problem) {
    return [result(area, check, 'fail', `no answer from ${values.site}: ${messageOf(problem)}`)];
  }
}

/**
 * @param {ShippedValues} values
 * @param {SendRequest} send
 * @returns {Promise<Result[]>}
 */
async function checkLinear(values, send) {
  const area = 'linear';
  const check = 'oauth client';
  const client = values.linearClientId;
  if (!client.value) {
    return [result(area, check, 'pending', `LINEAR_OAUTH_CLIENT_ID is empty in ${client.source}, so Sign in with Linear is not shipped`)];
  }
  try {
    const answer = await send(values.linearTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.value,
        code: PROBE,
        code_verifier: `${PROBE}-${'0'.repeat(24)}`,
        redirect_uri: values.linearRedirectUri,
      }),
    });
    const code = await errorCodeOf(answer);
    if (code === 'invalid_grant') return [result(area, check, 'ok', `Linear knows the client from ${client.source}`)];
    if (code === 'invalid_client') return [result(area, check, 'fail', `Linear no longer knows the client from ${client.source}`)];
    return [unexpectedAnswer(area, check, answer, code)];
  } catch (problem) {
    return [result(area, check, 'fail', `no answer from Linear: ${messageOf(problem)}`)];
  }
}

/**
 * @param {ShippedValues} values
 * @param {SendRequest} send
 * @returns {Promise<Result[]>}
 */
async function checkGitLab(values, send) {
  const area = 'gitlab';
  const check = 'oauth client';
  const client = values.gitlabClientId;
  if (!client.value) {
    return [result(area, check, 'pending', `GITLAB_COM_OAUTH_CLIENT_ID is empty in ${client.source}, so Sign in with GitLab is not shipped`)];
  }
  try {
    const answer = await send(values.gitlabTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: PROBE,
        redirect_uri: values.gitlabRedirectUri,
        client_id: client.value,
        code_verifier: `${PROBE}-${'0'.repeat(24)}`,
      }),
    });
    const code = await errorCodeOf(answer);
    if (code === 'invalid_grant') return [result(area, check, 'ok', `gitlab.com knows the client from ${client.source}`)];
    if (code === 'invalid_client') return [result(area, check, 'fail', `gitlab.com no longer knows the client from ${client.source}`)];
    return [unexpectedAnswer(area, check, answer, code)];
  } catch (problem) {
    return [result(area, check, 'fail', `no answer from gitlab.com: ${messageOf(problem)}`)];
  }
}

/**
 * Every check at once. The order of the list is the order of the table.
 *
 * @param {ShippedValues} values
 * @param {SendRequest} send
 * @returns {Promise<Result[]>}
 */
async function runChecks(values, send) {
  const groups = await Promise.all([
    checkTrelloKey(values, send),
    checkTrelloPage(values, send),
    checkJiraCallback(values, send),
    checkJiraService(values, send),
    checkLinear(values, send),
    checkGitLab(values, send),
  ]);
  return groups.flat();
}

// ---------------------------------------------------------------------------
// Output. The table, the annotations and the request are in ./lib/check-report.mjs.
// ---------------------------------------------------------------------------

/** The step summary: one table row per check. */
function summaryMarkdown(results, site) {
  return ['## Sign-in check', '', `Site: ${markdownCell(site)}`, '', ...summaryTable(results), ''].join('\n');
}

/**
 * Reads the shipped values, runs every check and prints the result. Returns the
 * exit code and leaves setting it to the caller.
 *
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined>, send?: SendRequest }} [options]
 * @returns {Promise<number>}
 */
async function main({ repoRoot = REPO_ROOT, env = process.env, send = sendRequest } = {}) {
  let values = null;
  let results;
  try {
    values = readShippedValues(repoRoot, env);
  } catch (problem) {
    results = [result('desktop', 'shipped values', 'fail', `${problem instanceof Error ? problem.message : String(problem)} No probe ran.`)];
  }
  if (values) results = await runChecks(values, send);

  for (const line of tableLines(results)) console.log(line);

  if (env.GITHUB_ACTIONS === 'true') {
    for (const line of annotationLines(results)) console.log(line);
    if (env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(results, values?.site ?? 'not read'));
    }
  }

  const failed = results.filter(({ status }) => status === 'fail').length;
  console.log(failed > 0 ? `\n${failed} check${failed === 1 ? '' : 's'} failed.` : '\nNo check failed.');
  return exitCodeFor(results);
}

export const __testing = {
  SOURCE_FILES,
  STATE_PORT,
  readShippedValues,
  signInState,
  trelloReturnPageUrl,
  trelloAuthorizeUrl,
  checkTrelloKey,
  checkTrelloPage,
  checkJiraCallback,
  checkJiraService,
  checkLinear,
  checkGitLab,
  runChecks,
  tableLines,
  annotationLines,
  summaryMarkdown,
  exitCodeFor,
  sendRequest,
  main,
};

if (isEntrypoint(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((problem) => {
      console.error(`[check-integrations] FAILED: ${singleLine(problem instanceof Error ? problem.message : String(problem))}`);
      process.exit(1);
    });
}
