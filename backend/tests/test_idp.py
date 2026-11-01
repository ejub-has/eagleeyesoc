from typing import Any

import pytest
from authlib.integrations.base_client import OAuthError
from pytest import MonkeyPatch
from starlette.requests import Request
from starlette.responses import RedirectResponse

from app import idp

REQUEST = Request({"type": "http"})


async def test_login_redirect_uses_public_callback(monkeypatch: MonkeyPatch) -> None:
    calls: list[str] = []

    async def authorize_redirect(request: Request, redirect_uri: str) -> RedirectResponse:
        calls.append(redirect_uri)
        return RedirectResponse("https://idp.test/auth")

    monkeypatch.setattr(idp.client, "authorize_redirect", authorize_redirect)
    await idp.login_redirect(REQUEST)
    assert calls == ["http://localhost:8080/api/auth/callback"]


async def test_complete_login_maps_claims(monkeypatch: MonkeyPatch) -> None:
    async def authorize_access_token(request: Request) -> dict[str, Any]:
        return {
            "refresh_token": "refresh-1",
            "id_token": "id-token-1",
            "userinfo": {"sub": "abc", "preferred_username": "jdoe", "groups": ["g1"]},
        }

    monkeypatch.setattr(idp.client, "authorize_access_token", authorize_access_token)
    assert await idp.complete_login(REQUEST) == idp.Identity(
        subject="abc",
        username="jdoe",
        email=None,
        display_name="jdoe",
        groups=["g1"],
        refresh_token="refresh-1",
        id_token="id-token-1",
    )


async def test_refresh_reads_groups_from_the_new_id_token(monkeypatch: MonkeyPatch) -> None:
    async def fetch_access_token(**kwargs: str) -> dict[str, str]:
        assert kwargs == {"grant_type": "refresh_token", "refresh_token": "refresh-1"}
        return {"access_token": "access", "id_token": "id-2", "refresh_token": "refresh-2"}

    async def parse_id_token(token: dict[str, str], nonce: None) -> dict[str, Any]:
        assert token["id_token"] == "id-2"
        return {"sub": "abc", "groups": ["g2"]}

    monkeypatch.setattr(idp.client, "fetch_access_token", fetch_access_token)
    monkeypatch.setattr(idp.client, "parse_id_token", parse_id_token)
    assert await idp.refresh("refresh-1") == (["g2"], "refresh-2")


async def test_entra_app_roles_claim(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(idp.settings, "oidc_roles_claim", "roles")
    claims = {"sub": "abc", "preferred_username": "jdoe@contoso.test", "roles": ["r1"]}

    async def authorize_access_token(request: Request) -> dict[str, Any]:
        return {"refresh_token": "refresh-1", "id_token": "id-1", "userinfo": claims}

    async def fetch_access_token(**kwargs: str) -> dict[str, str]:
        # Entra may omit a rotated refresh token; the current one stays valid.
        return {"access_token": "access", "id_token": "id-2"}

    async def parse_id_token(token: dict[str, str], nonce: None) -> dict[str, Any]:
        return claims | {"roles": ["r2"], "groups": ["ignored"]}

    monkeypatch.setattr(idp.client, "authorize_access_token", authorize_access_token)
    monkeypatch.setattr(idp.client, "fetch_access_token", fetch_access_token)
    monkeypatch.setattr(idp.client, "parse_id_token", parse_id_token)
    assert (await idp.complete_login(REQUEST)).groups == ["r1"]
    assert await idp.refresh("refresh-1") == (["r2"], "refresh-1")


async def test_refresh_without_id_token_fails(monkeypatch: MonkeyPatch) -> None:
    async def fetch_access_token(**kwargs: str) -> dict[str, str]:
        return {"access_token": "access", "refresh_token": "refresh-2"}

    async def parse_id_token(token: dict[str, str], nonce: None) -> None:
        return None

    monkeypatch.setattr(idp.client, "fetch_access_token", fetch_access_token)
    monkeypatch.setattr(idp.client, "parse_id_token", parse_id_token)
    with pytest.raises(OAuthError):
        await idp.refresh("refresh-1")


async def test_logout_url_returns_to_app(monkeypatch: MonkeyPatch) -> None:
    async def load_server_metadata() -> dict[str, str]:
        return {"end_session_endpoint": "https://idp.test/logout"}

    monkeypatch.setattr(idp.client, "load_server_metadata", load_server_metadata)
    base = (
        "https://idp.test/logout?client_id=casemgr"
        "&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A8080"
    )
    assert await idp.logout_url(None) == base
    assert await idp.logout_url("id-token-1") == f"{base}&id_token_hint=id-token-1"
