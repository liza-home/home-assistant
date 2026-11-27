"""Ruwido's catalogue blob, and the bare signal ``send_ir`` takes out of it.

Read strictly and without I/O; the envelope layout is documented under
``send_ir`` in Document/PROTOCOL.md.
"""
from __future__ import annotations

import base64
import binascii
import zlib
from dataclasses import dataclass
from typing import Final

#: The only envelope version the catalogue is known to deliver.
VERSION: Final = 1

_HEADER_LEN: Final = 2
_RECORD_HEAD_LEN: Final = 3
_CRC_LEN: Final = 4


class IrBlobError(ValueError):
    """A blob could not be read, or a signal could not be made."""


@dataclass(frozen=True, slots=True)
class IrRecord:
    """One key of a code set: which key, and the signal bytes as delivered."""

    key_id: int
    signal: bytes


def decode(text: str) -> bytes:
    """The bytes behind a base64 blob, or raise :class:`IrBlobError`."""
    try:
        return base64.b64decode(text.strip(), validate=True)
    except (binascii.Error, ValueError, AttributeError) as exc:
        raise IrBlobError(f"not base64: {exc}") from exc


def encode(data: bytes) -> str:
    """*data* as the base64 the protocol and the page config carry."""
    return base64.b64encode(data).decode("ascii")


def parse(blob: bytes | str) -> tuple[IrRecord, ...]:
    """Every record of *blob*, in order; raise on a wrong version, length or checksum."""
    data = decode(blob) if isinstance(blob, str) else bytes(blob)
    if len(data) < _HEADER_LEN + _CRC_LEN:
        raise IrBlobError(f"too short for a blob: {len(data)} bytes")
    if data[0] != VERSION:
        raise IrBlobError(f"unknown blob version {data[0]}")

    expected = zlib.crc32(data[:-_CRC_LEN])
    found = int.from_bytes(data[-_CRC_LEN:], "little")
    if found != expected:
        raise IrBlobError(f"checksum {found:#010x} does not match {expected:#010x}")

    body = data[_HEADER_LEN:-_CRC_LEN]
    records: list[IrRecord] = []
    offset = 0
    for _ in range(data[1]):
        if offset + _RECORD_HEAD_LEN > len(body):
            raise IrBlobError("record header runs past the end of the blob")
        signal_len = body[offset + 2]
        end = offset + _RECORD_HEAD_LEN + signal_len
        if end > len(body):
            raise IrBlobError("signal runs past the end of the blob")
        records.append(IrRecord(
            key_id=int.from_bytes(body[offset:offset + 2], "little"),
            signal=bytes(body[offset + _RECORD_HEAD_LEN:end]),
        ))
        offset = end
    if offset != len(body):
        raise IrBlobError(f"{len(body) - offset} bytes left over after {data[1]} records")
    return tuple(records)


def checksum(blob: bytes | str) -> str:
    """The CRC32 *blob* ends with, as 8 hex digits: a stable id for its code set."""
    data = decode(blob) if isinstance(blob, str) else bytes(blob)
    if len(data) < _CRC_LEN:
        raise IrBlobError(f"too short for a blob: {len(data)} bytes")
    return data[-_CRC_LEN:][::-1].hex()


def for_key(blob: bytes | str, key_id: int) -> str:
    """The base64 signal of *key_id* in *blob*: what ``send_ir`` is sent."""
    for record in parse(blob):
        if record.key_id == key_id:
            return encode(record.signal)
    raise IrBlobError(f"code set has no key {key_id}")
