#!/usr/bin/env python3
"""A stand-in for a model API, for probing agent CLIs with no quota and no account.

Every request is logged. The reply to a chat request is one short assistant line with usage figures,
streamed or not as the client asked. The first reply of a session asks for one shell tool call when
the request offers a tool whose name looks like a shell, so a transcript holds a tool call and result.
It speaks three dialects: OpenAI chat completions, OpenAI Responses (Codex), and Gemini's generateContent.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open('/tmp/stub-api.log', 'a', buffering=1)
MODEL = 'stub-model'
REPLY = 'Stub reply from the probe model.'


def is_shell_name(name):
    return name.lower() in ('bash', 'shell', 'developer__shell', 'run_shell_command') or 'shell' in name.lower()


def shell_field(parameters):
    properties = (parameters or {}).get('properties') or {}
    return 'command' if 'command' in properties else next(iter(properties), 'command')


def shell_tool(body):
    for tool in body.get('tools') or []:
        function = tool.get('function') or {}
        name = function.get('name', '')
        if is_shell_name(name):
            return name, shell_field(function.get('parameters'))
    return None


def has_tool_result(body):
    return any(message.get('role') == 'tool' for message in body.get('messages') or [])


def responses_shell_tool(body):
    for tool in body.get('tools') or []:
        name = tool.get('name', '')
        if tool.get('type') == 'function' and (is_shell_name(name) or name == 'exec_command'):
            return name, shell_field(tool.get('parameters'))
    return None


def responses_has_tool_result(body):
    return any(isinstance(item, dict) and item.get('type') == 'function_call_output' for item in body.get('input') or [])


def gemini_shell_tool(body):
    for group in body.get('tools') or []:
        for declaration in group.get('functionDeclarations') or []:
            name = declaration.get('name', '')
            if is_shell_name(name):
                return name, shell_field(declaration.get('parameters') or declaration.get('parametersJsonSchema'))
    return None


def gemini_has_tool_result(body):
    return any('functionResponse' in part for content in body.get('contents') or [] for part in content.get('parts') or [])


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
        if self.path.split('?')[0].endswith('/responses'):
            self.answer_responses(body)
            return
        if ':countTokens' in self.path:
            self.send_json({'totalTokens': 1234})
            return
        if ':generateContent' in self.path or ':streamGenerateContent' in self.path:
            self.answer_gemini(body)
            return
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
            message = {'role': 'assistant', 'content': REPLY}
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
        self.send_json({'id': 'chatcmpl-probe', 'object': 'chat.completion', 'created': created, 'model': MODEL,
                        'choices': [{'index': 0, 'message': message, 'finish_reason': finish}], 'usage': usage})

    def send_json(self, value):
        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def start_stream(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def answer_responses(self, body):
        tool = responses_shell_tool(body)
        call_tool = tool is not None and not responses_has_tool_result(body)
        LOG.write(f'POST {self.path} responses tools={len(body.get("tools") or [])} call={call_tool}\n')
        if call_tool:
            name, field = tool
            item = {'type': 'function_call', 'id': 'fc_probe', 'call_id': 'call_probe_1', 'name': name, 'arguments': json.dumps({field: 'echo probe-tool-output'})}
        else:
            item = {'type': 'message', 'id': 'msg_probe', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': REPLY, 'annotations': []}]}
        usage = {'input_tokens': 1234, 'input_tokens_details': {'cached_tokens': 0}, 'output_tokens': 56, 'output_tokens_details': {'reasoning_tokens': 0}, 'total_tokens': 1290}
        self.start_stream()
        for event in (
            {'type': 'response.created', 'response': {'id': 'resp_probe'}},
            {'type': 'response.output_item.done', 'item': item, 'output_index': 0},
            {'type': 'response.completed', 'response': {'id': 'resp_probe', 'usage': usage}},
        ):
            self.wfile.write(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n'.encode())
        self.wfile.flush()

    def answer_gemini(self, body):
        tool = gemini_shell_tool(body)
        call_tool = tool is not None and not gemini_has_tool_result(body)
        LOG.write(f'POST {self.path} gemini call={call_tool}\n')
        if call_tool:
            name, field = tool
            parts = [{'functionCall': {'name': name, 'args': {field: 'echo probe-tool-output'}}}]
        else:
            parts = [{'text': REPLY}]
        reply = {
            'candidates': [{'content': {'role': 'model', 'parts': parts}, 'finishReason': 'STOP', 'index': 0}],
            'usageMetadata': {'promptTokenCount': 1234, 'candidatesTokenCount': 56, 'totalTokenCount': 1290},
            'modelVersion': MODEL,
        }
        if ':streamGenerateContent' not in self.path:
            self.send_json(reply)
            return
        self.start_stream()
        self.wfile.write(f'data: {json.dumps(reply)}\n\n'.encode())
        self.wfile.flush()


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 18080), Handler).serve_forever()
