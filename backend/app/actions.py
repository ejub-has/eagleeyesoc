"""Actions a workflow step can run: what each needs, what it changes, and how it runs.

An action that changes something outside the case (an account, a device, a token) has
impact "change"; its steps default to needing approval. Connector-backed actions (Entra,
Intune, CrowdStrike, Google Workspace, Slack) register here as they are added.
"""

import ipaddress
import json
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx2
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import journal, tasks
from app.models import Case, WorkflowRun

REQUEST_TIMEOUT = 15.0  # seconds for any call an action makes to another service


class ActionFailed(Exception):
    """The action ran and failed; the message is shown on the step."""


class InputSpec(BaseModel):
    name: str
    label: str
    required: bool = True
    multiline: bool = False
    help: str = ""


class ActionSpec(BaseModel):
    key: str
    label: str
    description: str
    group: str
    impact: Literal["read", "change"]
    inputs: list[InputSpec]
    connector: str | None = None  # kind of connector the action needs, e.g. entra


@dataclass
class ActionContext:
    db: AsyncSession
    case: Case
    run: WorkflowRun
    actor: str  # workflow:<run id>


Runner = Callable[[ActionContext, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class Action:
    spec: ActionSpec
    run: Runner


REGISTRY: dict[str, Action] = {}


def action(
    key: str,
    label: str,
    description: str,
    group: str,
    impact: Literal["read", "change"],
    inputs: list[InputSpec],
    connector: str | None = None,
) -> Callable[[Runner], Runner]:
    def register(run: Runner) -> Runner:
        spec = ActionSpec(
            key=key,
            label=label,
            description=description,
            group=group,
            impact=impact,
            inputs=inputs
            + (
                [
                    InputSpec(
                        name="connector",
                        label="Connector",
                        required=False,
                        help=f"key of the {connector} connector; empty uses the only one",
                    )
                ]
                if connector
                else []
            ),
            connector=connector,
        )
        REGISTRY[key] = Action(spec, run)
        return run

    return register


def text(inputs: dict[str, Any], name: str) -> str:
    """A required input as text; empty means the alert lacked the field it was mapped to."""
    value = inputs.get(name)
    if value is None or str(value).strip() == "":
        raise ActionFailed(f"input {name} is empty")
    return str(value) if not isinstance(value, (dict, list)) else json.dumps(value)


# --- Case actions -------------------------------------------------------------------------


@action(
    "case.add_note",
    "Add a note",
    "Adds a note to the case journal.",
    "Case",
    "read",
    [InputSpec(name="body", label="Note", multiline=True)],
)
async def add_note(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    body = journal.NoteIn(body=text(inputs, "body")[:20_000])
    note, _ = await journal.add_note(ctx.db, ctx.case, ctx.actor, body)
    return {"note_id": str(note.id)}


@action(
    "case.add_task",
    "Add a task",
    "Adds an open task to the case.",
    "Case",
    "read",
    [
        InputSpec(name="title", label="Title"),
        InputSpec(name="description", label="Description", required=False, multiline=True),
    ],
)
async def add_task(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    description = str(inputs.get("description") or "")[:10_000]
    body = tasks.TaskIn(title=text(inputs, "title")[:300], description=description)
    task = await tasks.add_task(ctx.db, ctx.case, body)
    return {"task_id": str(task.id)}


@action(
    "case.add_timeline_event",
    "Add a timeline event",
    "Records an event on the case timeline at the time the step runs.",
    "Case",
    "read",
    [InputSpec(name="description", label="Description", multiline=True)],
)
async def add_timeline_event(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    body = journal.TimelineIn(
        occurred_at=datetime.now(UTC),
        source="workflow",
        description=text(inputs, "description")[:2000],
    )
    event = await journal.add_event(ctx.db, ctx.case, ctx.actor, body)
    return {"event_id": str(event.id)}


# --- Generic webhook ----------------------------------------------------------------------


def _public(host: str) -> bool:
    """True when every address the host resolves to is publicly routable."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return False
    return all(ipaddress.ip_address(info[4][0]).is_global for info in infos)


async def post_json(url: str, payload: Any) -> httpx2.Response:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ActionFailed("the URL must start with https://")
    if not _public(parts.hostname):
        raise ActionFailed("the URL must point to a public address")
    async with httpx2.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=False) as client:
        return await client.post(url, json=payload)


@action(
    "http.post",
    "Call a webhook",
    "POSTs JSON to an HTTPS URL, for example to start a playbook in another tool. "
    "Private and internal addresses are refused.",
    "Integrations",
    "change",
    [
        InputSpec(name="url", label="URL", help="https:// only"),
        InputSpec(
            name="body",
            label="JSON body",
            required=False,
            multiline=True,
            help="JSON; templates such as {{alert.payload.user}} are filled in first",
        ),
    ],
)
async def http_post(ctx: ActionContext, inputs: dict[str, Any]) -> dict[str, Any]:
    raw = inputs.get("body")
    if isinstance(raw, str) and raw.strip():
        try:
            payload: Any = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ActionFailed(f"the body is not valid JSON: {error.msg}") from error
    else:
        payload = raw if raw not in (None, "") else {"case": ctx.case.number}
    try:
        response = await post_json(text(inputs, "url"), payload)
    except httpx2.HTTPError as error:
        raise ActionFailed(f"request failed: {type(error).__name__}") from error
    if response.status_code >= 400:
        raise ActionFailed(f"the webhook answered {response.status_code}")
    return {"status": response.status_code}


def catalog() -> list[ActionSpec]:
    return sorted((a.spec for a in REGISTRY.values()), key=lambda s: (s.group, s.label))
