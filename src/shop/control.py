"""The shop's control API: what an orchestrator such as Kubernetes offers an operator.

The launcher owns the service processes, so other programs (Vigil) ask it to act through this
small HTTP API instead of killing processes themselves:

    GET  /status             each component: running or not, process id, restarts
    POST /restart/<service>  stop the service's process and start a fresh one

It listens on 127.0.0.1 only, and only the four shop services can be restarted.
"""

import json
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONTROL_PORT = 8020
RESTARTABLE = {"storefront", "orders", "payments", "inventory"}


class Platform:
    """Restarts components on request; one restart at a time."""

    def __init__(self, components: list, start: Callable, stop: Callable, ready: Callable):
        self.components = {c.name: c for c in components}
        self._start, self._stop, self._ready = start, stop, ready
        self._lock = threading.Lock()
        self.restarts = dict.fromkeys(self.components, 0)

    def status(self) -> dict:
        return {
            name: {
                "running": c.process is not None and c.process.poll() is None,
                "pid": c.process.pid if c.process is not None else None,
                "restarts": self.restarts[name],
            }
            for name, c in self.components.items()
        }

    def restart(self, name: str) -> dict:
        if name not in RESTARTABLE or name not in self.components:
            raise KeyError(name)
        component = self.components[name]
        with self._lock:
            started = time.monotonic()
            self._stop(component)
            self._start(component)
            ready = self._ready(component)
            component.reported_exit = False
            self.restarts[name] += 1
        seconds = round(time.monotonic() - started, 1)
        return {"service": name, "ready": ready, "seconds": seconds}


def stop_one(component) -> None:
    process = component.process
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except Exception:
        process.kill()
        process.wait(timeout=5)


def serve(platform: Platform, port: int = CONTROL_PORT) -> ThreadingHTTPServer:
    """Start the control API in a background thread and return the server (call shutdown())."""

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/status":
                self._reply(200, platform.status())
            else:
                self._reply(404, {"error": "not found"})

        def do_POST(self) -> None:
            prefix = "/restart/"
            if not self.path.startswith(prefix):
                self._reply(404, {"error": "not found"})
                return
            name = self.path[len(prefix) :]
            try:
                self._reply(200, platform.restart(name))
            except KeyError:
                allowed = sorted(RESTARTABLE & set(platform.components))
                self._reply(400, {"error": f"cannot restart {name!r}", "allowed": allowed})

        def log_message(self, format, *args) -> None:  # keep the launcher's console quiet
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
