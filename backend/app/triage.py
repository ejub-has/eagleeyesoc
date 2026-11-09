"""Alert triage queue (FR-05) with likely duplicates by shared observables (FR-03)."""

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, StringConstraints
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app import cases
from app.auth import TenantContext
from app.cases import CaseCreate
from app.models import Alert, Case, CaseObservable, Observable
from app.observables import ObservableType, defang, extract, strings_in
from app.tenant_config import TenantConfig

QUEUE_LIMIT = 200
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class DismissIn(BaseModel):
    reason: Reason


class PromoteIn(BaseModel):
    reason: Reason
    # Attach to this open case instead of opening a new one from the alert's template.
    into: int | None = None


class Match(BaseModel):
    case_number: int
    case_title: str
    # Shared observables, defanged for display.
    observables: list[str]


class QueuedAlert(BaseModel):
    id: UUID
    source: str
    external_id: str | None
    title: str
    template: str | None
    received_at: datetime
    payload: dict[str, Any]
    matches: list[Match]


class PromoteOut(BaseModel):
    case_number: int
    new_case: bool


def _observables(alert: Alert) -> set[tuple[str, str]]:
    text = "\n".join((alert.title, *strings_in(alert.payload)))
    return {(c.type.value, c.value) for c in extract(text)}


async def _matches(
    db: AsyncSession, ctx: TenantContext, config: TenantConfig, wanted: set[tuple[str, str]]
) -> dict[tuple[str, str], list[tuple[int, str]]]:
    """Open, visible cases linked to each observable."""
    if not wanted:
        return {}
    rows = await db.execute(
        select(Observable.type, Observable.value, Case.number, Case.title)
        .select_from(Case)
        .join(CaseObservable, CaseObservable.case_id == Case.id)
        .join(Observable, Observable.id == CaseObservable.observable_id)
        .where(
            Case.id.in_(cases.visible(ctx).with_only_columns(Case.id)),
            Case.state.not_in(config.terminal_states),
            tuple_(Observable.type, Observable.value).in_(sorted(wanted)),
        )
        .order_by(Case.number)
    )
    found: dict[tuple[str, str], list[tuple[int, str]]] = {}
    for type_, value, number, title in rows:
        found.setdefault((type_, value), []).append((number, title))
    return found


async def queue(db: AsyncSession, ctx: TenantContext, config: TenantConfig) -> list[QueuedAlert]:
    """Alerts waiting for a decision, oldest first, with open cases that share observables."""
    alerts = (
        await db.scalars(
            select(Alert)
            .where(Alert.status == "new")
            .order_by(Alert.received_at, Alert.id)
            .limit(QUEUE_LIMIT)
        )
    ).all()
    per_alert = {a.id: _observables(a) for a in alerts}
    found = await _matches(db, ctx, config, set().union(*per_alert.values()))
    out = []
    for alert in alerts:
        by_case: dict[int, Match] = {}
        for type_, value in sorted(per_alert[alert.id]):
            shown = f"{type_}:{defang(ObservableType(type_), value)}"
            for number, title in found.get((type_, value), []):
                match = by_case.setdefault(
                    number, Match(case_number=number, case_title=title, observables=[])
                )
                match.observables.append(shown)
        out.append(
            QueuedAlert(
                id=alert.id,
                source=alert.source,
                external_id=alert.external_id,
                title=alert.title,
                template=alert.template,
                received_at=alert.received_at,
                payload=alert.payload,
                matches=sorted(by_case.values(), key=lambda m: m.case_number),
            )
        )
    return out


async def _queued(db: AsyncSession, alert_id: UUID) -> Alert:
    alert = await db.scalar(select(Alert).where(Alert.id == alert_id).with_for_update())
    if alert is None:
        raise HTTPException(404, "Alert not found")
    if alert.status != "new":
        raise HTTPException(409, f"Alert was already {alert.status}")
    return alert


def _decide(alert: Alert, ctx: TenantContext, status: str, reason: str) -> None:
    alert.status = status
    alert.decision_reason = reason
    alert.decided_by = ctx.principal.actor
    alert.decided_at = datetime.now(UTC)


async def promote(
    db: AsyncSession, ctx: TenantContext, config: TenantConfig, alert_id: UUID, body: PromoteIn
) -> PromoteOut:
    alert = await _queued(db, alert_id)
    if body.into is not None:
        case = await cases.get_case(db, ctx, body.into)
        if case.state in config.terminal_states:
            cases.invalid("the case is closed", "into")
    else:
        create = CaseCreate(template=alert.template or "", title=alert.title)
        case = await cases.create_case(
            db, ctx.tenant.id, config, ctx.principal.actor, create, source=alert.source
        )
    alert.case_id = case.id
    _decide(alert, ctx, "promoted", body.reason)
    await ctx.audit(db, "alert.promote", f"alert:{alert.id}", case=case.number, reason=body.reason)
    return PromoteOut(case_number=case.number, new_case=body.into is None)


async def dismiss(db: AsyncSession, ctx: TenantContext, alert_id: UUID, body: DismissIn) -> None:
    alert = await _queued(db, alert_id)
    _decide(alert, ctx, "dismissed", body.reason)
    await ctx.audit(db, "alert.dismiss", f"alert:{alert.id}", reason=body.reason)
