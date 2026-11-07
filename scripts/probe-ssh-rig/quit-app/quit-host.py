#!/usr/bin/env python3
"""Stand-in for the #913 helper, used by scripts/probe-ssh-quit.mjs. Not shipped.

Two roles: a per-user `daemon` on a Unix socket that outlives any connection, and a thin `relay`
that `ssh` runs and that pipes stdio into the socket.

  python3 quit-host.py daemon <folder>     records each frame in <folder>/frames.log
  python3 quit-host.py relay <folder>      ssh runs this

The daemon keeps one fake session per run id, which is the whole of its state: `running` from the
hello, `suspended` from a suspendAll (the quit) or a suspend (the next connection's reconcile). Each
frame is logged with the host's clock and flushed before it is acked, so a line in the log means the
frame reached the helper.
"""
import json
import os
import socket
import sys
import threading
import time


def socket_path(folder):
    return os.path.join(folder, "helper.sock")


class Daemon:
    def __init__(self, folder):
        self.lock = threading.Lock()
        self.sessions = {}
        self.log_file = open(os.path.join(folder, "frames.log"), "a", buffering=1)

    def record(self, frame_type, run, byte_count, connection_id):
        entry = {
            "t": time.time() * 1000.0,
            "type": frame_type,
            "run": run,
            "bytes": byte_count,
            "connection": connection_id,
        }
        self.log_file.write(json.dumps(entry) + "\n")
        self.log_file.flush()

    def handle(self, frame, byte_count, connection_id):
        frame_type = frame.get("type")
        run = frame.get("run")
        with self.lock:
            self.record(frame_type, run, byte_count, connection_id)
            if frame_type == "hello":
                if frame.get("register", True):
                    self.sessions[run] = "running"
                return {"type": "ready", "run": run}
            if frame_type == "list":
                scope = frame.get("scope", "")
                running = [
                    session_run
                    for session_run, state in self.sessions.items()
                    if state == "running" and session_run.startswith(scope)
                ]
                return {"type": "list", "runs": running}
            if frame_type in ("suspendAll", "suspend"):
                self.sessions[run] = "suspended"
                return {"type": "ack", "run": run, "of": frame_type}
        return {"type": "unknown"}

    def serve_connection(self, connection, connection_id):
        buffered = b""
        try:
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    return
                buffered += chunk
                while b"\n" in buffered:
                    line, buffered = buffered.split(b"\n", 1)
                    reply = self.handle(json.loads(line), len(line), connection_id)
                    try:
                        connection.sendall((json.dumps(reply) + "\n").encode())
                    except OSError:
                        # The client is gone. Keep reading: frames it wrote may still be queued.
                        pass
        except (OSError, ValueError):
            return
        finally:
            connection.close()


def run_daemon(folder):
    path = socket_path(folder)
    if os.path.exists(path):
        os.unlink(path)
    daemon = Daemon(folder)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(64)
    connection_id = 0
    while True:
        connection, _ = server.accept()
        connection_id += 1
        threading.Thread(
            target=daemon.serve_connection,
            args=(connection, connection_id),
            daemon=True,
        ).start()


def run_relay(folder):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(socket_path(folder))

    def stdin_to_socket():
        while True:
            chunk = os.read(0, 65536)
            if not chunk:
                # EOF from ssh: pass it on and keep reading replies.
                connection.shutdown(socket.SHUT_WR)
                return
            connection.sendall(chunk)

    threading.Thread(target=stdin_to_socket, daemon=True).start()
    try:
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                return
            os.write(1, chunk)
    except OSError:
        return


if __name__ == "__main__":
    role, folder_argument = sys.argv[1], sys.argv[2]
    if role == "daemon":
        run_daemon(folder_argument)
    elif role == "relay":
        run_relay(folder_argument)
    else:
        sys.exit("unknown role: " + role)
