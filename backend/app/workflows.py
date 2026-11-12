"""Workflows (runbooks): which alerts start them, their steps, and how a run advances.

A run's steps execute in order. A step whose mode is "auto" is queued for the worker at
once; an "approval" step waits until someone with workflows:approve approves it. A failed
step stops the run unless the step says to continue; a rejected step cancels the run.
"""

import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import actions, audit, journal
from app.models import Alert, Case, Workflow, WorkflowRun, WorkflowStep

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Path = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.\-\[\]]{1,200}$")]
Mode = Literal["auto", "approval"]

DONE = {"succeeded", "failed", "skipped", "rejected"}
TEMPLATE = re.compile(r"\{\{\s*([A-Za-z0-9_.\-\[\]]+)\s*\}\}")


# --- Definitions --------------------------------------------------------------------------


class Condition(BaseModel):
    """A test on one field of the alert, e.g. payload.riskEventType equals passwordSpray."""

    path: Path
    op: Literal["equals", "contains", "exists"] = "equals"
    value: Annotated[str, StringConstraints(max_length=500)] = ""


class Trigger(BaseModel):
    """Every part must match; empty parts match anything."""

    sources: list[Annotated[str, StringConstraints(max_length=40)]] = Field(
        default=[], max_length=20
    )
    title_contains: Annotated[str, StringConstraints(max_length=200)] = ""
    conditions: list[Condition] = Field(default=[], max_length=20)


class StepDef(BaseModel):
    name: Name
    action: str
    mode: Mode | None = None  # None takes the action's default: approval when it changes things
    on_error: Literal["stop", "continue"] = "stop"
    inputs: dict[
        Annotated[str, StringConstraints(max_length=50)],
        Annotated[str, StringConstraints(max_length=20_000)],
    ] = {}

    @model_validator(mode="after")
    def known_action(self) -> Self:
        found = actions.REGISTRY.get(self.action)
        if found is None:
            raise ValueError(f"unknown action {self.action}")
        names = {i.name for i in found.spec.inputs}
        if unknown := set(self.inputs) - names:
            raise ValueError(f"unknown inputs for {self.action}: {', '.join(sorted(unknown))}")
        if self.mode is None:
            self.mode = "approval" if found.spec.impact == "change" else "auto"
        return self


class WorkflowIn(BaseModel):
    name: Name
    description: Annotated[str, StringConstraints(max_length=2000)] = ""
    enabled: bool = True
    trigger: Trigger
    steps: list[StepDef] = Field(min_length=1, max_length=30)


class WorkflowOut(WorkflowIn):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    updated_by: str
    updated_at: datetime


class StepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    position: int
    name: str
    action: str
    mode: Mode
    on_error: str
    inputs: dict[str, Any]
    status: str
    output: dict[str, Any] | None
    error: str | None
    decided_by: str | None
    decided_at: datetime | None
    decision_reason: str | None
    started_at: datetime | None
    finished_at: datetime | None


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    workflow_id: UUID
    workflow_name: str
    case_number: int
    alert_id: UUID | None
    status: str
    started_by: str
    started_at: datetime
    finished_at: datetime | None
    steps: list[StepOut]


class DecisionIn(BaseModel):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] = ""


class StartIn(BaseModel):
    workflow_id: UUID


def now() -> datetime:
    return datetime.now(UTC)


# --- Matching and templates ---------------------------------------------------------------


def lookup(data: Any, path: str) -> Any:
    """Follow a dotted path (list items as [0] or .0) through dicts and lists; None if absent."""
    for part in re.split(r"\.|\[(\d+)\]", path):
        if not part:
            continue
        if isinstance(data, dict):
            data = data.get(part)
        elif isinstance(data, list) and part.isdigit() and int(part) < len(data):
            data = data[int(part)]
        else:
            return None
    return data


def context(case: Case, alert: Alert | None) -> dict[str, Any]:
    """What templates and conditions can read: the alert as received and the case basics."""
    return {
        "alert": None
        if alert is None
        else {
            "id": str(alert.id),
            "title": alert.title,
            "source": alert.source,
            "external_id": alert.external_id,
            "group_key": alert.group_key,
            "payload": alert.payload,
        },
        "case": {
            "number": case.number,
            "title": case.title,
            "severity": case.severity,
            "priority": case.priority,
        },
    }


def render(template: str, data: dict[str, Any]) -> Any:
    """Fill {{path}} placeholders. A template that is one placeholder keeps the value's type."""
    whole = TEMPLATE.fullmatch(template.strip())
    if whole:
        return lookup(data, whole.group(1))

    def fill(match: re.Match[str]) -> str:
        value = lookup(data, match.group(1))
        return "" if value is None else str(value)

    return TEMPLATE.sub(fill, template)


def matches(trigger: Trigger, alert: Alert) -> bool:
    if trigger.sources and alert.source not in trigger.sources:
        return False
    if trigger.title_contains and trigger.title_contains.lower() not in alert.title.lower():
        return False
    data = {"payload": alert.payload, "title": alert.title, "source": alert.source}
    for condition in trigger.conditions:
        value = lookup(data, condition.path)
        if condition.op == "exists":
            ok = value is not None
        elif value is None:
            ok = False
        elif condition.op == "equals":
            ok = str(value).lower() == condition.value.lower()
        else:
            ok = condition.value.lower() in str(value).lower()
        if not ok:
            return False
    return True


# --- Runs ---------------------------------------------------------------------------------


async def start(
    db: AsyncSession,
    workflow: Workflow,
    case: Case,
    alert: Alert | None,
    actor: str,
    manual: bool = False,
) -> WorkflowRun:
    """Start a run. Templates read the alert; a manual run reads it without claiming it,
    so the alert's own automatic run (one per workflow and alert) stays distinct."""
    data = context(case, alert)
    run = WorkflowRun(
        tenant_id=case.tenant_id,
        workflow_id=workflow.id,
        workflow_name=workflow.name,
        case_id=case.id,
        alert_id=alert.id if alert and not manual else None,
        status="running",
        context=data,
        started_by=actor,
    )
    db.add(run)
    await db.flush()
    for position, raw in enumerate(workflow.steps):
        step = StepDef.model_validate(raw)
        db.add(
            WorkflowStep(
                tenant_id=case.tenant_id,
                run_id=run.id,
                position=position,
                name=step.name,
                action=step.action,
                mode=step.mode,
                on_error=step.on_error,
                inputs={name: render(value, data) for name, value in step.inputs.items()},
                status="pending",
            )
        )
    await db.flush()
    await audit.record(
        db,
        actor,
        "workflow.start",
        f"workflow_run:{run.id}",
        case.tenant_id,
        {"workflow": workflow.name, "case": case.number, "manual": manual},
    )
    await advance(db, run)
    return run


async def steps_of(db: AsyncSession, run: WorkflowRun) -> list[WorkflowStep]:
    query = select(WorkflowStep).where(WorkflowStep.run_id == run.id)
    return list(await db.scalars(query.order_by(WorkflowStep.position)))


async def advance(db: AsyncSession, run: WorkflowRun) -> None:
    """Move the run to its next step: queue it, wait for approval, or finish."""
    for step in await steps_of(db, run):
        if step.status in DONE:
            continue
        if step.status == "pending":
            step.status = "queued" if step.mode == "auto" else "awaiting_approval"
        run.status = "waiting" if step.status == "awaiting_approval" else "running"
        await db.flush()
        return
    _finish(run, "succeeded")
    await db.flush()


def _finish(run: WorkflowRun, status: str) -> None:
    run.status = status
    run.finished_at = now()


async def _stop(db: AsyncSession, run: WorkflowRun, status: str) -> None:
    for step in await steps_of(db, run):
        if step.status not in DONE:
            step.status = "skipped"
    _finish(run, status)
    await db.flush()


async def decide(
    db: AsyncSession, run: WorkflowRun, step: WorkflowStep, actor: str, approve: bool, reason: str
) -> None:
    step.decided_by = actor
    step.decided_at = now()
    step.decision_reason = reason or None
    if approve:
        step.status = "queued"
        run.status = "running"
        await db.flush()
    else:
        step.status = "rejected"
        await _stop(db, run, "cancelled")


async def cancel(db: AsyncSession, run: WorkflowRun) -> None:
    await _stop(db, run, "cancelled")


async def execute(db: AsyncSession, run: WorkflowRun, step: WorkflowStep, case: Case) -> None:
    """Run one queued step, record the outcome on the step and the case timeline, advance."""
    found = actions.REGISTRY.get(step.action)
    actor = f"workflow:{run.id}"
    step.status = "running"
    step.started_at = now()
    await db.flush()
    try:
        if found is None:
            raise actions.ActionFailed(f"unknown action {step.action}")
        step.output = await found.run(actions.ActionContext(db, case, run, actor), step.inputs)
        step.status = "succeeded"
    except actions.ActionFailed as error:
        step.status, step.error = "failed", str(error)
    except Exception as error:  # an unexpected bug in an action must not wedge the run
        step.status, step.error = "failed", f"unexpected error: {type(error).__name__}"
    step.finished_at = finished = now()
    await journal.add_event(
        db,
        case,
        actor,
        journal.TimelineIn(
            occurred_at=finished,
            source="workflow",
            description=f"{run.workflow_name}: {step.name} {step.status}"
            + (f" ({step.error})" if step.error else ""),
        ),
    )
    await audit.record(
        db,
        actor,
        f"workflow.step.{step.status}",
        f"workflow_step:{step.id}",
        case.tenant_id,
        {"action": step.action, "case": case.number}
        | ({"error": step.error} if step.error else {}),
    )
    if step.status == "failed" and step.on_error == "stop":
        await _stop(db, run, "failed")
    else:
        await advance(db, run)


async def on_alert(db: AsyncSession, case: Case, alert: Alert, actor: str) -> list[WorkflowRun]:
    """Start every enabled workflow whose trigger matches an alert attached to a case."""
    started = []
    for workflow in await db.scalars(
        select(Workflow).where(Workflow.enabled.is_(True)).order_by(Workflow.name)
    ):
        if matches(Trigger.model_validate(workflow.trigger), alert):
            started.append(await start(db, workflow, case, alert, actor))
    return started


async def runs_for_case(db: AsyncSession, case: Case) -> list[RunOut]:
    runs = await db.scalars(
        select(WorkflowRun)
        .where(WorkflowRun.case_id == case.id)
        .order_by(WorkflowRun.started_at.desc())
    )
    return [await run_out(db, run, case.number) for run in runs]


async def run_out(db: AsyncSession, run: WorkflowRun, case_number: int) -> RunOut:
    steps = [StepOut.model_validate(s) for s in await steps_of(db, run)]
    return RunOut(
        id=run.id,
        workflow_id=run.workflow_id,
        workflow_name=run.workflow_name,
        case_number=case_number,
        alert_id=run.alert_id,
        status=run.status,
        started_by=run.started_by,
        started_at=run.started_at,
        finished_at=run.finished_at,
        steps=steps,
    )
