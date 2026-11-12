from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app import connectors, workflows
from app.actions import ActionFailed
from app.auth import TenantContext, require
from app.connectors import ConnectorIn, ConnectorOut
from app.db import Db
from app.integrations import entra
from app.models import Connector

router = APIRouter(prefix="/api/tenants/{slug}", tags=["connectors"])

Manager = Annotated[TenantContext, require("config:manage")]


@router.get("/connectors")
async def list_connectors(ctx: Manager, db: Db) -> list[ConnectorOut]:
    """Connectors without their secrets; a secret can be replaced but never read back."""
    return [connectors.out(c) for c in await db.scalars(select(Connector).order_by(Connector.key))]


async def _connector(db: Db, connector_id: UUID) -> Connector:
    connector = await db.get(Connector, connector_id)
    if connector is None:
        raise HTTPException(404, "Connector not found")
    return connector


@router.post("/connectors", status_code=201)
async def create_connector(body: ConnectorIn, ctx: Manager, db: Db) -> ConnectorOut:
    if await db.scalar(select(Connector.id).where(Connector.key == body.key)):
        raise HTTPException(409, "A connector with this key already exists")
    if body.secret is None:
        raise HTTPException(422, "A new connector needs its secret")
    now = workflows.now()
    connector = Connector(
        tenant_id=ctx.tenant.id,
        key=body.key,
        kind=body.kind,
        name=body.name,
        settings=body.settings,
        secret=connectors.encrypt(body.secret),
        secret_set_at=now,
        created_by=ctx.principal.actor,
        updated_by=ctx.principal.actor,
        updated_at=now,
    )
    db.add(connector)
    await db.flush()
    await ctx.audit(db, "connector.create", f"connector:{connector.id}", key=body.key)
    return connectors.out(connector)


@router.put("/connectors/{connector_id}")
async def update_connector(
    connector_id: UUID, body: ConnectorIn, ctx: Manager, db: Db
) -> ConnectorOut:
    connector = await _connector(db, connector_id)
    if body.key != connector.key or body.kind != connector.kind:
        raise HTTPException(422, "A connector's key and kind cannot change")
    connector.name, connector.settings = body.name, body.settings
    now = workflows.now()
    if body.secret is not None:
        connector.secret, connector.secret_set_at = connectors.encrypt(body.secret), now
    connector.updated_by, connector.updated_at = ctx.principal.actor, now
    await db.flush()
    await ctx.audit(
        db,
        "connector.update",
        f"connector:{connector.id}",
        key=connector.key,
        secret_replaced=body.secret is not None,
    )
    return connectors.out(connector)


@router.delete("/connectors/{connector_id}", status_code=204)
async def delete_connector(connector_id: UUID, ctx: Manager, db: Db) -> None:
    connector = await _connector(db, connector_id)
    await db.delete(connector)
    await ctx.audit(db, "connector.delete", f"connector:{connector_id}", key=connector.key)


@router.post("/connectors/{connector_id}/test")
async def test_connector(connector_id: UUID, ctx: Manager, db: Db) -> dict[str, str]:
    """Sign in with the connector's credentials, without calling any action."""
    connector = await _connector(db, connector_id)
    try:
        creds = await connectors.credentials(db, connector.kind, connector.key)
        await entra.token(creds, fresh=True)
    except (LookupError, ValueError, ActionFailed) as error:
        await ctx.audit(db, "connector.test", f"connector:{connector.id}", ok=False)
        raise HTTPException(400, str(error)) from error
    await ctx.audit(db, "connector.test", f"connector:{connector.id}", ok=True)
    return {"status": "ok"}
