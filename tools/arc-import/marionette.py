# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""A minimal Marionette client, enough to run privileged scripts in the
browser without the in-tree client and its dependencies."""

import json
import socket
import time


class MarionetteError(Exception):
    pass


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, timeout=60):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.sock = None
        self.message_id = 0

    def connect(self):
        deadline = time.time() + self.timeout
        while True:
            try:
                self.sock = socket.create_connection((self.host, self.port), timeout=5)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        self.sock.settimeout(None)
        self._read()  # Server hello.
        self.send("WebDriver:NewSession", {"strictFileInteractability": True})
        self.send("Marionette:SetContext", {"value": "chrome"})

    def _read(self):
        length = b""
        while not length.endswith(b":"):
            chunk = self.sock.recv(1)
            if not chunk:
                raise MarionetteError("connection closed")
            length += chunk
        size = int(length[:-1])
        data = b""
        while len(data) < size:
            chunk = self.sock.recv(size - len(data))
            if not chunk:
                raise MarionetteError("connection closed")
            data += chunk
        return json.loads(data)

    def send(self, command, params=None):
        self.message_id += 1
        payload = json.dumps([0, self.message_id, command, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            reply = self._read()
            if isinstance(reply, list) and reply[0] == 1 and reply[1] == self.message_id:
                break
        error, result = reply[2], reply[3]
        if error:
            raise MarionetteError(f"{error.get('error')}: {error.get('message')}\n{error.get('stacktrace', '')}")
        return result

    def execute_async(self, script, args=None, timeout_ms=30 * 60 * 1000):
        self.send("WebDriver:SetTimeouts", {"script": timeout_ms})
        result = self.send(
            "WebDriver:ExecuteAsyncScript",
            {"script": script, "args": args or [], "newSandbox": True},
        )
        return result.get("value")

    def quit(self):
        try:
            self.send("Marionette:Quit", {"flags": ["eAttemptQuit"]})
        except (MarionetteError, OSError):
            pass
        finally:
            self.sock.close()
