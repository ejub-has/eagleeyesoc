"""The one place integrations make HTTP calls, so tests can replace it per module."""

from typing import Any

import httpx2

from app import actions
from app.actions import ActionFailed


async def send(
    method: str, url: str, *, headers: dict[str, str] | None = None, **kwargs: Any
) -> tuple[int, dict[str, Any]]:
    """One HTTP call; returns the status and the JSON body (empty when there is none)."""
    async with httpx2.AsyncClient(timeout=actions.REQUEST_TIMEOUT) as client:
        try:
            response = await client.request(method, url, headers=headers, **kwargs)
        except httpx2.HTTPError as error:
            host = url.split("/")[2] if "//" in url else url
            raise ActionFailed(f"{host} unreachable: {type(error).__name__}") from error
    try:
        body = response.json() if response.content else {}
    except ValueError:
        body = {}
    return response.status_code, body if isinstance(body, dict) else {}


def odata_quote(value: str) -> str:
    """A string literal for an OData $filter."""
    return "'" + value.replace("'", "''") + "'"
