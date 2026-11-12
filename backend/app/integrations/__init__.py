"""Connector-backed workflow actions; importing this package registers them."""

from app import connectors
from app.integrations import crowdstrike, entra, google, slack

__all__ = ["crowdstrike", "entra", "google", "signin", "slack"]


async def signin(creds: connectors.Credentials, kind: str) -> None:
    """Prove a connector's credentials work without acting on anything."""
    if kind == "entra":
        await entra.token(creds, fresh=True)
    elif kind == "crowdstrike":
        await crowdstrike.token(creds, fresh=True)
    elif kind == "google":
        await google.token(creds, fresh=True)
    elif kind == "slack":
        await slack.check(creds)
