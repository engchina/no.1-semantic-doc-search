from __future__ import annotations

import hashlib
import json


def stable_hash_value(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def embedding_input_fingerprint(
    source_type: object,
    source_ref: object,
    content_sha256: object,
) -> tuple[str, str, str]:
    """Canonicalize recipe lineage before hashing it across Python and Oracle."""
    return (
        str(source_type),
        str(source_ref or ""),
        str(content_sha256),
    )
