"""Theme preference per user

The Light / Dark / System choice follows the user across browsers and devices.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-11
"""

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users ADD COLUMN theme text NOT NULL DEFAULT 'system' "
        "CHECK (theme IN ('light', 'dark', 'system'))"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN theme")
