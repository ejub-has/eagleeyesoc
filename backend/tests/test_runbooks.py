"""Workflows (runbooks): definitions, alert triggers, approvals, and the worker."""

from typing import Any

import httpx2
import pytest
from httpx2 import AsyncClient
from pytest import MonkeyPatch
from sqlalchemy.ext.asyncio import AsyncEngine

from app import actions
from app.jobs import workflows as worker
from app.models import Alert
from app.workflows import Trigger, lookup, matches, render
from tests.conftest import MakeToken, MakeUser, SignedIn, audit_actions

SPRAY = {
    "name": "Password spray response",
    "trigger": {
        "sources": ["entra_id_protection"],
        "title_contains": "spray",
        "conditions": [{"path": "payload.riskEventType", "op": "equals", "value": "passwordSpray"}],
    },
    "steps": [
        {
            "name": "Record the target",
            "action": "case.add_note",
            "inputs": {"body": "Spray against {{alert.payload.userPrincipalName}}"},
        },
        {
            "name": "Check sign-ins",
            "action": "case.add_task",
            "inputs": {"title": "Review sign-ins for {{alert.payload.userPrincipalName}}"},
        },
        {
            "name": "Notify the identity team",
            "action": "http.post",
            "inputs": {
                "url": "https://hooks.example.com/identity",
                "body": '{"user": "{{alert.payload.userPrincipalName}}"}',
            },
        },
    ],
}


def alert(title: str = "Password spray detected", **payload: Any) -> dict[str, Any]:
    return {
        "template": "phishing",
        "title": title,
        "source": "entra_id_protection",
        "payload": {"riskEventType": "passwordSpray", "userPrincipalName": "ann@example.test"}
        | payload,
    }


@pytest.fixture
async def admin(make_user: MakeUser, tenant: str) -> SignedIn:
    return await make_user({tenant: ["admin"]})


@pytest.fixture
async def analyst(make_user: MakeUser, tenant: str) -> SignedIn:
    return await make_user({tenant: ["analyst"]})


@pytest.fixture
async def ingest(make_token: MakeToken, tenant: str, client: AsyncClient):
    token = await make_token(tenant, ["alerts:write"])

    async def post(body: dict[str, Any]) -> dict[str, Any]:
        response = await client.post(
            f"/api/tenants/{tenant}/alerts",
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 201, response.text
        return response.json()

    return post


@pytest.fixture
def webhook(monkeypatch: MonkeyPatch) -> list[tuple[str, Any]]:
    """Capture http.post calls instead of reaching the network."""
    sent: list[tuple[str, Any]] = []

    async def fake(url: str, payload: Any) -> httpx2.Response:
        sent.append((url, payload))
        return httpx2.Response(202)

    monkeypatch.setattr(actions, "post_json", fake)
    return sent


async def runs(client: AsyncClient, tenant: str, number: int) -> list[dict[str, Any]]:
    response = await client.get(f"/api/tenants/{tenant}/cases/{number}/workflow-runs")
    assert response.status_code == 200, response.text
    return response.json()


def statuses(run: dict[str, Any]) -> list[str]:
    return [s["status"] for s in run["steps"]]


def test_templates_and_conditions() -> None:
    data = {"alert": {"payload": {"user": {"upn": "a@b"}, "ips": ["1.2.3.4", "5.6.7.8"]}}}
    assert lookup(data, "alert.payload.ips[1]") == "5.6.7.8"
    assert lookup(data, "alert.payload.missing.deeper") is None
    assert render("{{ alert.payload.user }}", data) == {"upn": "a@b"}
    assert render("User {{alert.payload.user.upn}} from {{alert.payload.ips.0}}", data) == (
        "User a@b from 1.2.3.4"
    )
    assert render("Missing: {{alert.nothing}}.", data) == "Missing: ."


async def test_catalog_and_definitions(
    admin: SignedIn, analyst: SignedIn, tenant: str, owner: AsyncEngine
) -> None:
    catalog = (await analyst.client.get(f"/api/tenants/{tenant}/workflow-actions")).json()
    impacts = {a["key"]: a["impact"] for a in catalog}
    assert impacts["case.add_note"] == "read" and impacts["http.post"] == "change"

    url = f"/api/tenants/{tenant}/workflows"
    assert (await analyst.client.post(url, json=SPRAY)).status_code == 403
    created = await admin.client.post(url, json=SPRAY)
    assert created.status_code == 201, created.text
    body = created.json()
    # Steps that change things default to approval; the rest run automatically.
    assert [s["mode"] for s in body["steps"]] == ["auto", "auto", "approval"]
    assert (await admin.client.post(url, json=SPRAY)).status_code == 409

    bad_action = SPRAY | {"name": "x", "steps": [{"name": "s", "action": "nope"}]}
    assert (await admin.client.post(url, json=bad_action)).status_code == 422
    bad_input = SPRAY | {
        "name": "y",
        "steps": [{"name": "s", "action": "case.add_note", "inputs": {"colour": "red"}}],
    }
    assert (await admin.client.post(url, json=bad_input)).status_code == 422

    renamed = await admin.client.put(f"{url}/{body['id']}", json=SPRAY | {"enabled": False})
    assert renamed.status_code == 200 and renamed.json()["enabled"] is False
    assert [w["name"] for w in (await analyst.client.get(url)).json()] == [SPRAY["name"]]
    assert (await admin.client.delete(f"{url}/{body['id']}")).status_code == 204
    assert {"workflow.create", "workflow.update", "workflow.delete"} <= set(
        await audit_actions(owner, f"user:{admin.id}")
    )


async def test_alert_runs_auto_steps_then_waits_for_approval(
    admin: SignedIn,
    analyst: SignedIn,
    make_user: MakeUser,
    tenant: str,
    ingest: Any,
    webhook: list[tuple[str, Any]],
    owner: AsyncEngine,
) -> None:
    await admin.client.post(f"/api/tenants/{tenant}/workflows", json=SPRAY)

    other = await ingest(alert(riskEventType="unfamiliarFeatures"))
    assert await runs(analyst.client, tenant, other["case_number"]) == []

    number = (await ingest(alert()))["case_number"]
    [run] = await runs(analyst.client, tenant, number)
    assert run["status"] == "running" and statuses(run)[0] == "queued"

    assert await worker.run_once() >= 2
    [run] = await runs(analyst.client, tenant, number)
    assert run["status"] == "waiting"
    assert statuses(run) == ["succeeded", "succeeded", "awaiting_approval"]
    case = (await analyst.client.get(f"/api/tenants/{tenant}/cases/{number}")).json()
    assert case["notes"][0]["body"] == "Spray against ann@example.test"
    assert case["tasks"][-1]["title"] == "Review sign-ins for ann@example.test"
    assert run["steps"][2]["inputs"]["body"] == '{"user": "ann@example.test"}'
    assert webhook == []  # nothing changes outside the case before approval

    step = run["steps"][2]["id"]
    base = f"/api/tenants/{tenant}/workflow-runs/{run['id']}/steps/{step}"
    executive = await make_user({tenant: ["executive"]})
    assert (await executive.client.post(f"{base}/approve", json={})).status_code == 403
    approved = await analyst.client.post(f"{base}/approve", json={"reason": "confirmed spray"})
    assert approved.status_code == 200, approved.text
    assert statuses(approved.json())[2] == "queued"
    assert (await analyst.client.post(f"{base}/approve", json={})).status_code == 409

    await worker.run_once()
    [run] = await runs(analyst.client, tenant, number)
    assert run["status"] == "succeeded" and run["finished_at"]
    assert run["steps"][2]["decided_by"] == f"user:{analyst.id}"
    assert webhook == [("https://hooks.example.com/identity", {"user": "ann@example.test"})]
    timeline = (await analyst.client.get(f"/api/tenants/{tenant}/cases/{number}")).json()[
        "timeline"
    ]
    assert [e["source"] for e in timeline].count("workflow") == 3
    assert "workflow.step.approve" in await audit_actions(owner, f"user:{analyst.id}")


async def test_reject_cancels_and_failures_stop_or_continue(
    admin: SignedIn, analyst: SignedIn, tenant: str, ingest: Any
) -> None:
    url = f"/api/tenants/{tenant}/workflows"
    blocked = {
        "name": "Blocked URL",
        "action": "http.post",
        "mode": "auto",
        "on_error": "continue",
        "inputs": {"url": "https://127.0.0.1/hook"},
    }
    empty = {
        "name": "Empty input",
        "action": "case.add_note",
        "inputs": {"body": "{{alert.payload.nope}}"},
    }
    never = {"name": "Never runs", "action": "case.add_note", "inputs": {"body": "x"}}
    flow = SPRAY | {"steps": [blocked, empty, never]}
    await admin.client.post(url, json=flow)
    number = (await ingest(alert()))["case_number"]
    await worker.run_once()
    [run] = await runs(analyst.client, tenant, number)
    assert run["status"] == "failed"
    assert statuses(run) == ["failed", "failed", "skipped"]
    assert "public address" in run["steps"][0]["error"]
    assert run["steps"][1]["error"] == "input body is empty"

    # A manual run of an approval workflow, rejected at its first step.
    gated = SPRAY | {"name": "Gated", "steps": [SPRAY["steps"][2]]}
    workflow_id = (await admin.client.post(url, json=gated)).json()["id"]
    started = await analyst.client.post(
        f"/api/tenants/{tenant}/cases/{number}/workflow-runs", json={"workflow_id": workflow_id}
    )
    assert started.status_code == 201, started.text
    run = started.json()
    assert run["status"] == "waiting" and run["alert_id"] is None
    step = run["steps"][0]["id"]
    rejected = await analyst.client.post(
        f"/api/tenants/{tenant}/workflow-runs/{run['id']}/steps/{step}/reject",
        json={"reason": "false positive"},
    )
    body = rejected.json()
    assert body["status"] == "cancelled" and statuses(body) == ["rejected"]
    assert body["steps"][0]["decision_reason"] == "false positive"

    recent = (await analyst.client.get(f"/api/tenants/{tenant}/workflow-runs")).json()
    assert [r["workflow_name"] for r in recent] == ["Gated", SPRAY["name"]]
    cancel = await analyst.client.post(f"/api/tenants/{tenant}/workflow-runs/{run['id']}/cancel")
    assert cancel.status_code == 409


def test_matching_is_case_insensitive_and_needs_every_part() -> None:
    sample = Alert(
        source="entra_id_protection",
        title="Password SPRAY detected",
        payload={"riskEventType": "PasswordSpray", "user": {"upn": "a@b"}},
    )
    assert matches(Trigger.model_validate(SPRAY["trigger"]), sample)
    exists = {"conditions": [{"path": "payload.user.upn", "op": "exists"}]}
    assert matches(Trigger.model_validate(exists), sample)
    assert not matches(Trigger(sources=["crowdstrike"]), sample)
    missing = {"conditions": [{"path": "payload.user.mail", "op": "contains", "value": "a"}]}
    assert not matches(Trigger.model_validate(missing), sample)
