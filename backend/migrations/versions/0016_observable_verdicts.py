"""Verdicts on observables (FR-35)

An observable is marked malicious, suspicious, benign or unknown for the whole tenant,
with an optional confidence (0-100), an expiry after which it reads as unknown again,
a note, and who set it when.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-11
"""

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | None = None
depends_on: str | None = None

COLUMNS = "verdict, confidence, verdict_expires_at, verdict_note, verdict_by, verdict_at"


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE observables
            ADD COLUMN verdict text NOT NULL DEFAULT 'unknown'
                CHECK (verdict IN ('malicious', 'suspicious', 'benign', 'unknown')),
            ADD COLUMN confidence smallint CHECK (confidence BETWEEN 0 AND 100),
            ADD COLUMN verdict_expires_at timestamptz,
            ADD COLUMN verdict_note text,
            ADD COLUMN verdict_by text,
            ADD COLUMN verdict_at timestamptz
        """
    )
    # Only the verdict columns become writable; type and value stay insert-only.
    op.execute(f"GRANT UPDATE ({COLUMNS}) ON observables TO casemgr_app")


def downgrade() -> None:
    op.execute(f"REVOKE UPDATE ({COLUMNS}) ON observables FROM casemgr_app")
    op.execute(
        "ALTER TABLE observables DROP COLUMN verdict, DROP COLUMN confidence, "
        "DROP COLUMN verdict_expires_at, DROP COLUMN verdict_note, DROP COLUMN verdict_by, "
        "DROP COLUMN verdict_at"
    )
