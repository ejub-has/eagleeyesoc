"""ATT&CK tactics on cases

Cases already record ATT&CK techniques; tactics (TA IDs) complete the mapping (FR-13).
Both are now also filled from the tactics and techniques named in incoming alerts.

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-09
"""

from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE cases ADD COLUMN attack_tactics text[] NOT NULL DEFAULT '{}'")


def downgrade() -> None:
    op.execute("ALTER TABLE cases DROP COLUMN attack_tactics")
