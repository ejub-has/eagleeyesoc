"""Connectors (encrypted credentials) and the Entra ID actions they enable."""

from typing import Any

import pytest
from httpx2 import AsyncClient
from pytest import MonkeyPatch
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app import connectors
from app.integrations import entra
from app.jobs import workflows as worker
from tests.conftest import MakeToken, MakeUser, SignedIn, audit_actions

DIRECTORY = "11111111-2222-3333-4444-555555555555"
CLIENT = "66666666-7777-8888-9999-000000000000"
ENTRA = {
    "key": "entra",
    "kind": "entra",
    "name": "Corporate Entra ID",
    "settings": {"directory_id": DIRECTORY, "client_id": CLIENT},
    "secret": "s3cret-value",
}


@pytest.fixture
async def admin(make_user: MakeUser, tenant: str) -> SignedIn:
    return await make_user({tenant: ["admin"]})


@pytest.fixture
def graph(monkeypatch: MonkeyPatch) -> dict[str, Any]:
    """A fake Entra ID and Microsoft Graph; records every call."""
    state: dict[str, Any] = {"calls": [], "token_status": 200, "graph_status": 204}
    entra._tokens.clear()  # pyright: ignore[reportPrivateUsage]

    async def send(method: str, url: str, **kwargs: Any) -> tuple[int, dict[str, Any]]:
        state["calls"].append((method, url, kwargs))
        if url.endswith("/oauth2/v2.0/token"):
            if state["token_status"] != 200:
                return state["token_status"], {"error": "invalid_client"}
            return 200, {"access_token": "graph-token", "expires_in": 3599}
        if method == "GET":
            return 200, {"id": "0000aaaa-0000-0000-0000-000000000001", "accountEnabled": True}
        return state["graph_status"], {} if state["graph_status"] < 400 else {
            "error": {"code": "Authorization_RequestDenied"}
        }

    monkeypatch.setattr(entra, "send", send)
    return state


async def test_secrets_are_encrypted_and_never_returned(
    admin: SignedIn, make_user: MakeUser, tenant: str, owner: AsyncEngine, graph: dict[str, Any]
) -> None:
    url = f"/api/tenants/{tenant}/connectors"
    analyst = await make_user({tenant: ["analyst"]})
    assert (await analyst.client.post(url, json=ENTRA)).status_code == 403

    created = await admin.client.post(url, json=ENTRA)
    assert created.status_code == 201, created.text
    body = created.json()
    assert "secret" not in body and body["secret_set"] is True
    async with owner.begin() as conn:
        stored = await conn.scalar(text("SELECT secret FROM connectors WHERE id = :id"), body)
    assert stored != ENTRA["secret"] and connectors.decrypt(stored) == ENTRA["secret"]

    assert (await admin.client.post(url, json=ENTRA)).status_code == 409
    bad_guid = ENTRA | {"key": "x", "settings": {"directory_id": "nope", "client_id": CLIENT}}
    assert (await admin.client.post(url, json=bad_guid)).status_code == 422
    extra = ENTRA | {"key": "y", "settings": ENTRA["settings"] | {"region": "eu"}}
    assert (await admin.client.post(url, json=extra)).status_code == 422

    keep = {k: v for k, v in ENTRA.items() if k != "secret"} | {"name": "Renamed"}
    updated = await admin.client.put(f"{url}/{body['id']}", json=keep)
    assert updated.json()["name"] == "Renamed"
    async with owner.begin() as conn:
        assert await conn.scalar(text("SELECT secret FROM connectors WHERE id = :id"), body) == (
            stored
        )

    tested = await admin.client.post(f"{url}/{body['id']}/test")
    assert tested.status_code == 200 and tested.json() == {"status": "ok"}
    graph["token_status"] = 401
    failed = await admin.client.post(f"{url}/{body['id']}/test")
    assert failed.status_code == 400 and "invalid_client" in failed.json()["detail"]

    assert (await admin.client.delete(f"{url}/{body['id']}")).status_code == 204
    actions = await audit_actions(owner, f"user:{admin.id}")
    assert {"connector.create", "connector.update", "connector.test", "connector.delete"} <= set(
        actions
    )


async def test_password_spray_runbook_end_to_end(
    admin: SignedIn,
    make_user: MakeUser,
    make_token: MakeToken,
    client: AsyncClient,
    tenant: str,
    graph: dict[str, Any],
) -> None:
    await admin.client.post(f"/api/tenants/{tenant}/connectors", json=ENTRA)
    user = "{{alert.payload.userPrincipalName}}"
    runbook = {
        "name": "Password spray",
        "trigger": {"sources": ["entra_id_protection"]},
        "steps": [
            {"name": "Look up", "action": "entra.get_user", "inputs": {"user": user}},
            {
                "name": "Force password change",
                "action": "entra.require_password_change",
                "inputs": {"user": user},
            },
            {"name": "Revoke sessions", "action": "entra.revoke_sessions", "inputs": {"user": user}},
        ],
    }
    created = await admin.client.post(f"/api/tenants/{tenant}/workflows", json=runbook)
    assert [s["mode"] for s in created.json()["steps"]] == ["auto", "approval", "approval"]

    token = await make_token(tenant, ["alerts:write"])
    alert = {
        "template": "phishing",
        "title": "Password spray",
        "source": "entra_id_protection",
        "payload": {"userPrincipalName": "ann@example.test"},
    }
    posted = await client.post(
        f"/api/tenants/{tenant}/alerts", json=alert, headers={"Authorization": f"Bearer {token}"}
    )
    number = posted.json()["case_number"]
    analyst = await make_user({tenant: ["analyst"]})
    runs_url = f"/api/tenants/{tenant}/cases/{number}/workflow-runs"

    await worker.run_once()
    [run] = (await analyst.client.get(runs_url)).json()
    assert run["steps"][0]["output"]["accountEnabled"] is True
    for position in (1, 2):
        step = run["steps"][position]["id"]
        approve = f"/api/tenants/{tenant}/workflow-runs/{run['id']}/steps/{step}/approve"
        assert (await analyst.client.post(approve, json={})).status_code == 200
        await worker.run_once()
        [run] = (await analyst.client.get(runs_url)).json()
    assert run["status"] == "succeeded"

    calls = [(m, u.removeprefix(entra.GRAPH)) for m, u, _ in graph["calls"]]
    assert calls[1:] == [
        ("GET", "/users/ann@example.test?$select=id,displayName,userPrincipalName,accountEnabled"),
        ("PATCH", "/users/ann@example.test"),
        ("POST", "/users/ann@example.test/revokeSignInSessions"),
    ]
    assert calls[0][1].endswith(f"/{DIRECTORY}/oauth2/v2.0/token")  # one sign-in, reused
    patch = graph["calls"][2][2]
    assert patch["json"] == {"passwordProfile": {"forceChangePasswordNextSignIn": True}}
    assert patch["headers"] == {"Authorization": "Bearer graph-token"}


async def test_entra_failures_are_explained(
    admin: SignedIn, make_user: MakeUser, tenant: str, graph: dict[str, Any]
) -> None:
    async def run_step(inputs: dict[str, str]) -> dict[str, Any]:
        runbook = {
            "name": f"Disable {len(graph['calls'])}-{inputs.get('user')}",
            "trigger": {},
            "steps": [
                {"name": "Disable", "action": "entra.disable_user", "mode": "auto", "inputs": inputs}
            ],
        }
        workflow = (await admin.client.post(f"/api/tenants/{tenant}/workflows", json=runbook)).json()
        case = await admin.client.post(
            f"/api/tenants/{tenant}/cases", json={"template": "phishing", "title": "x"}
        )
        number = case.json()["number"]
        await admin.client.post(
            f"/api/tenants/{tenant}/cases/{number}/workflow-runs",
            json={"workflow_id": workflow["id"]},
        )
        await worker.run_once()
        runs = await admin.client.get(f"/api/tenants/{tenant}/cases/{number}/workflow-runs")
        return runs.json()[0]["steps"][0]

    missing = await run_step({"user": "ann@example.test"})
    assert missing["status"] == "failed" and missing["error"] == "no entra connector"

    await admin.client.post(f"/api/tenants/{tenant}/connectors", json=ENTRA)
    bad_user = await run_step({"user": "ann@example.test/../../groups"})
    assert bad_user["error"] == "user must be a user principal name or an object ID"

    graph["graph_status"] = 403
    denied = await run_step({"user": "ann@example.test"})
    assert "Authorization_RequestDenied" in denied["error"]
    assert "API permissions" in denied["error"]
