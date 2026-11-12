"""Execute queued workflow steps: one pass (`workflows`) or continuously (`workflow_worker`)."""

import asyncio
import json
from uuid import UUID

from sqlalchemy import select

from app import workflows
from app.db import SessionLocal, set_tenant
from app.models import Case, Tenant, WorkflowRun, WorkflowStep

IDLE_SECONDS = 2.0


async def _next(tenant_id: UUID) -> bool:
    """Execute one queued step of the tenant in its own transaction; False when none is left."""
    async with SessionLocal() as db:
        await set_tenant(db, tenant_id)
        step = await db.scalar(
            select(WorkflowStep)
            .where(WorkflowStep.status == "queued")
            .order_by(WorkflowStep.run_id, WorkflowStep.position)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if step is None:
            return False
        run = await db.get_one(WorkflowRun, step.run_id)
        case = await db.get_one(Case, run.case_id)
        await workflows.execute(db, run, step, case)
        await db.commit()
        return True


async def run_once() -> int:
    """Execute every queued step (and the auto steps they unlock); returns how many ran."""
    async with SessionLocal() as db:
        tenant_ids = list(await db.scalars(select(Tenant.id).order_by(Tenant.slug)))
    executed = 0
    for tenant_id in tenant_ids:
        while await _next(tenant_id):
            executed += 1
    return executed


async def run() -> int:
    print(json.dumps({"job": "workflows", "executed": await run_once()}))
    return 0


async def worker() -> int:
    """Poll for queued steps until stopped; runs as its own deployment beside the API."""
    while True:
        try:
            executed = await run_once()
        except Exception as error:  # keep serving after a database hiccup
            print(json.dumps({"job": "workflow_worker", "error": type(error).__name__}))
            executed = 0
        if not executed:
            await asyncio.sleep(IDLE_SECONDS)
