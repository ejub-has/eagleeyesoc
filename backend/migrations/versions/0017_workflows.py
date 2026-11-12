"""Workflows: alert-triggered runbooks whose steps run automatically or after approval

A workflow (runbook) matches incoming alerts and starts a run on the alert's case. Each
step calls an action (case actions, webhooks, later identity and device connectors) and
either runs at once or waits for an analyst to approve it. A worker executes queued steps.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-11
"""

from alembic import op

from app.rls import tenant_rls

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | None = None
depends_on: str | None = None

UPGRADE = [
    """
    CREATE TABLE workflows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        enabled boolean NOT NULL DEFAULT true,
        trigger jsonb NOT NULL,
        steps jsonb NOT NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_by text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, name)
    )
    """,
    """
    CREATE TABLE workflow_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants,
        workflow_id uuid NOT NULL REFERENCES workflows,
        workflow_name text NOT NULL,
        case_id uuid NOT NULL REFERENCES cases,
        alert_id uuid REFERENCES alerts,
        status text NOT NULL
            CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
        context jsonb NOT NULL,
        started_by text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
    )
    """,
    "CREATE INDEX workflow_runs_case_idx ON workflow_runs (case_id)",
    "CREATE UNIQUE INDEX workflow_runs_alert_idx ON workflow_runs (workflow_id, alert_id)",
    """
    CREATE TABLE workflow_steps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants,
        run_id uuid NOT NULL REFERENCES workflow_runs,
        position integer NOT NULL,
        name text NOT NULL,
        action text NOT NULL,
        mode text NOT NULL CHECK (mode IN ('auto', 'approval')),
        on_error text NOT NULL CHECK (on_error IN ('stop', 'continue')),
        inputs jsonb NOT NULL,
        status text NOT NULL CHECK (status IN (
            'pending', 'awaiting_approval', 'queued', 'running',
            'succeeded', 'failed', 'skipped', 'rejected'
        )),
        output jsonb,
        error text,
        decided_by text,
        decided_at timestamptz,
        decision_reason text,
        started_at timestamptz,
        finished_at timestamptz,
        UNIQUE (run_id, position)
    )
    """,
    "CREATE INDEX workflow_steps_queued_idx ON workflow_steps (tenant_id) WHERE status = 'queued'",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON workflows TO casemgr_app",
    "GRANT SELECT, INSERT, UPDATE ON workflow_runs, workflow_steps TO casemgr_app",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)
    for table in ("workflows", "workflow_runs", "workflow_steps"):
        for statement in tenant_rls(table):
            op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE workflow_steps, workflow_runs, workflows")
