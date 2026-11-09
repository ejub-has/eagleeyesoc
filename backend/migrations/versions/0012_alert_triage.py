"""alert triage queue

Alerts sent with triage on wait in a queue without a case until an analyst promotes them
(to a new case or an existing one) or dismisses them, each with a reason (FR-05).
Existing alerts all belong to a case, so they start as promoted.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-09
"""

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | None = None
depends_on: str | None = None

UPGRADE = [
    "ALTER TABLE alerts ALTER COLUMN case_id DROP NOT NULL",
    """
    ALTER TABLE alerts
        ADD COLUMN status text NOT NULL DEFAULT 'promoted'
            CHECK (status IN ('new', 'promoted', 'dismissed')),
        ADD COLUMN template text,
        ADD COLUMN decision_reason text,
        ADD COLUMN decided_by text,
        ADD COLUMN decided_at timestamptz,
        ADD CONSTRAINT alerts_case_matches_status CHECK ((status = 'promoted') = (case_id IS NOT NULL))
    """,
    "CREATE INDEX alerts_queue_idx ON alerts (tenant_id, received_at) WHERE status = 'new'",
]

DOWNGRADE = [
    "DROP INDEX alerts_queue_idx",
    "DELETE FROM alerts WHERE case_id IS NULL",
    """
    ALTER TABLE alerts
        DROP CONSTRAINT alerts_case_matches_status,
        DROP COLUMN status,
        DROP COLUMN template,
        DROP COLUMN decision_reason,
        DROP COLUMN decided_by,
        DROP COLUMN decided_at
    """,
    "ALTER TABLE alerts ALTER COLUMN case_id SET NOT NULL",
]


def upgrade() -> None:
    for statement in UPGRADE:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWNGRADE:
        op.execute(statement)
