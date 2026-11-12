"""Entra ID actions through Microsoft Graph, as an app registration (client credentials).

Graph application permissions the app needs (admin consent in the Entra tenant):
User.Read.All (look up), User.ReadWrite.All (disable or enable),
User-PasswordProfile.ReadWrite.All (require a password change), User.RevokeSessions.All
(revoke sessions), IdentityRiskyUser.ReadWrite.All (confirm compromised).
"""

import re
import time
from typing import Any
from urllib.parse import quote

import httpx2

from app import actions, connectors
from app.actions import ActionContext, ActionFailed, InputSpec, action

LOGIN = "https://login.microsoftonline.com"
GRAPH = "https://graph.microsoft.com/v1.0"
USER = re.compile(
    r"^([A-Za-z0-9._%+'#-]+@[A-Za-z0-9.-]+|[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$"
)

# Access tokens per (directory, client), reused until a minute before they expire.
_tokens: dict[tuple[str, str], tuple[str, float]] = {}


async def send(
    method: str, url: str, *, headers: dict[str, str] | None = None, **kwargs: Any
) -> tuple[int, dict[str, Any]]:
    """One HTTP call; returns the status and the JSON body (empty when there is none)."""
    async with httpx2.AsyncClient(timeout=actions.REQUEST_TIMEOUT) as client:
        try:
            response = await client.request(method, url, headers=headers, **kwargs)
        except httpx2.HTTPError as error:
            raise ActionFailed(f"Microsoft Graph unreachable: {type(error).__name__}") from error
    try:
        body = response.json() if response.content else {}
    except ValueError:
        body = {}
    return response.status_code, body if isinstance(body, dict) else {}


async def token(creds: connectors.Credentials, fresh: bool = False) -> str:
    """An access token for Graph; fresh skips the cache (connector tests)."""
    directory, client_id = creds.settings["directory_id"], creds.settings["client_id"]
    cached = _tokens.get((directory, client_id))
    if cached and cached[1] > time.monotonic() + 60 and not fresh:
        return cached[0]
    status, body = await send(
        "POST",
        f"{LOGIN}/{directory}/oauth2/v2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": creds.secret,
            "scope": "https://graph.microsoft.com/.default",
        },
    )
    if status != 200 or "access_token" not in body:
        code = body.get("error", status)
        raise ActionFailed(f"Entra ID sign-in for connector {creds.key} failed ({code})")
    _tokens[(directory, client_id)] = (
        body["access_token"],
        time.monotonic() + float(body.get("expires_in", 3599)),
    )
    return body["access_token"]


async def graph(
    ctx: ActionContext, inputs: dict[str, Any], method: str, path: str, body: Any = None
) -> dict[str, Any]:
    try:
        creds = await connectors.credentials(ctx.db, "entra", inputs.get("connector") or None)
    except (LookupError, ValueError) as error:
        raise ActionFailed(str(error)) from error
    headers = {"Authorization": f"Bearer {await token(creds)}"}
    status, reply = await send(method, f"{GRAPH}{path}", headers=headers, json=body)
    if status >= 400:
        error = reply.get("error", {}) if isinstance(reply.get("error"), dict) else {}
        if status == 404:
            raise ActionFailed("Graph: not found (check the user)")
        if status in (401, 403):
            raise ActionFailed(
                f"Graph refused the call ({error.get('code', status)}); "
                "check the app registration's API permissions and admin consent"
            )
        raise ActionFailed(f"Graph error {status}: {error.get('code', 'unknown')}")
    return reply


def user_path(inputs: dict[str, Any]) -> str:
    user = actions.text(inputs, "user").strip()
    if not USER.fullmatch(user):
        raise ActionFailed("user must be a user principal name or an object ID")
    return f"/users/{quote(user, safe='@')}"


USER_INPUT = InputSpec(
    name="user",
    label="User",
    help="user principal name or object ID, e.g. {{alert.payload.userPrincipalName}}",
)


@action(
    "entra.get_user",
    "Look up a user",
    "Reads the user's name, ID and whether the account is enabled.",
    "Entra ID",
    "read",
    [USER_INPUT],
    connector="entra",
)
async def get_user(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    fields = "id,displayName,userPrincipalName,accountEnabled"
    found = await graph(ctx, inputs, "GET", f"{user_path(inputs)}?$select={fields}")
    return {k: found.get(k) for k in fields.split(",")}


@action(
    "entra.require_password_change",
    "Require a password change",
    "Makes the user choose a new password at their next sign-in.",
    "Entra ID",
    "change",
    [USER_INPUT],
    connector="entra",
)
async def require_password_change(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    profile = {"passwordProfile": {"forceChangePasswordNextSignIn": True}}
    await graph(ctx, inputs, "PATCH", user_path(inputs), profile)
    return {"force_change_password_next_sign_in": True}


@action(
    "entra.revoke_sessions",
    "Revoke sign-in sessions",
    "Invalidates the user's refresh tokens and session cookies, ending sessions in "
    "Microsoft 365 apps (Teams, Outlook) and other apps that sign in with Entra ID.",
    "Entra ID",
    "change",
    [USER_INPUT],
    connector="entra",
)
async def revoke_sessions(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    await graph(ctx, inputs, "POST", f"{user_path(inputs)}/revokeSignInSessions")
    return {"revoked": True}


@action(
    "entra.disable_user",
    "Disable a user",
    "Blocks the account from signing in.",
    "Entra ID",
    "change",
    [USER_INPUT],
    connector="entra",
)
async def disable_user(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    await graph(ctx, inputs, "PATCH", user_path(inputs), {"accountEnabled": False})
    return {"account_enabled": False}


@action(
    "entra.enable_user",
    "Enable a user",
    "Allows the account to sign in again.",
    "Entra ID",
    "change",
    [USER_INPUT],
    connector="entra",
)
async def enable_user(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    await graph(ctx, inputs, "PATCH", user_path(inputs), {"accountEnabled": True})
    return {"account_enabled": True}


@action(
    "entra.confirm_compromised",
    "Confirm user compromised",
    "Marks the user as compromised in Entra ID Protection (high risk), so risk-based "
    "Conditional Access policies apply.",
    "Entra ID",
    "change",
    [USER_INPUT],
    connector="entra",
)
async def confirm_compromised(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    user = await graph(ctx, inputs, "GET", f"{user_path(inputs)}?$select=id")
    body = {"userIds": [user["id"]]}
    await graph(ctx, inputs, "POST", "/identityProtection/riskyUsers/confirmCompromised", body)
    return {"user_id": user["id"], "confirmed_compromised": True}
