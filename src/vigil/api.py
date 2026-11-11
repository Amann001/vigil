"""Vigil's HTTP API, for the war-room UI and other tools.

    GET  /health                          liveness
    GET  /investigations                  every investigation, newest first, in brief
    GET  /investigations/{id}             one investigation in full, with its incident report
    POST /investigations/{id}/review      a human's decision (needs the API token)
    GET  /jobs                            the job queue
    GET  /audit                           every decision about an action, newest first
    GET  /live                            investigations running now, step by step
    GET  /system                          the live shop's health and the detector's view
    POST /chaos/{service}                 break a service on purpose, for demos (needs the token)
    DELETE /chaos/{service}               stop it
    GET  /                                the war-room UI (ui/dist), when it has been built

Reading is open, on 127.0.0.1 only. A review can change the system, so it needs
`Authorization: Bearer <VIGIL_API_TOKEN>`; without a configured token, reviews over the API
are switched off. The API never runs a fix itself: it queues the decision for a worker, so a
request returns at once and a crash mid-fix is recovered like any other job.

Run it with: uv run vigil api
"""

import hmac
import json
import os
import time
from pathlib import Path
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from vigil.actions import AUDIT_LOG, AuditLog
from vigil.investigations import LIVE_DIR, REPORTS_DIR, load_reports
from vigil.worker import enqueue_review


class PageFiles(StaticFiles):
    """The built war room. Its pages (/war-room, /incidents/<id>, ...) are drawn in the
    browser, so an address that is not a file gets index.html, and the page takes it from there.
    """

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as error:
            # A missing file with an extension (a script, an image) stays a 404.
            if error.status_code != 404 or Path(path).suffix:
                raise
            return await super().get_response("index.html", scope)


API_PORT = 8030
Service = Literal["storefront", "orders", "payments", "inventory"]


class ReviewRequest(BaseModel):
    verdict: Literal["confirmed", "corrected"]
    notes: str = ""
    approve: bool = Field(False, description="carry out the proposed fix")
    restart: Service | None = Field(None, description="restart this service instead")
    by: str = "api"


class ChaosRequest(BaseModel):
    """A fault to inject from the UI's demo controls: the same settings as `shop.chaos`."""

    fault: Literal["latency", "errors", "leak", "crash", "cpu"]
    latency_seconds: float = Field(1.5, ge=0, le=30)
    error_rate: float = Field(0.5, gt=0, le=1)
    leak_mb_per_second: float = Field(10, gt=0, le=100)
    leak_limit_mb: float = Field(600, gt=0, le=4000)
    cpu_seconds: float = Field(0.05, gt=0, le=2)
    duration_seconds: float | None = Field(None, gt=0, le=3600)


LIVE_STATUSES = ("investigating", "acting")
# A running investigation rewrites its timeline after every step, which takes a minute or two
# at most. One untouched for this long belongs to a worker that was stopped mid-job; it is
# shown as stopped rather than as running forever.
STALE_SECONDS = 15 * 60
UI_DIR = Path(__file__).resolve().parents[2] / "ui" / "dist"


def _shop_chaos(service: str, request: ChaosRequest | None) -> dict:
    from shop.chaos import FaultRequest, clear_fault, inject_fault

    if request is None:
        return clear_fault(service)
    return inject_fault(service, FaultRequest(**request.model_dump()))


def create_app(
    queue=None,
    token: str | None = None,
    reports_dir: Path = REPORTS_DIR,
    audit_log: Path = AUDIT_LOG,
    system=None,
    chaos=_shop_chaos,
    ui_dir: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="Vigil", description="The AI on-call engineer.")
    live_dir = reports_dir / LIVE_DIR

    def timelines() -> list[dict]:
        if not live_dir.exists():
            return []
        found = []
        now = time.time()
        for path in live_dir.glob("*.json"):
            try:
                timeline = json.loads(path.read_text(encoding="utf-8"))
                stale = now - path.stat().st_mtime > STALE_SECONDS
            except (OSError, json.JSONDecodeError):  # being replaced right now; next poll
                continue
            if stale and timeline["status"] in LIVE_STATUSES:
                timeline["status"] = "failed"
            found.append(timeline)
        return sorted(found, key=lambda t: t["alert_at"], reverse=True)

    def require_token(authorization: str | None = Header(None)) -> None:
        if not token:
            raise HTTPException(403, "Reviews over the API are off: set VIGIL_API_TOKEN")
        expected = f"Bearer {token}"
        # compare_digest takes the same time whatever the input, so the token cannot be guessed
        # one character at a time from response times.
        if authorization is None or not hmac.compare_digest(authorization, expected):
            raise HTTPException(401, "Missing or wrong API token")

    def find(investigation_id: str) -> dict:
        path = reports_dir / f"{investigation_id}.json"
        running = live_dir / f"{investigation_id}.json"
        if not path.exists() and running.exists():  # still investigating: no report yet
            return next(t for t in timelines() if t["id"] == investigation_id)
        if not path.exists():
            raise HTTPException(404, f"No investigation {investigation_id!r}")
        report = json.loads(path.read_text(encoding="utf-8"))
        markdown = reports_dir / f"{investigation_id}.md"
        if markdown.exists():
            report["incident_report"] = markdown.read_text(encoding="utf-8")
        return report

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "queue": queue is not None}

    @app.get("/investigations")
    def investigations() -> list[dict]:
        finished = [
            {
                "id": r["id"],
                "status": r["status"],
                "alert_at": r["alert_at"],
                "root_cause_service": r["diagnosis"]["root_cause_service"],
                "category": r["diagnosis"]["category"],
                "confidence": r["diagnosis"]["confidence"],
                "proposal": r.get("proposal"),
                "seconds": r.get("seconds"),
                "outcome": (r.get("action") or {}).get("outcome"),
            }
            for r in reversed(load_reports(reports_dir))
        ]
        known = {r["id"] for r in finished}
        running = [
            {"id": t["id"], "status": t["status"], "alert_at": t["alert_at"]}
            for t in timelines()
            if t["id"] not in known and t["status"] in ("investigating", "failed")
        ]
        return sorted(running + finished, key=lambda r: r["alert_at"], reverse=True)

    @app.get("/investigations/{investigation_id}")
    def investigation(investigation_id: str) -> dict:
        return find(investigation_id)

    @app.post(
        "/investigations/{investigation_id}/review",
        status_code=202,
        dependencies=[Depends(require_token)],
    )
    def submit_review(investigation_id: str, request: ReviewRequest) -> dict:
        report = find(investigation_id)
        if report["status"] != "awaiting review":
            raise HTTPException(409, f"Investigation is {report['status']}, not awaiting review")
        if queue is None:
            raise HTTPException(503, "No job queue: set DATABASE_URL so a worker can run it")
        instead = {"action": "restart_service", "service": request.restart}
        decision = {
            "verdict": request.verdict,
            "notes": request.notes,
            "approve": request.approve,
            "by": request.by,
            "instead": instead if request.restart else None,
        }
        job = enqueue_review(queue, investigation_id, decision)
        if job is None:
            raise HTTPException(409, "A review of this investigation is already queued")
        return {"queued": True, "job": job}

    @app.get("/jobs")
    def jobs() -> dict:
        if queue is None:
            return {"counts": {}, "jobs": []}
        return {"counts": queue.counts(), "jobs": queue.jobs(limit=50)}

    @app.get("/audit")
    def audit() -> list[dict]:
        return list(reversed(AuditLog(audit_log).entries()))

    @app.get("/live")
    def live() -> list[dict]:
        return [t for t in timelines() if t["status"] in LIVE_STATUSES]

    @app.get("/system")
    def system_view() -> dict:
        if system is None:
            return {"online": False}
        return system.snapshot()

    @app.post("/chaos/{service}", dependencies=[Depends(require_token)])
    def inject(service: Service, request: ChaosRequest) -> dict:
        try:
            return chaos(service, request)
        except httpx.HTTPError as error:
            raise HTTPException(503, f"The shop is not reachable: {error}") from error

    @app.delete("/chaos/{service}", dependencies=[Depends(require_token)])
    def clear(service: Service) -> dict:
        try:
            return chaos(service, None)
        except httpx.HTTPError as error:
            raise HTTPException(503, f"The shop is not reachable: {error}") from error

    if ui_dir is not None and (ui_dir / "index.html").exists():
        # Mounted last, so every API route above wins.
        app.mount("/", PageFiles(directory=ui_dir, html=True), name="ui")
    return app


def main() -> None:
    import uvicorn

    from vigil.investigations import _is_postgres, default_store
    from vigil.queue import Queue
    from vigil.system import SystemView
    from vigil.watch import trained_detector

    store = default_store()
    queue = Queue(store) if _is_postgres(store) else None
    app = create_app(
        queue=queue,
        token=os.environ.get("VIGIL_API_TOKEN"),
        system=SystemView(trained_detector),
        ui_dir=UI_DIR,
    )
    if (UI_DIR / "index.html").exists():
        print(f"War room: http://127.0.0.1:{API_PORT}/", flush=True)
    # 127.0.0.1 unless told otherwise: inside a container it must listen on all interfaces
    # for the host to reach it (the Dockerfile sets VIGIL_API_HOST=0.0.0.0).
    uvicorn.run(app, host=os.environ.get("VIGIL_API_HOST", "127.0.0.1"), port=API_PORT)
