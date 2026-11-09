from typing import Any

import pytest
from httpx2 import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app import attack
from app.attack import Tactic
from tests.conftest import MakeToken, MakeUser


def test_finds_technique_and_tactic_ids_and_tactic_names() -> None:
    techniques, tactics = attack.find(
        {
            "technique": "T1059.001",
            "threat": [{"tactic": {"id": "TA0002", "name": "Execution"}}],
            "tactic": "Lateral Movement",
            "note": "see T1566 and T15660, TA9999, ATT1000, XT1003 or T1003.001.2",
        }
    )
    assert techniques == {"T1059.001", "T1566"}
    assert tactics == {Tactic.EXECUTION, Tactic.LATERAL_MOVEMENT}


@pytest.mark.parametrize(
    ("tactic", "name"),
    [
        (Tactic.COMMAND_AND_CONTROL, "Command and Control"),
        (Tactic.PRIVILEGE_ESCALATION, "Privilege Escalation"),
        (Tactic.IMPACT, "Impact"),
    ],
)
def test_tactic_names(tactic: Tactic, name: str) -> None:
    assert attack.tactic_name(tactic) == name


def test_names_must_match_whole_values() -> None:
    assert attack.find({"summary": "Discovery of an execution bug"}) == (set(), set())


async def post(client: AsyncClient, tenant: str, token: str, **body: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/tenants/{tenant}/alerts",
        json={"template": "ransomware", "title": "Detection", "source": "crowdstrike"} | body,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


async def test_alerts_fill_the_case_mapping(
    client: AsyncClient, tenant: str, make_token: MakeToken, make_user: MakeUser, owner: AsyncEngine
) -> None:
    token = await make_token(tenant, ["alerts:write"])
    analyst = await make_user({tenant: ["analyst"]})
    first = await post(
        client,
        tenant,
        token,
        group_key="host-1",
        payload={"tactic": "Execution", "technique": "T1059.001"},
    )
    await post(
        client,
        tenant,
        token,
        title="T1486 data encrypted",
        group_key="host-1",
        payload={"tactic": "Impact"},
    )

    url = f"/api/tenants/{tenant}/cases/{first['case_number']}"
    case = (await analyst.client.get(url)).json()
    assert case["attack_techniques"] == ["T1059.001", "T1486"]
    assert case["attack_tactics"] == ["TA0002", "TA0040"]

    edited = await analyst.client.patch(url, json={"attack_tactics": ["TA0001"]})
    assert edited.status_code == 200, edited.text
    assert (await analyst.client.get(url)).json()["attack_tactics"] == ["TA0001"]
    bad = await analyst.client.patch(url, json={"attack_tactics": ["TA9999"]})
    assert bad.status_code == 422

    async with owner.connect() as conn:
        details = list(
            await conn.scalars(
                text("SELECT detail FROM audit_log WHERE action = 'alert.ingest' ORDER BY id")
            )
        )
    assert details[-1]["attack"] == {"techniques": ["T1486"], "tactics": ["TA0040"]}


async def test_promoted_alert_maps_its_case(
    client: AsyncClient, tenant: str, make_token: MakeToken, make_user: MakeUser
) -> None:
    token = await make_token(tenant, ["alerts:write"])
    analyst = await make_user({tenant: ["analyst"]})
    queued = await post(
        client, tenant, token, triage=True, payload={"technique": "T1566.001", "tactic": "TA0001"}
    )
    promoted = await analyst.client.post(
        f"/api/tenants/{tenant}/triage/{queued['alert_id']}/promote", json={"reason": "real"}
    )
    number = promoted.json()["case_number"]
    case = (await analyst.client.get(f"/api/tenants/{tenant}/cases/{number}")).json()
    assert (case["attack_techniques"], case["attack_tactics"]) == (["T1566.001"], ["TA0001"])
