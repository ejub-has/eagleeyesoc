"""Free-form tags on cases

Analysts label cases with their own tags (for example "vip", "repeat-offender"), shown
on the case list and the case page alongside the regulated data types.

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-11
"""

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE cases ADD COLUMN tags text[] NOT NULL DEFAULT '{}'")


def downgrade() -> None:
    op.execute("ALTER TABLE cases DROP COLUMN tags")
