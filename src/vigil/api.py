"""Vigil's HTTP API, for the war-room UI and other tools.

    GET  /health                          liveness
    GET  /investigations                  every investigation, newest first, in brief
    GET  /investigations/{id}             one investigation in full, with its incident report
    POST /investigations/{id}/review      a human's decision (needs the API token)
    GET  /jobs                            the job queue
    GET  /audit                           every decision about an action, newest first

Reading is open, on 127.0.0.1 only. A review can change the system, so it needs
`Authorization: Bearer <VIGIL_API_TOKEN>`; without a configured token, reviews over the API
are switched off. The API never runs a fix itself: it queues the decision for a worker, so a
request returns at once and a crash mid-fix is recovered like any other job.

Run it with: uv run vigil api
"""

import hmac
import json
import os
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from vigil.actions import AUDIT_LOG, AuditLog
from vigil.investigations import REPORTS_DIR, load_reports
from vigil.worker import enqueue_review

API_PORT = 8030
Service = Literal["storefront", "orders", "payments", "inventory"]


class ReviewRequest(BaseModel):
    verdict: Literal["confirmed", "corrected"]
    notes: str = ""
    approve: bool = Field(False, description="carry out the proposed fix")
    restart: Service | None = Field(None, description="restart this service instead")
    by: str = "api"


def create_app(
    queue=None,
    token: str | None = None,
    reports_dir: Path = REPORTS_DIR,
    audit_log: Path = AUDIT_LOG,
) -> FastAPI:
    app = FastAPI(title="Vigil", description="The AI on-call engineer.")

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
        return [
            {
                "id": r["id"],
                "status": r["status"],
                "alert_at": r["alert_at"],
                "root_cause_service": r["diagnosis"]["root_cause_service"],
                "category": r["diagnosis"]["category"],
                "confidence": r["diagnosis"]["confidence"],
                "proposal": r.get("proposal"),
            }
            for r in reversed(load_reports(reports_dir))
        ]

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

    return app


def main() -> None:
    import uvicorn

    from vigil.investigations import _is_postgres, default_store
    from vigil.queue import Queue

    store = default_store()
    queue = Queue(store) if _is_postgres(store) else None
    app = create_app(queue=queue, token=os.environ.get("VIGIL_API_TOKEN"))
    # 127.0.0.1 unless told otherwise: inside a container it must listen on all interfaces
    # for the host to reach it (the Dockerfile sets VIGIL_API_HOST=0.0.0.0).
    uvicorn.run(app, host=os.environ.get("VIGIL_API_HOST", "127.0.0.1"), port=API_PORT)
