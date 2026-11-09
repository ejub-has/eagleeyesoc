from typing import Any

import pytest
from httpx2 import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.conftest import MakeToken, MakeUser, SignedIn, audit_actions, close_case


@pytest.fixture
async def token(make_token: MakeToken, tenant: str) -> str:
    return await make_token(tenant, ["alerts:write"])


@pytest.fixture
async def analyst(make_user: MakeUser, tenant: str) -> SignedIn:
    return await make_user({tenant: ["analyst"]})


async def queue_alert(client: AsyncClient, tenant: str, token: str, **body: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/tenants/{tenant}/alerts",
        json={
            "template": "phishing",
            "title": "Reported email",
            "source": "elastic",
            "triage": True,
        }
        | body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def queue(client: AsyncClient, tenant: str) -> list[dict[str, Any]]:
    response = await client.get(f"/api/tenants/{tenant}/triage")
    assert response.status_code == 200, response.text
    return response.json()


async def test_triaged_alert_waits_without_a_case(
    client: AsyncClient, tenant: str, token: str, analyst: SignedIn
) -> None:
    result = await queue_alert(client, tenant, token, external_id="e-1", payload={"user": "jdoe"})

    assert (result["case_number"], result["new_case"], result["queued"]) == (None, False, True)
    [item] = await queue(analyst.client, tenant)
    assert (item["id"], item["template"], item["payload"]) == (
        result["alert_id"],
        "phishing",
        {"user": "jdoe"},
    )
    assert (await analyst.client.get(f"/api/tenants/{tenant}/cases")).json() == []

    again = await queue_alert(client, tenant, token, external_id="e-1")
    assert (again["duplicate"], again["queued"], again["case_number"]) == (True, True, None)


async def test_promote_opens_a_case_from_the_template(
    tenant: str, token: str, client: AsyncClient, analyst: SignedIn, owner: AsyncEngine
) -> None:
    alert = await queue_alert(client, tenant, token)
    url = f"/api/tenants/{tenant}/triage/{alert['alert_id']}/promote"

    response = await analyst.client.post(url, json={"reason": "User clicked the link"})

    assert response.status_code == 200, response.text
    assert response.json()["new_case"] is True
    number = response.json()["case_number"]
    case = (await analyst.client.get(f"/api/tenants/{tenant}/cases/{number}")).json()
    assert (case["category"], case["title"], case["source"]) == (
        "phishing",
        "Reported email",
        "elastic",
    )
    assert [a["id"] for a in case["alerts"]] == [alert["alert_id"]]
    assert await queue(analyst.client, tenant) == []
    assert "alert.promote" in await audit_actions(owner, f"user:{analyst.id}")
    again = await analyst.client.post(url, json={"reason": "twice"})
    assert again.status_code == 409


async def test_shared_observables_suggest_and_join_an_open_case(
    tenant: str, token: str, client: AsyncClient, analyst: SignedIn
) -> None:
    created = await analyst.client.post(
        f"/api/tenants/{tenant}/cases", json={"template": "phishing", "title": "Campaign"}
    )
    number = created.json()["number"]
    await analyst.client.post(
        f"/api/tenants/{tenant}/cases/{number}/observables",
        json={"observables": [{"type": "ipv4", "value": "198.51.100.23"}]},
    )
    alert = await queue_alert(
        client, tenant, token, payload={"source_ip": "198.51.100.23", "note": "unrelated text"}
    )

    [item] = await queue(analyst.client, tenant)
    assert item["matches"] == [
        {"case_number": number, "case_title": "Campaign", "observables": ["ipv4:198.51.100[.]23"]}
    ]
    response = await analyst.client.post(
        f"/api/tenants/{tenant}/triage/{alert['alert_id']}/promote",
        json={"reason": "Same sender IP", "into": number},
    )
    assert response.json() == {"case_number": number, "new_case": False}

    await close_case(analyst.client, tenant, number)
    await queue_alert(client, tenant, token, payload={"source_ip": "198.51.100.23"})
    [later] = await queue(analyst.client, tenant)
    assert later["matches"] == []
    closed = await analyst.client.post(
        f"/api/tenants/{tenant}/triage/{later['id']}/promote",
        json={"reason": "x", "into": number},
    )
    assert closed.status_code == 422


async def test_dismiss_needs_a_reason_and_is_audited(
    tenant: str, token: str, client: AsyncClient, analyst: SignedIn, owner: AsyncEngine
) -> None:
    alert = await queue_alert(client, tenant, token)
    url = f"/api/tenants/{tenant}/triage/{alert['alert_id']}/dismiss"

    assert (await analyst.client.post(url, json={"reason": "  "})).status_code == 422
    assert (await analyst.client.post(url, json={"reason": "Known scanner"})).status_code == 204

    assert await queue(analyst.client, tenant) == []
    assert "alert.dismiss" in await audit_actions(owner, f"user:{analyst.id}")
    again = await analyst.client.post(url, json={"reason": "again"})
    assert again.status_code == 409


async def test_grouped_alert_joins_its_open_case_even_with_triage(
    tenant: str, token: str, client: AsyncClient, analyst: SignedIn
) -> None:
    first = await queue_alert(client, tenant, token, group_key="g-1", triage=False)
    second = await queue_alert(client, tenant, token, group_key="g-1")
    assert (second["case_number"], second["queued"]) == (first["case_number"], False)


async def test_triage_permissions_and_unknown_alerts(
    tenant: str, token: str, client: AsyncClient, make_user: MakeUser
) -> None:
    alert = await queue_alert(client, tenant, token)
    executive = await make_user({tenant: ["executive"]})
    assert len(await queue(executive.client, tenant)) == 1
    denied = await executive.client.post(
        f"/api/tenants/{tenant}/triage/{alert['alert_id']}/dismiss", json={"reason": "x"}
    )
    assert denied.status_code == 403
    analyst = await make_user({tenant: ["analyst"]})
    missing = await analyst.client.post(
        f"/api/tenants/{tenant}/triage/00000000-0000-0000-0000-000000000000/dismiss",
        json={"reason": "x"},
    )
    assert missing.status_code == 404
    bad_template = await client.post(
        f"/api/tenants/{tenant}/alerts",
        json={"template": "nope", "title": "x", "source": "elastic", "triage": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert bad_template.status_code == 422


async def test_webhook_can_queue(
    tenant: str, token: str, client: AsyncClient, analyst: SignedIn
) -> None:
    response = await client.post(
        f"/api/tenants/{tenant}/webhooks/crowdstrike",
        params={"template": "ransomware", "id_field": "detection_id", "triage": "true"},
        json={"title": "Suspicious PowerShell", "detection_id": "ldt:1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.json()["queued"] is True
    [item] = await queue(analyst.client, tenant)
    assert (item["source"], item["external_id"]) == ("crowdstrike", "ldt:1")
