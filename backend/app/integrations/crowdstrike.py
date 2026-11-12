"""CrowdStrike Falcon actions: network-contain a host and lift containment.

The API client needs the Hosts scope with read and write. Containment cuts the host off
from the network except for its connection to the Falcon cloud.
"""

import re
import time
from typing import Any
from urllib.parse import quote

from app import actions, connectors
from app.actions import ActionContext, ActionFailed, InputSpec, action
from app.integrations.http import send

CLOUDS = {
    "us-1": "https://api.crowdstrike.com",
    "us-2": "https://api.us-2.crowdstrike.com",
    "eu-1": "https://api.eu-1.crowdstrike.com",
    "us-gov-1": "https://api.laggar.gcw.crowdstrike.com",
}
AID = re.compile(r"^[0-9a-f]{32}$")
HOSTNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")

_tokens: dict[tuple[str, str], tuple[str, float]] = {}


def _base(creds: connectors.Credentials) -> str:
    return CLOUDS[creds.settings["cloud"]]


async def token(creds: connectors.Credentials, fresh: bool = False) -> str:
    key = (creds.settings["cloud"], creds.settings["client_id"])
    cached = _tokens.get(key)
    if cached and cached[1] > time.monotonic() + 60 and not fresh:
        return cached[0]
    status, body = await send(
        "POST",
        f"{_base(creds)}/oauth2/token",
        data={"client_id": creds.settings["client_id"], "client_secret": creds.secret},
    )
    if status != 201 or "access_token" not in body:
        raise ActionFailed(f"CrowdStrike sign-in for connector {creds.key} failed ({status})")
    _tokens[key] = (body["access_token"], time.monotonic() + float(body.get("expires_in", 1799)))
    return body["access_token"]


async def falcon(
    ctx: ActionContext, inputs: dict[str, Any], method: str, path: str, body: Any = None
) -> dict[str, Any]:
    try:
        creds = await connectors.credentials(ctx.db, "crowdstrike", inputs.get("connector") or None)
    except (LookupError, ValueError) as error:
        raise ActionFailed(str(error)) from error
    headers = {"Authorization": f"Bearer {await token(creds)}"}
    status, reply = await send(method, f"{_base(creds)}{path}", headers=headers, json=body)
    if status >= 400:
        errors = reply.get("errors") or [{}]
        message = errors[0].get("message", "") if isinstance(errors[0], dict) else ""
        if status in (401, 403):
            raise ActionFailed("CrowdStrike refused the call; the API client needs Hosts: Write")
        raise ActionFailed(f"CrowdStrike error {status}" + (f": {message}" if message else ""))
    return reply


async def host_id(ctx: ActionContext, inputs: dict[str, Any]) -> str:
    host = actions.text(inputs, "host").strip()
    if AID.fullmatch(host.lower()):
        return host.lower()
    if not HOSTNAME.fullmatch(host):
        raise ActionFailed("host must be a Falcon host ID or a hostname")
    found = await falcon(
        ctx, inputs, "GET", f"/devices/queries/devices/v1?filter={quote(f"hostname:'{host}'")}"
    )
    ids = found.get("resources") or []
    if len(ids) != 1:
        raise ActionFailed(f"{len(ids)} hosts are named {host}; use the host ID")
    return str(ids[0])


HOST_INPUT = InputSpec(
    name="host",
    label="Host",
    help="Falcon host ID (aid) or hostname, e.g. {{alert.payload.device_id}}",
)


async def _contain(ctx: ActionContext, inputs: dict[str, Any], name: str) -> dict[str, Any]:
    aid = await host_id(ctx, inputs)
    path = f"/devices/entities/devices-actions/v2?action_name={name}"
    await falcon(ctx, inputs, "POST", path, {"ids": [aid]})
    return {"host_id": aid, "action": name}


@action(
    "crowdstrike.contain_host",
    "Contain a host (CrowdStrike)",
    "Network-contains the host: it can reach only the Falcon cloud until containment is lifted.",
    "CrowdStrike",
    "change",
    [HOST_INPUT],
    connector="crowdstrike",
)
async def contain_host(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    return await _contain(ctx, inputs, "contain")


@action(
    "crowdstrike.lift_containment",
    "Lift containment (CrowdStrike)",
    "Restores the host's network access.",
    "CrowdStrike",
    "change",
    [HOST_INPUT],
    connector="crowdstrike",
)
async def lift_containment(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    return await _contain(ctx, inputs, "lift_containment")
