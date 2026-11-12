"""Slack actions through the admin API (Enterprise Grid).

The token is a user token (xoxp-) of an org admin or owner with the admin.users:write
scope, plus users:read.email to find users by email.
"""

import re
from typing import Any

from app import actions, connectors
from app.actions import ActionContext, ActionFailed, InputSpec, action
from app.integrations.http import send

API = "https://slack.com/api"
SLACK_ID = re.compile(r"^[UW][A-Z0-9]{6,20}$")
EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+$")


async def call(token: str, method: str, **params: str) -> dict[str, Any]:
    status, body = await send(
        "POST", f"{API}/{method}", headers={"Authorization": f"Bearer {token}"}, data=params
    )
    if status != 200 or not body.get("ok"):
        raise ActionFailed(f"Slack {method} failed ({body.get('error', status)})")
    return body


async def _token(ctx: ActionContext, inputs: dict[str, Any]) -> str:
    try:
        creds = await connectors.credentials(ctx.db, "slack", inputs.get("connector") or None)
    except (LookupError, ValueError) as error:
        raise ActionFailed(str(error)) from error
    return creds.secret


async def check(creds: connectors.Credentials) -> None:
    """Sign-in test for the connector."""
    await call(creds.secret, "auth.test")


@action(
    "slack.reset_sessions",
    "Reset sessions (Slack)",
    "Signs the user out of Slack on every device and browser.",
    "Slack",
    "change",
    [InputSpec(name="user", label="User", help="email or Slack user ID")],
    connector="slack",
)
async def reset_sessions(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    token = await _token(ctx, inputs)
    user = actions.text(inputs, "user").strip()
    if EMAIL.fullmatch(user):
        found = await call(token, "users.lookupByEmail", email=user)
        user = str(found.get("user", {}).get("id", ""))
    if not SLACK_ID.fullmatch(user):
        raise ActionFailed("user must be an email address or a Slack user ID")
    await call(token, "admin.users.session.reset", user_id=user)
    return {"user_id": user, "sessions_reset": True}
