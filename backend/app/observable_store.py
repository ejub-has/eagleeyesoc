"""Observables linked to cases, and correlation across a tenant's cases."""

from collections.abc import Sequence
from datetime import datetime
from enum import StrEnum
from typing import Annotated
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import Select, delete, distinct, func, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Case, CaseObservable, Observable
from app.observables import Candidate, ObservableType, defang


class ObservableIn(BaseModel):
    type: ObservableType
    value: Annotated[str, StringConstraints(min_length=1, max_length=2000)]


class LinkIn(BaseModel):
    observables: list[ObservableIn] = Field(min_length=1, max_length=500)


class ExtractIn(BaseModel):
    """Text to extract from; when omitted, the case's alerts are used."""

    text: Annotated[str, StringConstraints(max_length=1_000_000)] | None = None


class CandidateOut(Candidate):
    defanged: str
    linked: bool


class Verdict(StrEnum):
    MALICIOUS = "malicious"
    SUSPICIOUS = "suspicious"
    BENIGN = "benign"
    UNKNOWN = "unknown"


class VerdictIn(BaseModel):
    """A verdict for the whole tenant; unknown clears confidence and expiry."""

    verdict: Verdict
    confidence: Annotated[int, Field(ge=0, le=100)] | None = None
    expires_at: AwareDatetime | None = None  # reads as unknown again from this moment
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None


class VerdictOut(BaseModel):
    verdict: Verdict  # in effect now: unknown once the verdict has expired
    expired: bool  # a verdict was set but its expiry has passed
    set_verdict: Verdict  # as last set, even if expired
    confidence: int | None
    expires_at: datetime | None
    note: str | None
    set_by: str | None  # actor, e.g. user:<id>
    set_at: datetime | None


def verdict_out(observable: Observable, now: datetime) -> VerdictOut:
    expires = observable.verdict_expires_at
    expired = expires is not None and expires <= now and observable.verdict != Verdict.UNKNOWN
    return VerdictOut(
        verdict=Verdict.UNKNOWN if expired else Verdict(observable.verdict),
        expired=expired,
        set_verdict=Verdict(observable.verdict),
        confidence=observable.confidence,
        expires_at=expires,
        note=observable.verdict_note,
        set_by=observable.verdict_by,
        set_at=observable.verdict_at,
    )


async def set_verdict(
    db: AsyncSession, observable: Observable, body: VerdictIn, actor: str, now: datetime
) -> None:
    unknown = body.verdict is Verdict.UNKNOWN
    observable.verdict = body.verdict
    observable.confidence = None if unknown else body.confidence
    observable.verdict_expires_at = None if unknown else body.expires_at
    observable.verdict_note = body.note or None
    observable.verdict_by = actor
    observable.verdict_at = now
    await db.flush()


class ObservableOut(BaseModel):
    id: UUID
    type: ObservableType
    value: str
    defanged: str
    other_cases: int  # other cases the viewer can see that share this observable
    verdict: VerdictOut


class ObservableCase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    number: int
    title: str
    state: str
    severity: str
    created_at: datetime


class ObservablePage(BaseModel):
    id: UUID
    type: ObservableType
    value: str
    defanged: str
    verdict: VerdictOut
    cases: list[ObservableCase]


def _visible[*Ts](query: Select[*Ts], show_restricted: bool) -> Select[*Ts]:
    """Hide restricted cases from viewers without the permission; the query must join Case."""
    return query if show_restricted else query.where(Case.restricted.is_(False))


async def linked_values(db: AsyncSession, case: Case) -> set[tuple[str, str]]:
    rows = await db.execute(
        select(Observable.type, Observable.value)
        .join(CaseObservable, CaseObservable.observable_id == Observable.id)
        .where(CaseObservable.case_id == case.id)
    )
    return {(type_, value) for type_, value in rows}


async def link(db: AsyncSession, case: Case, items: Sequence[tuple[str, str]]) -> list[UUID]:
    """Link normalized (type, value) pairs to the case, creating observables as needed."""
    await db.execute(
        insert(Observable)
        .values([{"tenant_id": case.tenant_id, "type": t, "value": v} for t, v in items])
        .on_conflict_do_nothing()
    )
    ids = list(
        await db.scalars(
            select(Observable.id).where(tuple_(Observable.type, Observable.value).in_(items))
        )
    )
    await db.execute(
        insert(CaseObservable)
        .values(
            [{"case_id": case.id, "observable_id": i, "tenant_id": case.tenant_id} for i in ids]
        )
        .on_conflict_do_nothing()
    )
    return ids


async def unlink(db: AsyncSession, case: Case, observable_id: UUID) -> bool:
    removed = await db.scalar(
        delete(CaseObservable)
        .where(CaseObservable.case_id == case.id, CaseObservable.observable_id == observable_id)
        .returning(CaseObservable.observable_id)
    )
    return removed is not None


async def move(
    db: AsyncSession, source: Case, target: Case, ids: Sequence[UUID] | None
) -> list[str]:
    """Move observable links from source to target; None moves them all."""
    links = delete(CaseObservable).where(CaseObservable.case_id == source.id)
    if ids is not None:
        links = links.where(CaseObservable.observable_id.in_(ids))
    moved = (await db.scalars(links.returning(CaseObservable.observable_id))).all()
    if moved:
        await db.execute(
            insert(CaseObservable)
            .values([{"case_id": target.id, "observable_id": o, "tenant_id": target.tenant_id}
                     for o in moved])
            .on_conflict_do_nothing()
        )  # fmt: skip
    return sorted(map(str, moved))


async def own_ids(db: AsyncSession, case: Case) -> set[UUID]:
    query = select(CaseObservable.observable_id).where(CaseObservable.case_id == case.id)
    return set(await db.scalars(query))


async def for_case(
    db: AsyncSession, case: Case, show_restricted: bool, now: datetime
) -> list[ObservableOut]:
    observables = (
        await db.scalars(
            select(Observable)
            .join(CaseObservable, CaseObservable.observable_id == Observable.id)
            .where(CaseObservable.case_id == case.id)
            .order_by(Observable.type, Observable.value)
        )
    ).all()
    counts = dict(
        (
            await db.execute(
                _visible(
                    select(CaseObservable.observable_id, func.count(distinct(Case.id)))
                    .join(Case, Case.id == CaseObservable.case_id)
                    .where(
                        CaseObservable.observable_id.in_([o.id for o in observables]),
                        Case.id != case.id,
                    )
                    .group_by(CaseObservable.observable_id),
                    show_restricted,
                )
            )
        ).all()
    )
    return [
        ObservableOut(
            id=o.id,
            type=ObservableType(o.type),
            value=o.value,
            defanged=defang(ObservableType(o.type), o.value),
            other_cases=counts.get(o.id, 0),
            verdict=verdict_out(o, now),
        )
        for o in observables
    ]


async def page(
    db: AsyncSession, observable_id: UUID, show_restricted: bool, now: datetime
) -> ObservablePage | None:
    observable = await db.get(Observable, observable_id)
    if observable is None:
        return None
    cases = await db.scalars(
        _visible(
            select(Case)
            .join(CaseObservable, CaseObservable.case_id == Case.id)
            .where(CaseObservable.observable_id == observable_id)
            .order_by(Case.created_at.desc()),
            show_restricted,
        )
    )
    type_ = ObservableType(observable.type)
    return ObservablePage(
        id=observable.id,
        type=type_,
        value=observable.value,
        defanged=defang(type_, observable.value),
        verdict=verdict_out(observable, now),
        cases=[ObservableCase.model_validate(c) for c in cases],
    )
