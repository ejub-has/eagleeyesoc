"""Google Workspace actions through the Admin SDK Directory API.

Uses a service account with domain-wide delegation, acting as a Workspace admin. Grant the
service account's client ID these scopes in the Admin console (Security > API controls >
Domain-wide delegation): admin.directory.user and admin.directory.user.security.
"""

import base64
import json
import re
import time
from typing import Any
from urllib.parse import quote

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app import actions, connectors
from app.actions import ActionContext, ActionFailed, InputSpec, action
from app.integrations.http import send

TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - a URL, not a secret
DIRECTORY = "https://admin.googleapis.com/admin/directory/v1"
SCOPES = (
    "https://www.googleapis.com/auth/admin.directory.user "
    "https://www.googleapis.com/auth/admin.directory.user.security"
)
EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+$")

_tokens: dict[tuple[str, str], tuple[str, float]] = {}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def assertion(client_email: str, subject: str, private_key: str, now: float) -> str:
    """A signed JWT that asks Google for a token acting as the delegated admin."""
    try:
        key = serialization.load_pem_private_key(private_key.encode(), password=None)
    except ValueError as error:
        raise ActionFailed("the Google connector's private key is not a PEM RSA key") from error
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ActionFailed("the Google connector's private key is not an RSA key")
    header = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = {
        "iss": client_email,
        "sub": subject,
        "scope": SCOPES,
        "aud": TOKEN_URL,
        "iat": int(now),
        "exp": int(now) + 3600,
    }
    signing_input = f"{header}.{_b64(json.dumps(claims).encode())}"
    signature = key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{_b64(signature)}"


async def token(creds: connectors.Credentials, fresh: bool = False) -> str:
    email, subject = creds.settings["client_email"], creds.settings["admin_subject"]
    cached = _tokens.get((email, subject))
    if cached and cached[1] > time.monotonic() + 60 and not fresh:
        return cached[0]
    status, body = await send(
        "POST",
        TOKEN_URL,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion(email, subject, creds.secret, time.time()),
        },
    )
    if status != 200 or "access_token" not in body:
        code = body.get("error", status)
        raise ActionFailed(f"Google sign-in for connector {creds.key} failed ({code})")
    _tokens[(email, subject)] = (
        body["access_token"],
        time.monotonic() + float(body.get("expires_in", 3599)),
    )
    return body["access_token"]


async def directory(
    ctx: ActionContext, inputs: dict[str, Any], method: str, path: str, body: Any = None
) -> dict[str, Any]:
    try:
        creds = await connectors.credentials(ctx.db, "google", inputs.get("connector") or None)
    except (LookupError, ValueError) as error:
        raise ActionFailed(str(error)) from error
    headers = {"Authorization": f"Bearer {await token(creds)}"}
    status, reply = await send(method, f"{DIRECTORY}{path}", headers=headers, json=body)
    if status >= 400:
        if status == 404:
            raise ActionFailed("Google: not found (check the user)")
        if status in (401, 403):
            raise ActionFailed(
                "Google refused the call; check the service account's domain-wide delegation "
                "scopes and the admin it acts as"
            )
        raise ActionFailed(f"Google error {status}")
    return reply


def user_key(inputs: dict[str, Any]) -> str:
    user = actions.text(inputs, "user").strip()
    if not EMAIL.fullmatch(user):
        raise ActionFailed("user must be an email address")
    return quote(user, safe="@")


USER_INPUT = InputSpec(
    name="user", label="User", help="primary email, e.g. {{alert.payload.user_email}}"
)


@action(
    "google.sign_out_user",
    "Sign a user out (Google Workspace)",
    "Ends the user's web and device sessions in Google Workspace (Gmail, Drive and so on).",
    "Google Workspace",
    "change",
    [USER_INPUT],
    connector="google",
)
async def sign_out_user(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    await directory(ctx, inputs, "POST", f"/users/{user_key(inputs)}/signOut")
    return {"signed_out": True}


@action(
    "google.revoke_tokens",
    "Revoke app tokens (Google Workspace)",
    "Revokes every OAuth token the user granted to third-party apps.",
    "Google Workspace",
    "change",
    [USER_INPUT],
    connector="google",
)
async def revoke_tokens(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    user = user_key(inputs)
    listed = await directory(ctx, inputs, "GET", f"/users/{user}/tokens")
    revoked = []
    for item in listed.get("items", []):
        client = str(item.get("clientId", ""))
        if client:
            await directory(ctx, inputs, "DELETE", f"/users/{user}/tokens/{quote(client, safe='')}")
            revoked.append(item.get("displayText") or client)
    return {"revoked": revoked}


@action(
    "google.suspend_user",
    "Suspend a user (Google Workspace)",
    "Suspends the account: the user cannot sign in and their sessions end.",
    "Google Workspace",
    "change",
    [USER_INPUT],
    connector="google",
)
async def suspend_user(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    await directory(ctx, inputs, "PUT", f"/users/{user_key(inputs)}", {"suspended": True})
    return {"suspended": True}
