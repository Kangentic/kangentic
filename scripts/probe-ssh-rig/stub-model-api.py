#!/usr/bin/env python3
"""A stand-in for an OpenAI-compatible model API, for probing agent CLIs with no quota and no account.

Every request is logged. The reply to a chat request is one short assistant line with usage figures,
streamed or not as the client asked. The first reply of a session asks for one shell tool call when
the request offers a tool whose name looks like a shell, so a transcript holds a tool call and result.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open('/tmp/stub-api.log', 'a', buffering=1)
MODEL = 'stub-model'


def shell_tool(body):
    for tool in body.get('tools') or []:
        function = tool.get('function') or {}
        name = function.get('name', '')
        if name.lower() in ('bash', 'shell', 'developer__shell', 'run_shell_command') or 'shell' in name.lower():
            properties = (function.get('parameters') or {}).get('properties') or {}
            field = 'command' if 'command' in properties else next(iter(properties), 'command')
            return name, field
    return None


def has_tool_result(body):
    return any(message.get('role') == 'tool' for message in body.get('messages') or [])


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        return

    def do_GET(self):
        LOG.write(f'GET {self.path}\n')
        payload = json.dumps({'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'created': 0, 'owned_by': 'stub'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            body = {}
        tool = shell_tool(body)
        call_tool = tool is not None and not has_tool_result(body)
        LOG.write(f'POST {self.path} stream={body.get("stream")} tools={len(body.get("tools") or [])} messages={len(body.get("messages") or [])} call={call_tool}\n')
        usage = {'prompt_tokens': 1234, 'completion_tokens': 56, 'total_tokens': 1290}
        created = int(time.time())
        if call_tool:
            name, field = tool
            arguments = json.dumps({field: 'echo probe-tool-output'})
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{'index': 0, 'id': 'call_probe_1', 'type': 'function', 'function': {'name': name, 'arguments': arguments}}]}
            finish = 'tool_calls'
        else:
            message = {'role': 'assistant', 'content': 'Stub reply from the probe model.'}
            finish = 'stop'
        if body.get('stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            chunk = {'id': 'chatcmpl-probe', 'object': 'chat.completion.chunk', 'created': created, 'model': MODEL,
                     'choices': [{'index': 0, 'delta': message, 'finish_reason': None}]}
            self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
            final = {'id': 'chatcmpl-probe', 'object': 'chat.completion.chunk', 'created': created, 'model': MODEL,
                     'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}], 'usage': usage}
            self.wfile.write(f'data: {json.dumps(final)}\n\n'.encode())
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
            self.close_connection = True
            return
        payload = json.dumps({'id': 'chatcmpl-probe', 'object': 'chat.completion', 'created': created, 'model': MODEL,
                              'choices': [{'index': 0, 'message': message, 'finish_reason': finish}], 'usage': usage}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 18080), Handler).serve_forever()
