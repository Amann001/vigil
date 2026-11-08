from dataclasses import dataclass

import httpx
import pytest

from shop.control import RESTARTABLE, Platform, serve


class FakeProcess:
    count = 0

    def __init__(self):
        FakeProcess.count += 1
        self.pid = 1000 + FakeProcess.count
        self.alive = True

    def poll(self):
        return None if self.alive else 0


@dataclass
class FakeComponent:
    name: str
    process: FakeProcess | None = None
    reported_exit: bool = False


def platform(stopped: list):
    components = [FakeComponent(name, FakeProcess()) for name in ("orders", "prometheus")]

    def stop(component):
        stopped.append(component.process.pid)
        component.process.alive = False

    def start(component):
        component.process = FakeProcess()

    return Platform(components, start=start, stop=stop, ready=lambda component: True)


@pytest.fixture
def api():
    stopped = []
    server = serve(platform(stopped), port=0)  # port 0: any free port
    host, port = server.server_address
    with httpx.Client(base_url=f"http://{host}:{port}") as client:
        yield client, stopped
    server.shutdown()


def test_restart_replaces_the_process(api):
    client, stopped = api
    before = client.get("/status").json()["orders"]["pid"]

    reply = client.post("/restart/orders")

    after = client.get("/status").json()["orders"]
    assert reply.status_code == 200 and reply.json()["ready"] is True
    assert stopped == [before]
    assert after["pid"] != before and after["running"] and after["restarts"] == 1


def test_only_shop_services_can_be_restarted(api):
    client, stopped = api

    reply = client.post("/restart/prometheus")

    assert reply.status_code == 400
    assert reply.json()["allowed"] == ["orders"]
    assert client.post("/restart/payments").status_code == 400  # not managed here
    assert stopped == []
    assert "prometheus" not in RESTARTABLE


def test_unknown_paths_are_rejected(api):
    client, _ = api

    assert client.get("/restart/orders").status_code == 404
    assert client.post("/shutdown").status_code == 404
