"""Azure Blob Storage for evidence. Browsers upload blocks straight to storage through SAS URLs."""

import math
import uuid
from base64 import b64encode
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from functools import cache
from urllib.parse import quote

from azure.identity import DefaultAzureCredential
from azure.storage.blob import (
    BlobBlock,
    BlobSasPermissions,
    BlobServiceClient,
    ContainerClient,
    ContentSettings,
    CorsRule,
    generate_blob_sas,
)

from app.config import settings

MB = 1024 * 1024
MAX_BLOCKS = 50_000  # Azure's limit per block blob
URL_TTL = timedelta(hours=6)
OCTET_STREAM = ContentSettings(content_type="application/octet-stream")


@cache
def service() -> BlobServiceClient:
    # A connection string (account key) is for the local emulator; Azure uses Entra ID
    # (workload identity in AKS) and has shared keys disabled.
    if settings.blob_connection_string:
        return BlobServiceClient.from_connection_string(settings.blob_connection_string)
    return BlobServiceClient(settings.blob_account_url, credential=DefaultAzureCredential())  # pyright: ignore[reportArgumentType]


def container() -> ContainerClient:
    return service().get_container_client(settings.blob_container)


def part_size(size: int) -> int:
    return max(settings.blob_block_size_mb * MB, math.ceil(size / MAX_BLOCKS))


def start_upload(key: str) -> str:
    """Blocks need no server-side setup; the ID only marks the upload as in progress."""
    return uuid.uuid4().hex


def _block_param(number: int) -> str:
    """Block IDs must all have the same length; the SDK base64-decodes them in block lists."""
    return quote(b64encode(f"{number:05d}".encode()).decode(), safe="")


def _sas(key: str) -> str:
    svc = service()
    now = datetime.now(UTC)
    expiry = now + URL_TTL
    permission = BlobSasPermissions(write=True)
    if settings.blob_connection_string:
        return generate_blob_sas(
            svc.account_name,  # pyright: ignore[reportArgumentType]
            settings.blob_container,
            key,
            account_key=svc.credential.account_key,
            permission=permission,
            expiry=expiry,
        )
    delegation = svc.get_user_delegation_key(now - timedelta(minutes=5), expiry)
    return generate_blob_sas(
        svc.account_name,  # pyright: ignore[reportArgumentType]
        settings.blob_container,
        key,
        user_delegation_key=delegation,
        permission=permission,
        expiry=expiry,
    )


def part_urls(key: str, upload_id: str, count: int) -> list[str]:
    base = settings.blob_public_url or service().url
    blob = f"{base.rstrip('/')}/{settings.blob_container}/{quote(key)}"
    sas = _sas(key)
    return [f"{blob}?comp=block&blockid={_block_param(n)}&{sas}" for n in range(1, count + 1)]


def finish_upload(key: str, upload_id: str) -> int:
    """Commit the uploaded blocks in order; return the blob's size."""
    blob = container().get_blob_client(key)
    _, uncommitted = blob.get_block_list("uncommitted")
    if not uncommitted:
        raise ValueError("no parts were uploaded")
    blocks = sorted(uncommitted, key=lambda b: b.id)
    blob.commit_block_list([BlobBlock(b.id) for b in blocks], content_settings=OCTET_STREAM)
    return sum(b.size for b in blocks)


def put(key: str, data: bytes) -> None:
    container().upload_blob(key, data, overwrite=True, content_settings=OCTET_STREAM)


def stream(key: str) -> Iterator[bytes]:
    yield from container().download_blob(key).chunks()


def delete(key: str) -> None:
    container().delete_blob(key)


def ensure_container() -> None:
    """Create the evidence container if needed. On Azure, Terraform creates it and sets CORS."""
    if not container().exists():
        container().create_container()
    if settings.blob_connection_string:
        # Emulator: browsers upload blocks from the app's origin.
        rule = CorsRule([settings.public_url], ["PUT"], allowed_headers=["*"])
        service().set_service_properties(cors=[rule])
