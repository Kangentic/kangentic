#!/usr/bin/env python3
"""MANUAL PROBE - NEVER WIRED INTO TESTS OR CI. LINUX (and macOS through ps).

The POSIX counterpart of scripts/probe-claude-exit-paths.js (task #854), in
Python because a WSL distro has python3 but no Linux Node for node-pty.

Runs a Claude binary under `bash --login` in a real pty, the way Kangentic's
pty host does on POSIX (the command typed into the live shell), puts it in a
state, ends it, and records what the Windows probe records. The end paths:

  hangup          node-pty's UnixTerminal.kill(): SIGHUP to the shell pid, the
                  master left open and drained (the host keeps reading it).
  hangup-close    the same, with the master closed the moment the shell exits:
                  a quit, where the host exits right after its shells do.
  shell-killed    SIGKILL to the shell: a shell that dies on its own, where only
                  the kernel's hangup of the foreground group reaches Claude.
  current         '\\x03' then '/exit\\r' (before task #854)
  esc-clear-exit  '\\x1b', 400 ms, '\\x03', '/exit\\r' (the typed POSIX sequence)

States: idle, busy (still thinking), streaming, typed (a draft pasted), dialog
(a Bash permission prompt open); ages young (its own fullscreenBootPending
record still pending) and mature. The pass bar is the Windows probe's: Claude
exits by itself (5 s for a hangup, 1.5 s for keys), SessionEnd ran, a young
cell leaves no record, no extra turn (a UserPromptSubmit after the action), no
tool ran, and the transcript's last line parses. Every cell scrubs its own dead
pid's record from ~/.claude.json under Claude's lock, temp file plus rename.

--fake-api serves a local stand-in for the Messages API, reached through
ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, so no account is used and nothing
is billed: OK at once for the idle prompt, 1.5 s of silence then a stream of
numbers for the busy one, a Bash tool_use for the dialog one. Without it the
cells use the machine's own Claude login and cost a few haiku prompts.

Usage (the working directory is trusted on first use):
  python3 -I scripts/probe-claude-exit-paths-linux.py --binary <claude> --cwd <dir>
      --runs-dir <dir> --out <results.jsonl> [--fake-api] [--ends a,b]
      [--states a,b] [--ages a,b] [--repeat n] [--renderer setting|no-flicker]
      [--env KEY=VALUE] [--use-ps]
Download a binary to probe from
https://downloads.claude.ai/claude-code-releases/<version>/linux-x64/claude
(checksum in <version>/manifest.json) and run it with DISABLE_AUTOUPDATER=1,
which every cell sets.

Measured 2026-10-19 on Claude Code 2.1.304 in WSL2 with --fake-api:
  hangup, hangup-close  every state, young and mature: SessionEnd (other) 33 to
                        162 ms after, exit 0.33 to 0.71 s, every young record
                        withdrawn, no second turn, no tool run
  shell-killed          idle, busy, dialog: SessionEnd about 50 ms, exit 0.4 to
                        0.6 s
  esc-clear-exit        every state: exit 1.06 to 1.31 s (prompt_input_exit)
  current               dialog: tool approved, no exit; the other states passed,
                        busy included, which the stand-in cannot fail: putting a
                        prompt back needs a real model's turn
  --renderer no-flicker alt screen entered, no record ever written
"""
import sys

if sys.platform == 'win32':
    raise SystemExit('POSIX only: run scripts/probe-claude-exit-paths.js on Windows')

import argparse
import codecs
import json
import os
import pty
import re
import select
import shlex
import shutil
import signal
import struct
import tempfile
import threading
import time
import fcntl
import termios

END_PATHS = {
    'hangup': None,
    'hangup-close': None,
    'shell-killed': None,
    'current': ['\x03', '/exit\r'],
    'esc-clear-exit': ['\x1b', {'delayMs': 400}, '\x03', '/exit\r'],
}
STATES = ['idle', 'busy', 'streaming', 'typed', 'dialog']
AGES = ['young', 'mature']
RENDERERS = ['setting', 'no-flicker']
EXIT_BOUND_MS = {'typed': 1500, 'hangup': 5000}
CELL_OBSERVE_MS = 15000
STATE_TIMEOUT_MS = 25000
MATURE_WAIT_MS = 16000
BUSY_AFTER_SUBMIT_MS = 250
NO_FLICKER_YOUNG_LIMIT_MS = 9000
BUSY_PROMPT = 'Write the numbers 1 to 2000, one per line, no other text.'
IDLE_PROMPT = 'Reply with the single word OK.'
DRAFT_TEXT = 'first line of a draft\nsecond line of a draft'
CLAUDE_JSON = os.path.expanduser('~/.claude.json')
CLAUDE_JSON_LOCK = CLAUDE_JSON + '.lock'
HOOK_EVENTS = [
    ('SessionStart', 'start'), ('SessionEnd', 'end'), ('UserPromptSubmit', 'prompt'),
    ('PreToolUse', 'pre-tool'), ('PostToolUse', 'post-tool'), ('PermissionRequest', 'permission'),
    ('Notification', 'notification'), ('Stop', 'stop'),
]
HOOK_SCRIPT = r'''
import json, sys, time
marker_path, label = sys.argv[1], sys.argv[2]
record = {'at': int(time.time() * 1000), 'label': label}
try:
    payload = json.loads(sys.stdin.read() or '{}')
    record['reason'] = payload.get('reason') or payload.get('source') or ''
    if payload.get('tool_name'): record['tool'] = payload['tool_name']
    if isinstance(payload.get('prompt'), str): record['promptTail'] = payload['prompt'][-60:]
    if isinstance(payload.get('message'), str): record['message'] = payload['message'][:160]
    if isinstance(payload.get('transcript_path'), str): record['transcriptPath'] = payload['transcript_path']
except Exception:
    pass
with open(marker_path, 'a', encoding='utf-8') as handle:
    handle.write(json.dumps(record) + '\n')
'''


def now_ms():
    return int(time.time() * 1000)


class FakeAnthropicApi:
    """A local Messages API stand-in, so no account is used and nothing is billed.

    Claude reaches it through ANTHROPIC_BASE_URL with ANTHROPIC_AUTH_TOKEN, the
    documented LLM-gateway setup. It answers by the last user text:
    - the idle prompt: "OK" at once.
    - the busy prompt: nothing for THINK_MS (a turn still thinking), then the
      numbers one per line, one every STREAM_STEP_MS (an answer streaming).
    - the dialog prompt: a Bash tool_use running the prompt's own command,
      which opens Claude's real permission prompt; once a tool_result comes
      back, "Done.".
    - anything else (titles, background calls): "OK".
    Every main-turn request is counted, so a second turn shows here too.
    """

    THINK_MS = 1500
    STREAM_STEP_MS = 40

    def __init__(self):
        import http.server
        import socketserver
        api = self
        self.requests = []
        # Text deltas of the busy answer sent so far, and when the first went out.
        self.busy_deltas_sent = 0
        self.busy_first_delta_at = None

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_GET(self):
                self._json(200, {})

            def do_HEAD(self):
                self.send_response(200)
                self.send_header('Content-Length', '0')
                self.end_headers()

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(length) if length else b''
                try:
                    payload = json.loads(body or b'{}')
                except ValueError:
                    payload = {}
                if '/count_tokens' in self.path:
                    return self._json(200, {'input_tokens': 10})
                if not self.path.split('?')[0].endswith('/v1/messages'):
                    return self._json(200, {})
                text, has_tool_result = api.last_user_text(payload)
                kind = api.classify(text, has_tool_result)
                api.requests.append({'at': now_ms(), 'kind': kind, 'hasExitText': '/exit' in text})
                try:
                    if kind == 'busy':
                        api.respond(self, payload, [('think', None)] + [('text', f'{number}\n') for number in range(1, 2001)])
                    elif kind == 'dialog':
                        command = re.search(r'nothing else: (.+)$', text.strip())
                        api.respond(self, payload, [('tool', {'command': command.group(1) if command else 'true', 'description': 'Run the command'})])
                    elif kind == 'dialog-done':
                        api.respond(self, payload, [('text', 'Done.')])
                    else:
                        api.respond(self, payload, [('text', 'OK')])
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def _json(self, status, value):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        self.server = Server(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @staticmethod
    def last_user_text(payload):
        for message in reversed(payload.get('messages') or []):
            if message.get('role') != 'user':
                continue
            content = message.get('content')
            if isinstance(content, str):
                return content, False
            texts = [block.get('text', '') for block in content or [] if block.get('type') == 'text']
            has_tool_result = any(block.get('type') == 'tool_result' for block in content or [])
            return '\n'.join(texts), has_tool_result
        return '', False

    @staticmethod
    def classify(text, has_tool_result):
        if has_tool_result:
            return 'dialog-done'
        if 'numbers 1 to 2000' in text:
            return 'busy'
        if 'Use the Bash tool to run exactly this command' in text:
            return 'dialog'
        if 'Reply with the single word OK' in text:
            return 'idle'
        return 'other'

    def respond(self, handler, payload, parts):
        model = payload.get('model') or 'claude-haiku'
        stop_reason = 'tool_use' if any(kind == 'tool' for kind, _ in parts) else 'end_turn'
        message = {'id': 'msg_probe', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [],
                   'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 1}}
        if not payload.get('stream'):
            content = []
            for kind, value in parts:
                if kind == 'text':
                    if content and content[-1]['type'] == 'text':
                        content[-1]['text'] += value
                    else:
                        content.append({'type': 'text', 'text': value})
                elif kind == 'tool':
                    content.append({'type': 'tool_use', 'id': 'toolu_probe', 'name': 'Bash', 'input': value})
            message.update(content=content, stop_reason=stop_reason)
            data = json.dumps(message).encode()
            handler.send_response(200)
            handler.send_header('Content-Type', 'application/json')
            handler.send_header('Content-Length', str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)
            return
        if parts and parts[0][0] == 'think':
            time.sleep(self.THINK_MS / 1000)
            parts = parts[1:]
        handler.send_response(200)
        handler.send_header('Content-Type', 'text/event-stream')
        handler.send_header('Cache-Control', 'no-cache')
        handler.send_header('Transfer-Encoding', 'chunked')
        handler.end_headers()

        def event(name, data):
            # Chunked, so the client reads each event as it is sent.
            body = f'event: {name}\ndata: {json.dumps(data)}\n\n'.encode()
            handler.wfile.write(f'{len(body):x}\r\n'.encode() + body + b'\r\n')
            handler.wfile.flush()

        event('message_start', {'type': 'message_start', 'message': message})
        index = 0
        text_open = False
        for kind, value in parts:
            if kind == 'text':
                if not text_open:
                    event('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': {'type': 'text', 'text': ''}})
                    text_open = True
                event('content_block_delta', {'type': 'content_block_delta', 'index': index, 'delta': {'type': 'text_delta', 'text': value}})
                if len(parts) > 1:
                    if self.busy_first_delta_at is None:
                        self.busy_first_delta_at = now_ms()
                    self.busy_deltas_sent += 1
                    time.sleep(self.STREAM_STEP_MS / 1000)
            elif kind == 'tool':
                if text_open:
                    event('content_block_stop', {'type': 'content_block_stop', 'index': index})
                    index += 1
                    text_open = False
                event('content_block_start', {'type': 'content_block_start', 'index': index,
                                              'content_block': {'type': 'tool_use', 'id': 'toolu_probe', 'name': 'Bash', 'input': {}}})
                event('content_block_delta', {'type': 'content_block_delta', 'index': index,
                                              'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(value)}})
                event('content_block_stop', {'type': 'content_block_stop', 'index': index})
                index += 1
        if text_open:
            event('content_block_stop', {'type': 'content_block_stop', 'index': index})
        event('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop_reason, 'stop_sequence': None}, 'usage': {'output_tokens': 5}})
        event('message_stop', {'type': 'message_stop'})
        handler.wfile.write(b'0\r\n\r\n')
        handler.wfile.flush()

    def main_turns_since(self, since_ms):
        return [request for request in self.requests if request['at'] >= since_ms and request['kind'] in ('idle', 'busy', 'dialog', 'dialog-done')]


def sleep_ms(ms):
    if ms > 0:
        time.sleep(ms / 1000)


def wait_for(predicate, timeout_ms, step_ms=50):
    deadline = now_ms() + timeout_ms
    while now_ms() < deadline:
        if predicate():
            return True
        sleep_ms(step_ms)
    return bool(predicate())


def read_claude_json():
    try:
        with open(CLAUDE_JSON, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def with_claude_json_lock(operation):
    """Claude's own lock protocol (src/main/agent/adapters/claude/claude-json-lock.ts)."""
    started = time.time()
    ladder = [0.05, 0.1, 0.2, 0.4, 0.8]
    attempt = 0
    while True:
        try:
            os.mkdir(CLAUDE_JSON_LOCK)
            break
        except FileExistsError:
            pass
        try:
            stale = time.time() - os.stat(CLAUDE_JSON_LOCK).st_mtime > 10
        except FileNotFoundError:
            stale = False
        if stale:
            shutil.rmtree(CLAUDE_JSON_LOCK, ignore_errors=True)
            continue
        if time.time() - started >= 12:
            raise RuntimeError('ELOCKED: ~/.claude.json.lock was held past the budget')
        time.sleep(ladder[attempt] if attempt < len(ladder) else 1)
        attempt += 1
    try:
        return operation()
    finally:
        shutil.rmtree(CLAUDE_JSON_LOCK, ignore_errors=True)


def rewrite_claude_json(mutate):
    """Read inside the lock, write a temp file beside it, rename it over the original."""
    def operation():
        with open(CLAUDE_JSON, encoding='utf-8') as handle:
            text = handle.read()
        state = json.loads(text)
        result = mutate(state)
        if result is None:
            return None
        temp_path = CLAUDE_JSON + '.exit-probe-tmp'
        # Created with the original's mode: the file holds account state, and a
        # plain open() would leave it readable to every user after the rename.
        mode = os.stat(CLAUDE_JSON).st_mode & 0o777
        descriptor = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
                handle.write(json.dumps(state, indent=2, ensure_ascii=False) + ('\n' if text.endswith('\n') else ''))
            os.chmod(temp_path, mode)
            os.replace(temp_path, CLAUDE_JSON)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        return result
    return with_claude_json_lock(operation)


def ensure_trusted(cwd):
    def mutate(state):
        projects = state.setdefault('projects', {})
        entry = projects.setdefault(cwd, {})
        if entry.get('hasTrustDialogAccepted') is True:
            return None
        entry['hasTrustDialogAccepted'] = True
        return True
    rewrite_claude_json(mutate)


# macOS has no /proc: `ps` answers the same three questions there (--use-ps forces it).
USE_PS = not os.path.isdir('/proc/self') or '--use-ps' in sys.argv


def ps_lines(*args):
    import subprocess
    result = subprocess.run(['ps', *args], capture_output=True, text=True)
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def is_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if USE_PS:
        state = ps_lines('-o', 'stat=', '-p', str(pid))
        return bool(state) and not state[0].startswith('Z')
    try:
        with open(f'/proc/{pid}/stat', encoding='utf-8') as handle:
            fields = handle.read().rsplit(')', 1)[1].split()
        return fields[0] != 'Z'
    except OSError:
        return False


def scrub_dead_records(pids):
    dead = [str(pid) for pid in pids if pid and not is_alive(pid)]
    if not dead:
        return []

    def mutate(state):
        pending = state.get('fullscreenBootPending') or {}
        removed = [pid for pid in dead if pid in pending]
        if not removed:
            return None
        for pid in removed:
            del pending[pid]
        return removed
    return [int(pid) for pid in (rewrite_claude_json(mutate) or [])]


class CanarySampler:
    def __init__(self):
        self.tracked = {}
        self.stopped = False
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while not self.stopped:
            self.sample()
            time.sleep(0.1)

    def sample(self):
        state = read_claude_json()
        if state is None:
            return
        pending = state.get('fullscreenBootPending') or {}
        moment = now_ms()
        with self.lock:
            for pid, record in self.tracked.items():
                present = str(pid) in pending
                if present:
                    if record['firstSeenAt'] is None:
                        record['firstSeenAt'] = moment
                    record['lastSeenAt'] = moment
                elif record['present']:
                    record['goneAt'] = moment
                record['present'] = present

    def track(self, pid):
        with self.lock:
            self.tracked.setdefault(pid, {'firstSeenAt': None, 'lastSeenAt': None, 'goneAt': None, 'present': False})
        self.sample()

    def get(self, pid):
        with self.lock:
            return dict(self.tracked[pid])

    def stop(self):
        self.stopped = True


def strip_escapes(text):
    text = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', ' ', text)
    text = re.sub(r'\x1b\[[0-9;?<>=]*[ -/]*[@-~]', ' ', text)
    return re.sub(r'\x1b.', ' ', text)


def answer_on_screen(output):
    text = strip_escapes(output)
    for match in re.finditer(r'(?=(?:^|\D)(\d+)\s+(\d+)\s+(\d+)(?=\D|$))', text):
        first = int(match.group(1))
        if int(match.group(2)) == first + 1 and int(match.group(3)) == first + 2:
            return True
    return False


def read_marker(path):
    if not os.path.exists(path):
        return []
    lines = []
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                lines.append(json.loads(line))
            except ValueError:
                pass
    return lines


def transcript_lines(path):
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as handle:
        return [line for line in handle.read().split('\n') if line]


def children_of(pid):
    if USE_PS:
        children = []
        for line in ps_lines('-A', '-o', 'pid=,ppid='):
            child, parent = line.split()[:2]
            if int(parent) == pid:
                children.append(int(child))
        return children
    try:
        with open(f'/proc/{pid}/task/{pid}/children', encoding='utf-8') as handle:
            return [int(value) for value in handle.read().split()]
    except OSError:
        return []


def comm_of(pid):
    if USE_PS:
        name = ps_lines('-o', 'comm=', '-p', str(pid))
        return os.path.basename(name[0]) if name else ''
    try:
        with open(f'/proc/{pid}/comm', encoding='utf-8') as handle:
            return handle.read().strip()
    except OSError:
        return ''


class Shell:
    """`bash --login` in a pty, read on a thread, as node-pty's socket is."""

    def __init__(self, cwd, env, cols=120, rows=30):
        pid, fd = pty.fork()
        if pid == 0:
            # A failed exec must end the child here, or it runs on as a second
            # copy of the probe and appends its own records.
            try:
                os.chdir(cwd)
                os.execvpe('bash', ['bash', '--login'], env)
            except BaseException:
                os._exit(127)
        self.pid = pid
        self.fd = fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.output = ''
        self.lock = threading.Lock()
        self.exited_at = None
        self.exit_status = None
        self.master_closed = False
        self.alt_screen_at = None
        self.launch_mark = 0
        self.launched_at = None
        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.reader = threading.Thread(target=self._read, args=(decoder,), daemon=True)
        self.reader.start()
        self.waiter = threading.Thread(target=self._wait, daemon=True)
        self.waiter.start()

    def _read(self, decoder):
        while not self.master_closed:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.1)
            except (OSError, ValueError):
                return
            if self.fd not in ready:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
            text = decoder.decode(data)
            with self.lock:
                self.output += text
                if self.alt_screen_at is None and self.launched_at is not None and '\x1b[?1049h' in self.output[self.launch_mark:]:
                    self.alt_screen_at = now_ms()

    def _wait(self):
        _, status = os.waitpid(self.pid, 0)
        self.exit_status = status
        self.exited_at = now_ms()

    def text(self):
        with self.lock:
            return self.output

    def write(self, data):
        os.write(self.fd, data.encode('utf-8'))

    def hangup(self):
        try:
            os.kill(self.pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    def close_master(self):
        if not self.master_closed:
            self.master_closed = True
            try:
                os.close(self.fd)
            except OSError:
                pass


def cell_env(renderer, extra_env, fake_api_port=None):
    env = dict(os.environ)
    for key in list(env):
        if re.match(r'^CLAUDE_?CODE', key, re.IGNORECASE) or key.startswith('ANTHROPIC_'):
            del env[key]
    if fake_api_port:
        env['ANTHROPIC_BASE_URL'] = f'http://127.0.0.1:{fake_api_port}'
        env['ANTHROPIC_AUTH_TOKEN'] = 'probe-placeholder'
    env['DISABLE_AUTOUPDATER'] = '1'
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'
    env['CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT'] = '1'
    if renderer == 'no-flicker':
        env['CLAUDE_CODE_NO_FLICKER'] = '1'
    for pair in extra_env:
        key, _, value = pair.partition('=')
        if key:
            env[key] = value
    return env


def write_steps(write, steps):
    for step in steps:
        if isinstance(step, str):
            write(step)
        else:
            sleep_ms(step['delayMs'])


def run_cell(options):
    binary = os.path.abspath(options.binary)
    cwd = os.path.abspath(options.cwd)
    os.makedirs(cwd, exist_ok=True)
    ensure_trusted(cwd)
    run_dir = tempfile.mkdtemp(prefix='cell-', dir=os.path.abspath(options.runs_dir))
    fake_api = options.fake_api_server
    env = cell_env(options.renderer, options.env, fake_api.port if fake_api else None)
    version = os.popen(f'{shlex.quote(binary)} --version').read().strip().split(' ')[0]
    state_before = read_claude_json() or {}
    disabled = state_before.get('fullscreenAutoDisabled') or {}
    if options.renderer == 'setting' and disabled.get('version') == version:
        raise RuntimeError(f'fullscreen is auto-disabled for {version}; run /tui fullscreen in it first')

    hook_path = os.path.join(run_dir, 'hook.py')
    with open(hook_path, 'w', encoding='utf-8') as handle:
        handle.write(HOOK_SCRIPT)
    marker_path = os.path.join(run_dir, 'hooks.jsonl')
    tool_marker = os.path.join(run_dir, 'tool-ran.txt')
    hooks = {}
    for event, label in HOOK_EVENTS:
        command = f'python3 -I {shlex.quote(hook_path)} {shlex.quote(marker_path)} {label}'
        hooks[event] = [{'matcher': '', 'hooks': [{'type': 'command', 'command': command}]}]
    settings = {'hooks': hooks}
    if options.renderer == 'setting':
        settings['tui'] = 'fullscreen'
    settings_path = os.path.join(run_dir, 'settings.json')
    with open(settings_path, 'w', encoding='utf-8') as handle:
        json.dump(settings, handle)

    if options.state in ('busy', 'streaming'):
        state_prompt = BUSY_PROMPT
    elif options.state == 'dialog':
        state_prompt = f'Use the Bash tool to run exactly this command and nothing else: touch {tool_marker}'
    else:
        state_prompt = IDLE_PROMPT
    extra_args = ['--setting-sources', 'project,local', '--permission-mode', 'default'] if options.state == 'dialog' else []

    if fake_api:
        # A previous cell's stream must not read as this cell's.
        fake_api.busy_deltas_sent = 0
        fake_api.busy_first_delta_at = None
    sampler = CanarySampler()
    shell = Shell(cwd, env)
    claude_pid = None
    try:
        sleep_ms(1500)
        parts = [shlex.quote(binary), '--settings', shlex.quote(settings_path), '--model', 'haiku', *extra_args]
        if options.age == 'young':
            parts += ['--', shlex.quote(state_prompt)]
        with shell.lock:
            shell.launch_mark = len(shell.output)
        shell.launched_at = now_ms()
        shell.write(' '.join(parts) + '\r')

        alt_screen = wait_for(lambda: shell.alt_screen_at is not None, 60000)
        deadline = now_ms() + 15000
        while now_ms() < deadline and claude_pid is None:
            claude_pid = next((pid for pid in children_of(shell.pid) if comm_of(pid).startswith('claude')), None)
            if claude_pid is None:
                sleep_ms(100)
        if claude_pid is None:
            raise RuntimeError('Claude did not start under the shell; screen tail: ' + strip_escapes(shell.text()[-600:]))
        sampler.track(claude_pid)
        first_frame_at = shell.alt_screen_at or now_ms()
        if options.renderer == 'setting':
            wait_for(lambda: sampler.get(claude_pid)['firstSeenAt'] is not None, 3000, 100)
        if options.age == 'mature':
            sleep_ms(first_frame_at + MATURE_WAIT_MS - now_ms())

        setup = set_up_state(shell, options, state_prompt, marker_path)

        sampler.sample()
        canary_at_action = sampler.get(claude_pid)
        armed = canary_at_action['firstSeenAt'] is not None
        void_reason = None
        if not alt_screen:
            void_reason = 'classic-renderer'
        elif options.renderer == 'setting' and not armed:
            void_reason = 'never-armed'
        elif options.renderer == 'setting' and options.age == 'young' and not canary_at_action['present']:
            void_reason = 'aged-out'
        elif options.renderer == 'setting' and options.age == 'mature' and canary_at_action['present']:
            void_reason = 'still-young'
        elif options.renderer == 'no-flicker' and options.age == 'young' and now_ms() - first_frame_at > NO_FLICKER_YOUNG_LIMIT_MS:
            void_reason = 'aged-out'
        elif not setup['confirmed']:
            void_reason = 'state-not-reached'

        start_line = next((line for line in read_marker(marker_path) if line.get('label') == 'start' and line.get('transcriptPath')), None)
        transcript_path = start_line['transcriptPath'] if start_line else None
        transcript_before = transcript_lines(transcript_path) or []
        output_before_action = shell.text()[shell.launch_mark:]

        steps = END_PATHS[options.end]
        claude_exited_at = None
        action_at = now_ms()
        if options.end == 'shell-killed':
            # A shell that dies on its own: it forwards nothing, so only the
            # kernel's hangup of the terminal's foreground group reaches Claude.
            os.kill(shell.pid, signal.SIGKILL)
        elif steps is None:
            shell.hangup()
            if options.end == 'hangup-close':
                # Claude is watched while the shell exits too, so an exit
                # before the shell's is stamped when it happens.
                shell_deadline = now_ms() + 5000
                while shell.exited_at is None and now_ms() < shell_deadline:
                    if claude_exited_at is None and not is_alive(claude_pid):
                        claude_exited_at = now_ms()
                    sleep_ms(5)
                shell.close_master()
        else:
            write_steps(shell.write, steps)

        while claude_exited_at is None and now_ms() - action_at < CELL_OBSERVE_MS:
            if not is_alive(claude_pid):
                claude_exited_at = now_ms()
                break
            sleep_ms(25)
        forced = claude_exited_at is None
        if forced:
            try:
                os.kill(claude_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        sleep_ms(1500)
        sampler.sample()
        canary_after = sampler.get(claude_pid)
        sleep_ms(1000)
        if shell.exited_at is None:
            shell.hangup()
            wait_for(lambda: shell.exited_at is not None, 3000)
        shell.close_master()
        sampler.stop()
        scrubbed = scrub_dead_records([claude_pid])

        after_action = [line for line in read_marker(marker_path) if line.get('at', 0) >= action_at]
        end_line = next((line for line in after_action if line.get('label') == 'end'), None)
        extra_prompts = [line for line in after_action if line.get('label') == 'prompt']
        # A second turn is a UserPromptSubmit after the action, as in the Windows
        # probe: a prompt put back and resent fires it. The stub's requests are
        # recorded for information only. A young Claude sends its turn's own
        # request after a 250 ms action, and makes background calls carrying the
        # same prompt text, so a count of them reads as turns that never were.
        api_turns_after = fake_api.main_turns_since(action_at) if fake_api else []
        api_exit_text_after = [request for request in (fake_api.requests if fake_api else []) if request['at'] >= action_at and request.get('hasExitText')]
        tool_ran = any(line.get('label') == 'post-tool' for line in after_action) or os.path.exists(tool_marker)
        transcript_after = transcript_lines(transcript_path) or []
        added = transcript_after[len(transcript_before):]
        last_line_parses = None
        if transcript_after:
            try:
                json.loads(transcript_after[-1])
                last_line_parses = True
            except ValueError:
                last_line_parses = False
        assistant_text_before = answer_on_screen(output_before_action) or bool(setup.get('streamingByStub'))
        if fake_api and options.state == 'busy' and fake_api.busy_first_delta_at is not None and fake_api.busy_first_delta_at < action_at:
            assistant_text_before = True
        if not void_reason and options.state == 'busy' and assistant_text_before:
            void_reason = 'output-already-started'
        if not void_reason and options.state == 'streaming' and not assistant_text_before:
            void_reason = 'output-not-started'
        exit_bound = EXIT_BOUND_MS['hangup'] if steps is None else EXIT_BOUND_MS['typed']
        claude_exited_ms = None if claude_exited_at is None else claude_exited_at - action_at
        shell_exited_ms = None if shell.exited_at is None else shell.exited_at - action_at
        failures = []
        if void_reason:
            failures.append(f'void:{void_reason}')
        if forced:
            failures.append('did-not-exit')
        elif claude_exited_ms > exit_bound:
            failures.append(f'slow-exit>{exit_bound}ms')
        if not end_line:
            failures.append('no-session-end')
        if options.age == 'young' and canary_after['present']:
            failures.append('canary-left')
        if extra_prompts:
            failures.append('extra-turn')
        if tool_ran:
            failures.append('tool-ran')
        if last_line_parses is False:
            failures.append('transcript-torn')
        exit_record = any('<command-name>/exit' in line or 'local-command-stdout' in line for line in added)
        return {
            'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(action_at / 1000)),
            'platform': platform_label(),
            'version': version,
            'end': options.end,
            'state': options.state,
            'age': options.age,
            'renderer': options.renderer,
            'extraEnv': options.env,
            'pass': not failures,
            'failures': failures,
            'altScreen': alt_screen,
            'armed': armed,
            'stateConfirmed': setup['confirmed'],
            'assistantTextBeforeAction': assistant_text_before,
            'actionMsAfterFirstFrame': action_at - first_frame_at,
            'claudeExitedMs': claude_exited_ms,
            'shellExitedMs': shell_exited_ms,
            'claudeOutlivedShellMs': None if claude_exited_ms is None or shell_exited_ms is None else claude_exited_ms - shell_exited_ms,
            'forcedAfter15s': forced,
            'sessionEndRan': bool(end_line),
            'sessionEndReason': end_line.get('reason') if end_line else None,
            'sessionEndMs': end_line['at'] - action_at if end_line else None,
            'canaryWithdrawnMs': canary_after['goneAt'] - action_at if canary_after['goneAt'] else None,
            'canaryLeft': canary_after['present'],
            'scrubbed': scrubbed,
            'extraTurn': bool(extra_prompts),
            'toolRanAfterAction': tool_ran,
            'exitRecordInTranscript': exit_record,
            'transcriptLastLineParses': last_line_parses,
            'markerLabels': [line.get('label') for line in read_marker(marker_path)],
            'fakeApi': bool(fake_api),
            'apiTurnsAfterAction': [request['kind'] for request in api_turns_after],
            'apiRequestsWithExitTextAfterAction': len(api_exit_text_after),
            **({'screenTail': re.sub(r'\s+', ' ', strip_escapes(output_before_action))[-700:]} if void_reason else {}),
        }
    finally:
        sampler.stop()
        if claude_pid and is_alive(claude_pid):
            try:
                os.kill(claude_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if shell.exited_at is None:
            shell.hangup()
            wait_for(lambda: shell.exited_at is not None, 3000)
        if shell.exited_at is None:
            try:
                os.kill(shell.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        shell.close_master()
        sleep_ms(500)
        try:
            scrub_dead_records([claude_pid])
        except Exception as error:  # the scrub is best effort on a failed cell
            print(f'scrub failed: {error}', file=sys.stderr)
        shutil.rmtree(run_dir, ignore_errors=True)


def set_up_state(shell, options, state_prompt, marker_path):
    since = shell.launched_at if options.age == 'young' else now_ms()
    if options.age == 'mature':
        shell.write(state_prompt)
        sleep_ms(400)
        shell.write('\r')
    markers = lambda: read_marker(marker_path)
    if options.state in ('idle', 'typed'):
        finished = wait_for(lambda: any(line.get('label') == 'stop' and line.get('at', 0) >= since for line in markers()), STATE_TIMEOUT_MS)
        sleep_ms(300)
        if not finished or options.state == 'idle':
            return {'confirmed': finished}
        mark = len(shell.text())
        shell.write(f'\x1b[200~{DRAFT_TEXT}\x1b[201~')
        sleep_ms(500)
        return {'confirmed': 'draft' in shell.text()[mark:]}
    if options.state in ('busy', 'streaming'):
        def submit_line():
            return next((line for line in markers() if line.get('label') == 'prompt' and line.get('at', 0) >= since), None)
        if not wait_for(lambda: submit_line() is not None, STATE_TIMEOUT_MS, 10):
            return {'confirmed': False}
        submit_at = submit_line()['at']
        fake_api = options.fake_api_server
        if options.state == 'streaming' and fake_api:
            # 2.1.304 shows a token count, not the partial text, while it streams,
            # so the stub says when the answer is streaming: 50 deltas in.
            fake_api.busy_deltas_sent = 0
            fake_api.busy_first_delta_at = None
            if not wait_for(lambda: fake_api.busy_deltas_sent >= 50, STATE_TIMEOUT_MS):
                return {'confirmed': False}
            return {'confirmed': True, 'streamingByStub': True}
        if options.state == 'streaming':
            if not wait_for(lambda: answer_on_screen(shell.text()[shell.launch_mark:]), STATE_TIMEOUT_MS):
                return {'confirmed': False}
        else:
            sleep_ms(submit_at + BUSY_AFTER_SUBMIT_MS - now_ms())
        stopped = any(line.get('label') == 'stop' and line.get('at', 0) >= submit_at for line in markers())
        return {'confirmed': not stopped}
    opened = wait_for(lambda: any(line.get('at', 0) >= since and (line.get('label') == 'permission' or (
        line.get('label') == 'notification' and re.search('permission', line.get('message', ''), re.IGNORECASE))) for line in markers()), STATE_TIMEOUT_MS)
    if opened:
        sleep_ms(300)
    return {'confirmed': opened}


def platform_label():
    """Where the probe ran, for the record: macOS, WSL2, or the platform name."""
    if sys.platform == 'darwin':
        return 'macos'
    try:
        with open('/proc/version', encoding='utf-8') as handle:
            if 'microsoft' in handle.read().lower():
                return 'linux (WSL2)'
    except OSError:
        pass
    return sys.platform


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--cwd', required=True)
    parser.add_argument('--runs-dir', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--ends', default='hangup')
    parser.add_argument('--states', default=','.join(STATES))
    parser.add_argument('--ages', default=','.join(AGES))
    parser.add_argument('--renderer', default='setting', choices=RENDERERS)
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--env', action='append', default=[])
    parser.add_argument('--fake-api', action='store_true')
    parser.add_argument('--use-ps', action='store_true', help='read processes with ps, as on macOS')
    arguments = parser.parse_args()
    arguments.fake_api_server = FakeAnthropicApi() if arguments.fake_api else None
    os.makedirs(arguments.runs_dir, exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(arguments.out)), exist_ok=True)
    every_cell_passed = True
    for _ in range(arguments.repeat):
        for end in arguments.ends.split(','):
            for state in arguments.states.split(','):
                for age in arguments.ages.split(','):
                    cell = argparse.Namespace(**vars(arguments), end=end, state=state, age=age)
                    if end not in END_PATHS or state not in STATES or age not in AGES:
                        raise SystemExit(f'unknown cell {end}/{state}/{age}')
                    try:
                        record = run_cell(cell)
                    except Exception as error:
                        record = {'end': end, 'state': state, 'age': age, 'renderer': cell.renderer, 'pass': False, 'failures': [f'error:{error}']}
                    line = json.dumps(record)
                    print(line, flush=True)
                    with open(arguments.out, 'a', encoding='utf-8') as handle:
                        handle.write(line + '\n')
                    if record.get('pass') is not True:
                        every_cell_passed = False
    # A failed, void or crashed cell fails the run, so a caller can tell.
    if not every_cell_passed:
        sys.exit(1)


if __name__ == '__main__':
    main()
