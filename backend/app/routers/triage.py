from typing import Annotated
from uuid import UUID

from fastapi import APIRouter

from app import tenant_config, triage
from app.auth import TenantContext, require
from app.db import Db
from app.triage import DismissIn, PromoteIn, PromoteOut, QueuedAlert

router = APIRouter(prefix="/api/tenants/{slug}/triage", tags=["triage"])

Reader = Annotated[TenantContext, require("cases:read")]
Writer = Annotated[TenantContext, require("cases:write")]


@router.get("")
async def list_queue(ctx: Reader, db: Db) -> list[QueuedAlert]:
    """Alerts waiting for a decision (sent with triage on), oldest first."""
    return await triage.queue(db, ctx, await tenant_config.load(db, ctx.tenant.id))


@router.post("/{alert_id}/promote")
async def promote_alert(alert_id: UUID, body: PromoteIn, ctx: Writer, db: Db) -> PromoteOut:
    """Open a case from the alert's template, or attach the alert to an open case."""
    config = await tenant_config.load(db, ctx.tenant.id)
    return await triage.promote(db, ctx, config, alert_id, body)


@router.post("/{alert_id}/dismiss", status_code=204)
async def dismiss_alert(alert_id: UUID, body: DismissIn, ctx: Writer, db: Db) -> None:
    """Close the alert as a false positive or noise, with the reason."""
    await triage.dismiss(db, ctx, alert_id, body)
