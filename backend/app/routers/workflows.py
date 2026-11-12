from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from app import actions, cases, workflows
from app.auth import TenantContext, require
from app.db import Db
from app.models import Alert, Case, Workflow, WorkflowRun, WorkflowStep
from app.workflows import DecisionIn, RunOut, StartIn, WorkflowIn, WorkflowOut

router = APIRouter(prefix="/api/tenants/{slug}", tags=["workflows"])

Reader = Annotated[TenantContext, require("cases:read")]
Writer = Annotated[TenantContext, require("cases:write")]
Manager = Annotated[TenantContext, require("config:manage")]
Approver = Annotated[TenantContext, require("workflows:approve")]


@router.get("/workflow-actions")
async def list_actions(ctx: Reader) -> list[actions.ActionSpec]:
    """The actions a workflow step can run."""
    return actions.catalog()


@router.get("/workflows")
async def list_workflows(ctx: Reader, db: Db) -> list[WorkflowOut]:
    found = await db.scalars(select(Workflow).order_by(Workflow.name))
    return [WorkflowOut.model_validate(w) for w in found]


async def _name_free(db: Db, name: str, other_than: UUID | None = None) -> None:
    clash = await db.scalar(select(Workflow.id).where(Workflow.name == name))
    if clash is not None and clash != other_than:
        raise HTTPException(409, "A workflow with this name already exists")


@router.post("/workflows", status_code=201)
async def create_workflow(body: WorkflowIn, ctx: Manager, db: Db) -> WorkflowOut:
    await _name_free(db, body.name)
    actor = ctx.principal.actor
    workflow = Workflow(
        tenant_id=ctx.tenant.id,
        created_by=actor,
        updated_by=actor,
        **body.model_dump(),
    )
    db.add(workflow)
    await db.flush()
    await db.refresh(workflow)
    await ctx.audit(db, "workflow.create", f"workflow:{workflow.id}", name=workflow.name)
    return WorkflowOut.model_validate(workflow)


async def _workflow(db: Db, workflow_id: UUID) -> Workflow:
    workflow = await db.get(Workflow, workflow_id)
    if workflow is None:
        raise HTTPException(404, "Workflow not found")
    return workflow


@router.put("/workflows/{workflow_id}")
async def update_workflow(workflow_id: UUID, body: WorkflowIn, ctx: Manager, db: Db) -> WorkflowOut:
    """Replace a workflow; runs already started keep the steps they started with."""
    workflow = await _workflow(db, workflow_id)
    await _name_free(db, body.name, workflow.id)
    for field, value in body.model_dump().items():
        setattr(workflow, field, value)
    workflow.updated_by = ctx.principal.actor
    workflow.updated_at = workflows.now()
    await db.flush()
    await ctx.audit(db, "workflow.update", f"workflow:{workflow.id}", name=workflow.name)
    return WorkflowOut.model_validate(workflow)


@router.delete("/workflows/{workflow_id}", status_code=204)
async def delete_workflow(workflow_id: UUID, ctx: Manager, db: Db) -> None:
    workflow = await _workflow(db, workflow_id)
    if await db.scalar(select(WorkflowRun.id).where(WorkflowRun.workflow_id == workflow.id)):
        raise HTTPException(409, "This workflow has runs; disable it instead")
    await db.delete(workflow)
    await ctx.audit(db, "workflow.delete", f"workflow:{workflow_id}", name=workflow.name)


@router.get("/workflow-runs")
async def recent_runs(
    ctx: Reader, db: Db, limit: Annotated[int, Query(ge=1, le=200)] = 50
) -> list[RunOut]:
    """Recent runs across the tenant, newest first, on cases the viewer can see."""
    rows = await db.execute(
        select(WorkflowRun, Case.number)
        .join(Case, Case.id == WorkflowRun.case_id)
        .where(Case.id.in_(cases.visible(ctx).with_only_columns(Case.id)))
        .order_by(WorkflowRun.started_at.desc())
        .limit(limit)
    )
    return [await workflows.run_out(db, run, number) for run, number in rows.tuples()]


@router.get("/cases/{number}/workflow-runs")
async def case_runs(number: int, ctx: Reader, db: Db) -> list[RunOut]:
    case = await cases.get_case(db, ctx, number)
    return await workflows.runs_for_case(db, case)


@router.post("/cases/{number}/workflow-runs", status_code=201)
async def start_run(number: int, body: StartIn, ctx: Writer, db: Db) -> RunOut:
    """Run a workflow on a case by hand; templates read the case's latest alert, if any."""
    case = await cases.get_case(db, ctx, number)
    workflow = await _workflow(db, body.workflow_id)
    alert = await db.scalar(
        select(Alert).where(Alert.case_id == case.id).order_by(Alert.received_at.desc()).limit(1)
    )
    run = await workflows.start(db, workflow, case, alert, ctx.principal.actor, manual=True)
    return await workflows.run_out(db, run, case.number)


async def _run(db: Db, ctx: TenantContext, run_id: UUID) -> tuple[WorkflowRun, Case]:
    run = await db.get(WorkflowRun, run_id)
    number = await db.scalar(select(Case.number).where(Case.id == run.case_id)) if run else None
    if run is None or number is None:
        raise HTTPException(404, "Workflow run not found")
    return run, await cases.get_case(db, ctx, number)


async def _decide(
    db: Db, ctx: TenantContext, run_id: UUID, step_id: UUID, approve: bool, reason: str
) -> RunOut:
    run, case = await _run(db, ctx, run_id)
    step = await db.get(WorkflowStep, step_id)
    if step is None or step.run_id != run.id:
        raise HTTPException(404, "Step not found")
    if step.status != "awaiting_approval":
        raise HTTPException(409, "This step is not waiting for approval")
    await workflows.decide(db, run, step, ctx.principal.actor, approve, reason)
    await ctx.audit(
        db,
        "workflow.step.approve" if approve else "workflow.step.reject",
        f"workflow_step:{step.id}",
        case=case.number,
        action=step.action,
        reason=reason,
    )
    return await workflows.run_out(db, run, case.number)


@router.post("/workflow-runs/{run_id}/steps/{step_id}/approve")
async def approve_step(
    run_id: UUID, step_id: UUID, body: DecisionIn, ctx: Approver, db: Db
) -> RunOut:
    return await _decide(db, ctx, run_id, step_id, True, body.reason)


@router.post("/workflow-runs/{run_id}/steps/{step_id}/reject")
async def reject_step(
    run_id: UUID, step_id: UUID, body: DecisionIn, ctx: Approver, db: Db
) -> RunOut:
    return await _decide(db, ctx, run_id, step_id, False, body.reason)


@router.post("/workflow-runs/{run_id}/cancel")
async def cancel_run(run_id: UUID, ctx: Writer, db: Db) -> RunOut:
    run, case = await _run(db, ctx, run_id)
    if run.status in ("succeeded", "failed", "cancelled"):
        raise HTTPException(409, "This run has already finished")
    await workflows.cancel(db, run)
    await ctx.audit(db, "workflow.cancel", f"workflow_run:{run.id}", case=case.number)
    return await workflows.run_out(db, run, case.number)
