"""Intune, CrowdStrike, Google Workspace and Slack actions against fake services."""

import base64
import json
from itertools import count
from typing import Any
from urllib.parse import unquote

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from pytest import MonkeyPatch

from app.integrations import crowdstrike, entra, google, slack
from app.jobs import workflows as worker
from tests.conftest import MakeUser, SignedIn

GUID = "0000aaaa-0000-0000-0000-000000000001"
AID = "0123456789abcdef0123456789abcdef"
NAMES = count()


@pytest.fixture
async def admin(make_user: MakeUser, tenant: str) -> SignedIn:
    return await make_user({tenant: ["admin"]})


@pytest.fixture
def calls(monkeypatch: MonkeyPatch) -> list[tuple[str, str, dict[str, Any]]]:
    """Fake every service; the list records (method, url, kwargs) per call."""
    seen: list[tuple[str, str, dict[str, Any]]] = []
    for module in (entra, crowdstrike, google):
        module._tokens.clear()  # pyright: ignore[reportPrivateUsage]

    async def fake(method: str, url: str, **kwargs: Any) -> tuple[int, dict[str, Any]]:
        seen.append((method, url, kwargs))
        url = unquote(url)
        if url.endswith("/oauth2/v2.0/token") or url == google.TOKEN_URL:
            return 200, {"access_token": "t", "expires_in": 3599}
        if url.endswith("/oauth2/token"):
            return 201, {"access_token": "t", "expires_in": 1799}
        if "deviceName eq 'TWIN'" in url:
            return 200, {"value": [{"id": "a"}, {"id": "b"}]}
        if "managedDevices?$filter" in url:
            return 200, {"value": [{"id": GUID}]}
        if "/devices/queries/devices/v1" in url:
            return 200, {"resources": [AID]}
        if url.endswith("/tokens") and method == "GET":
            return 200, {"items": [{"clientId": "123.apps", "displayText": "Sketchy app"}]}
        if url.endswith("users.lookupByEmail"):
            return 200, {"ok": True, "user": {"id": "U0123456789"}}
        if url.endswith("admin.users.session.reset"):
            if kwargs["data"]["user_id"] == "U0000000000":
                return 200, {"ok": False, "error": "not_allowed_token_type"}
            return 200, {"ok": True}
        if url.endswith("auth.test"):
            return 200, {"ok": True}
        return 202, {}

    for module in (entra, crowdstrike, google, slack):
        monkeypatch.setattr(module, "send", fake)
    return seen


async def connector(admin: SignedIn, tenant: str, kind: str, settings: Any, secret: str) -> str:
    body = {"key": kind, "kind": kind, "name": kind, "settings": settings, "secret": secret}
    response = await admin.client.post(f"/api/tenants/{tenant}/connectors", json=body)
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def run(admin: SignedIn, tenant: str, action: str, inputs: dict[str, str]) -> dict[str, Any]:
    """Run one action as an automatic step on a fresh case; returns the step."""
    step = {"name": "Act", "action": action, "mode": "auto", "inputs": inputs}
    body = {"name": f"Run {next(NAMES)}", "trigger": {}, "steps": [step]}
    workflow = (await admin.client.post(f"/api/tenants/{tenant}/workflows", json=body)).json()
    case = await admin.client.post(
        f"/api/tenants/{tenant}/cases", json={"template": "phishing", "title": "x"}
    )
    number = case.json()["number"]
    url = f"/api/tenants/{tenant}/cases/{number}/workflow-runs"
    await admin.client.post(url, json={"workflow_id": workflow["id"]})
    await worker.run_once()
    return (await admin.client.get(url)).json()[0]["steps"][0]


async def test_intune_and_entra_devices(admin: SignedIn, tenant: str, calls: list[Any]) -> None:
    settings = {"directory_id": GUID, "client_id": GUID}
    await connector(admin, tenant, "entra", settings, "secret")

    retired = await run(admin, tenant, "intune.retire_device", {"device": "LAPTOP-7"})
    assert retired["status"] == "succeeded", retired
    urls = [(m, unquote(u.removeprefix(entra.GRAPH))) for m, u, _ in calls[1:]]
    assert urls == [
        ("GET", "/deviceManagement/managedDevices?$filter=deviceName eq 'LAPTOP-7'&$select=id"),
        ("POST", f"/deviceManagement/managedDevices/{GUID}/retire"),
    ]

    twin = await run(admin, tenant, "intune.remote_lock", {"device": "TWIN"})
    assert twin["error"] == "2 devices are named TWIN; use the device ID"
    injected = await run(admin, tenant, "intune.retire_device", {"device": "x' or 1 eq 1"})
    assert injected["error"] == "device must be a device name or an ID"

    calls.clear()
    disabled = await run(admin, tenant, "entra.disable_device", {"device": GUID})
    assert disabled["status"] == "succeeded"
    assert calls[-1][:2] == ("PATCH", f"{entra.GRAPH}/devices/{GUID}")
    assert calls[-1][2]["json"] == {"accountEnabled": False}


async def test_crowdstrike_containment(admin: SignedIn, tenant: str, calls: list[Any]) -> None:
    bad = await admin.client.post(
        f"/api/tenants/{tenant}/connectors",
        json={
            "key": "cs",
            "kind": "crowdstrike",
            "name": "cs",
            "settings": {"cloud": "mars-1", "client_id": "x"},
            "secret": "s",
        },
    )
    assert bad.status_code == 422
    await connector(admin, tenant, "crowdstrike", {"cloud": "us-2", "client_id": "a" * 32}, "s")

    contained = await run(admin, tenant, "crowdstrike.contain_host", {"host": "WS-0142"})
    assert contained["status"] == "succeeded", contained
    assert contained["output"] == {"host_id": AID, "action": "contain"}
    base = crowdstrike.CLOUDS["us-2"]
    assert calls[0][1] == f"{base}/oauth2/token"
    assert unquote(calls[1][1]) == f"{base}/devices/queries/devices/v1?filter=hostname:'WS-0142'"
    assert calls[2][1] == f"{base}/devices/entities/devices-actions/v2?action_name=contain"
    assert calls[2][2]["json"] == {"ids": [AID]}

    lifted = await run(admin, tenant, "crowdstrike.lift_containment", {"host": AID.upper()})
    assert lifted["output"] == {"host_id": AID, "action": "lift_containment"}
    bad_host = await run(admin, tenant, "crowdstrike.contain_host", {"host": "a'b"})
    assert bad_host["error"] == "host must be a Falcon host ID or a hostname"


async def test_google_workspace(admin: SignedIn, tenant: str, calls: list[Any]) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    settings = {"client_email": "eagle@proj.iam.gserviceaccount.com", "admin_subject": "it@ex.test"}
    await connector(admin, tenant, "google", settings, pem)

    signed_out = await run(admin, tenant, "google.sign_out_user", {"user": "ann@ex.test"})
    assert signed_out["status"] == "succeeded", signed_out
    token_call = calls[0][2]["data"]
    header, claims, signature = token_call["assertion"].split(".")

    def decode(part: str) -> bytes:
        return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))

    assert json.loads(decode(header)) == {"alg": "RS256", "typ": "JWT"}
    body = json.loads(decode(claims))
    assert body["iss"] == settings["client_email"] and body["sub"] == "it@ex.test"
    key.public_key().verify(
        decode(signature), f"{header}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256()
    )
    assert calls[1][:2] == ("POST", f"{google.DIRECTORY}/users/ann@ex.test/signOut")

    calls.clear()
    revoked = await run(admin, tenant, "google.revoke_tokens", {"user": "ann@ex.test"})
    assert revoked["output"] == {"revoked": ["Sketchy app"]}
    assert calls[-1][:2] == ("DELETE", f"{google.DIRECTORY}/users/ann@ex.test/tokens/123.apps")
    not_email = await run(admin, tenant, "google.suspend_user", {"user": "ann"})
    assert not_email["error"] == "user must be an email address"


async def test_slack_and_connector_sign_in(admin: SignedIn, tenant: str, calls: list[Any]) -> None:
    connector_id = await connector(admin, tenant, "slack", {}, "xoxp-test")
    tested = await admin.client.post(f"/api/tenants/{tenant}/connectors/{connector_id}/test")
    assert tested.status_code == 200

    reset = await run(admin, tenant, "slack.reset_sessions", {"user": "ann@ex.test"})
    assert reset["output"] == {"user_id": "U0123456789", "sessions_reset": True}
    assert calls[-1][2]["data"] == {"user_id": "U0123456789"}
    assert calls[-1][2]["headers"] == {"Authorization": "Bearer xoxp-test"}
    refused = await run(admin, tenant, "slack.reset_sessions", {"user": "U0000000000"})
    assert refused["error"] == "Slack admin.users.session.reset failed (not_allowed_token_type)"
