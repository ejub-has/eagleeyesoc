"""Connectors: per-tenant credentials for services that workflow actions call

Secrets are stored as Fernet ciphertext (see app/connectors.py) and never returned.

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-11
"""

from alembic import op

from app.rls import tenant_rls

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE connectors (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants,
            key text NOT NULL,
            kind text NOT NULL,
            name text NOT NULL,
            settings jsonb NOT NULL DEFAULT '{}',
            secret text,
            secret_set_at timestamptz,
            created_by text NOT NULL,
            updated_by text NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, key)
        )
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON connectors TO casemgr_app")
    for statement in tenant_rls("connectors"):
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE connectors")
