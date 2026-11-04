import socket
import subprocess
import sys

from shop import launch
from shop.config import PORTS
from shop.launch import Component, build_components, port_in_use, wait_ready


def test_services_start_before_their_callers():
    names = [c.name for c in build_components(3, 60, traffic=True)]

    assert names.index("inventory") < names.index("orders")
    assert names.index("payments") < names.index("orders")
    assert names.index("orders") < names.index("storefront")
    assert names[-1] == "traffic"  # customers arrive only once the shop is open


def test_traffic_is_optional_and_gets_the_requested_settings():
    with_traffic = {c.name: c for c in build_components(7.5, 30, traffic=True)}
    without = [c.name for c in build_components(7.5, 30, traffic=False)]

    assert "traffic" not in without
    command = with_traffic["traffic"].command
    assert command[command.index("--rate") + 1] == "7.5"
    assert command[command.index("--cycle-minutes") + 1] == "30"


def test_every_service_uses_its_configured_port():
    components = {c.name: c for c in build_components(3, 60, traffic=False)}

    for name, port in PORTS.items():
        assert components[name].port == port


def test_prometheus_is_skipped_when_not_installed(monkeypatch):
    monkeypatch.setattr(launch, "prometheus_binary", lambda: None)

    names = [c.name for c in build_components(3, 60, traffic=False)]

    assert "prometheus" not in names


def test_port_in_use_detects_a_listener():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        port = server.getsockname()[1]
        assert port_in_use(port)
    assert not port_in_use(port)


def test_wait_ready_gives_up_quickly_when_the_process_dies():
    component = Component("broken", [sys.executable, "-c", "raise SystemExit(3)"], 1, "/health")
    component.process = subprocess.Popen(component.command)

    assert wait_ready(component, timeout=10) is False
    assert component.process.returncode == 3
