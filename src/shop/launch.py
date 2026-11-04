"""Start the whole demo system with one command: 4 services, Prometheus and simulated customers.

Run it with: uv run python -m shop.launch
Stop everything with Ctrl+C.

Components that die are reported but deliberately not restarted: restarting a crashed service
is a fix Vigil should propose and a human should approve.
"""

import argparse
import contextlib
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import httpx

from shop.config import DATA_DIR, PORTS, PROJECT_ROOT
from shop.traffic import METRICS_PORT as TRAFFIC_PORT

PROMETHEUS_PORT = 9090
STARTUP_TIMEOUT_SECONDS = 30
# Started so that nothing comes up while something it calls is still down.
SERVICE_ORDER = ["inventory", "payments", "orders", "storefront"]
STDERR_DIR = DATA_DIR / "launch"


@dataclass
class Component:
    name: str
    command: list[str]
    port: int
    ready_path: str
    process: subprocess.Popen | None = field(default=None, repr=False)
    reported_exit: bool = False

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def prometheus_binary() -> Path | None:
    for name in ("prometheus.exe", "prometheus"):
        if (path := PROJECT_ROOT / "bin" / name).exists():
            return path
    return None


def build_components(rate: float, cycle_minutes: float, traffic: bool) -> list[Component]:
    python = sys.executable
    components = [
        Component(name, [python, "-m", f"shop.{name}"], PORTS[name], "/health")
        for name in SERVICE_ORDER
    ]
    if (binary := prometheus_binary()) is not None:
        components.append(
            Component(
                "prometheus",
                [
                    str(binary),
                    f"--config.file={PROJECT_ROOT / 'monitoring' / 'prometheus.yml'}",
                    f"--storage.tsdb.path={DATA_DIR / 'prometheus'}",
                    "--storage.tsdb.retention.time=2d",
                    "--storage.tsdb.retention.size=500MB",
                    f"--web.listen-address=127.0.0.1:{PROMETHEUS_PORT}",
                ],
                PROMETHEUS_PORT,
                "/-/ready",
            )
        )
    if traffic:
        command = [python, "-m", "shop.traffic", "--rate", str(rate)]
        command += ["--cycle-minutes", str(cycle_minutes)]
        components.append(Component("traffic", command, TRAFFIC_PORT, "/metrics"))
    return components


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_ready(component: Component, timeout: float = STARTUP_TIMEOUT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if component.process is not None and component.process.poll() is not None:
            return False
        with contextlib.suppress(httpx.HTTPError):
            if httpx.get(component.url + component.ready_path, timeout=1).status_code == 200:
                return True
        time.sleep(0.25)
    return False


def start(component: Component) -> None:
    STDERR_DIR.mkdir(parents=True, exist_ok=True)
    # Services write their own JSON logs; stderr is kept only to debug startup failures.
    with (STDERR_DIR / f"{component.name}.stderr.log").open("w", encoding="utf-8") as stderr:
        component.process = subprocess.Popen(
            component.command, cwd=PROJECT_ROOT, stdout=subprocess.DEVNULL, stderr=stderr
        )


def stop_all(components: list[Component]) -> None:
    running = [c for c in components if c.process is not None and c.process.poll() is None]
    for component in running:
        component.process.terminate()
    for component in running:
        try:
            component.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            component.process.kill()


def report_exits(components: list[Component]) -> None:
    for component in components:
        code = component.process.poll() if component.process is not None else None
        if code is not None and not component.reported_exit:
            component.reported_exit = True
            stamp = datetime.now().strftime("%H:%M:%S")
            print(f"[{stamp}] {component.name} exited with code {code} (not restarted)")


def _raise_interrupt(signum, frame) -> None:
    raise KeyboardInterrupt


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the demo shop, Prometheus and customers.")
    parser.add_argument("--rate", type=float, default=3.0, help="average customer sessions/s")
    parser.add_argument("--cycle-minutes", type=float, default=60, help="one simulated day")
    parser.add_argument("--no-traffic", action="store_true", help="don't start customers")
    args = parser.parse_args()

    # Treat "please stop" signals like Ctrl+C, so children are always cleaned up.
    signal.signal(signal.SIGTERM, _raise_interrupt)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _raise_interrupt)

    components = build_components(args.rate, args.cycle_minutes, traffic=not args.no_traffic)
    if busy := [c for c in components if port_in_use(c.port)]:
        names = ", ".join(f"{c.name} (port {c.port})" for c in busy)
        sys.exit(f"Ports already in use: {names}. Is the shop already running?")
    if prometheus_binary() is None:
        print("Prometheus not found in bin/: run `uv run python scripts/install_prometheus.py`")

    try:
        for component in components:
            start(component)
            if not wait_ready(component):
                log = STDERR_DIR / f"{component.name}.stderr.log"
                sys.exit(f"{component.name} failed to start. Details: {log}")
            print(f"  started {component.name:<11} {component.url}")

        print("\nVigil demo system is running. Press Ctrl+C to stop.")
        print(f"  shop API docs   http://127.0.0.1:{PORTS['storefront']}/docs")
        if prometheus_binary() is not None:
            print(f"  Prometheus      http://127.0.0.1:{PROMETHEUS_PORT}")
        print("  break something uv run python -m shop.chaos --help\n")
        while True:
            report_exits(components)
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        stop_all(components)


if __name__ == "__main__":
    main()
