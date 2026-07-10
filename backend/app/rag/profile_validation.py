from __future__ import annotations

import hashlib
import json

from app.rag.models import ProfileConfig


def validate_profile(profile: ProfileConfig) -> list[str]:
    errors: list[str] = []
    if not profile.name.strip():
        errors.append("name is required")
    if not profile.extraction_prompt.strip():
        errors.append("extraction_prompt is required")
    if "{%" in profile.extraction_prompt or "{{" in profile.extraction_prompt:
        errors.append("extraction_prompt is an instruction, not a template")
    return errors


def profile_hash(profile: ProfileConfig) -> str:
    payload = {
        "slot_no": profile.slot_no,
        "extraction_prompt": profile.extraction_prompt,
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
