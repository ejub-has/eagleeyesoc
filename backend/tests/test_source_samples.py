import json
from pathlib import Path
from typing import Any

import pytest
from httpx2 import AsyncClient

from tests.conftest import MakeToken

SAMPLES = Path(__file__).resolve().parents[2] / "docs" / "samples"

# source, sample file, query parameters from docs/integrations.md
SOURCES = [
    (
        "crowdstrike",
        "crowdstrike-fusion.json",
        {"title_field": "title", "id_field": "detection_id", "group_field": "host"},
    ),
    (
        "elastic",
        "elastic-kibana.json",
        {"title_field": "title", "id_field": "alert_id", "group_field": "rule_id"},
    ),
]


@pytest.mark.parametrize(("source", "sample", "fields"), SOURCES)
async def test_documented_source_mapping(
    client: AsyncClient, tenant: str, make_token: MakeToken, source: str, sample: str, fields: Any
) -> None:
    body = json.loads((SAMPLES / sample).read_text())
    token = await make_token(tenant, ["alerts:write", "cases:read"])
    headers = {"Authorization": f"Bearer {token}"}
    url = f"/api/tenants/{tenant}/webhooks/{source}"
    params = {"template": "ransomware"} | fields

    response = await client.post(url, params=params, json=body, headers=headers)

    assert response.status_code == 201, response.text
    number = response.json()["case_number"]
    case = (await client.get(f"/api/tenants/{tenant}/cases/{number}", headers=headers)).json()
    assert case["title"] == body["title"]
    assert case["source"] == source
    assert case["alerts"][0]["external_id"] == body[fields["id_field"]]
    retry = await client.post(url, params=params, json=body, headers=headers)
    assert retry.json()["duplicate"] is True
