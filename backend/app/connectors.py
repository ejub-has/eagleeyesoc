"""Connectors: a tenant's credentials for the services workflow actions act on.

Secrets (client secrets, API keys) are encrypted at rest with a key derived from the app's
secret key and are never returned by the API; they can only be replaced. Rotating
CASEMGR_SECRET_KEY makes stored secrets unreadable, so connectors must be re-saved then.
"""

import base64
import hashlib
from datetime import datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Connector

Kind = Literal["entra"]
Key = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]{0,39}$")]
Guid = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    ),
]
Secret = Annotated[str, StringConstraints(min_length=1, max_length=4000)]


class EntraSettings(BaseModel):
    """An Entra ID app registration that calls Microsoft Graph with application permissions."""

    model_config = ConfigDict(extra="forbid")

    directory_id: Guid  # the Entra tenant (directory) ID
    client_id: Guid  # the app registration's application (client) ID


SETTINGS: dict[str, type[BaseModel]] = {"entra": EntraSettings}


class ConnectorIn(BaseModel):
    key: Key
    kind: Kind
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    settings: dict[str, Any]
    secret: Secret | None = None  # omitted on update keeps the stored secret

    @model_validator(mode="after")
    def check_settings(self) -> Self:
        self.settings = SETTINGS[self.kind].model_validate(self.settings).model_dump()
        return self


class ConnectorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    key: str
    kind: Kind
    name: str
    settings: dict[str, Any]
    secret_set: bool
    secret_set_at: datetime | None
    updated_by: str
    updated_at: datetime


def _fernet() -> Fernet:
    digest = hashlib.sha256(b"casemgr connector secrets\0" + settings.secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as error:
        raise ValueError("the stored secret cannot be read; save the connector again") from error


def out(connector: Connector) -> ConnectorOut:
    return ConnectorOut(
        id=connector.id,
        key=connector.key,
        kind=connector.kind,  # pyright: ignore[reportArgumentType]  # validated on save
        name=connector.name,
        settings=connector.settings,
        secret_set=connector.secret is not None,
        secret_set_at=connector.secret_set_at,
        updated_by=connector.updated_by,
        updated_at=connector.updated_at,
    )


class Credentials(BaseModel):
    key: str
    settings: dict[str, Any]
    secret: str


async def credentials(db: AsyncSession, kind: str, key: str | None) -> Credentials:
    """The named connector of a kind, or the tenant's only one when no key is given."""
    query = select(Connector).where(Connector.kind == kind)
    if key:
        query = query.where(Connector.key == key)
    found = list(await db.scalars(query.order_by(Connector.key).limit(2)))
    if not found:
        raise LookupError(f"no {kind} connector" + (f" named {key}" if key else ""))
    if len(found) > 1:
        raise LookupError(f"several {kind} connectors exist; name one in the step")
    connector = found[0]
    if connector.secret is None:
        raise LookupError(f"connector {connector.key} has no secret")
    return Credentials(
        key=connector.key, settings=connector.settings, secret=decrypt(connector.secret)
    )
