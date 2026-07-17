"""Legacyページ画像と孤立Pipeline objectの安全なクリーンアップ。"""

from __future__ import annotations

import argparse
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Sequence

from app.rag.pipeline_repository import pipeline_repository
from app.services.oci_service import oci_service


CONFIRMATION = "CLEANUP_LEGACY_PAGE_IMAGES"
LEGACY_PAGE_IMAGE_PATTERN = re.compile(
    r"/page_(?:\d{3}|\d{6})(?:_[a-f0-9]{32})?\.png$", re.IGNORECASE
)


def is_internal_pipeline_object(object_name: str) -> bool:
    return object_name.startswith("_pipeline/") or "/_pipeline/" in object_name


def build_cleanup_plan(
    objects: Sequence[dict[str, Any]], referenced_object_names: set[str]
) -> dict[str, Any]:
    non_folders = [
        item
        for item in objects
        if not str(item.get("name") or "").endswith("/")
    ]
    original_bases = {
        re.sub(r"\.[^.]+$", "", str(item["name"]))
        for item in non_folders
        if not is_internal_pipeline_object(str(item["name"]))
        and not LEGACY_PAGE_IMAGE_PATTERN.search(str(item["name"]))
    }
    legacy = [
        item
        for item in non_folders
        if LEGACY_PAGE_IMAGE_PATTERN.search(str(item["name"]))
        and str(item["name"]).rsplit("/", 1)[0] in original_bases
    ]
    pipeline_objects = [
        item
        for item in non_folders
        if is_internal_pipeline_object(str(item["name"]))
    ]
    referenced = [
        item
        for item in pipeline_objects
        if str(item["name"]) in referenced_object_names
    ]
    orphaned = [
        item
        for item in pipeline_objects
        if str(item["name"]) not in referenced_object_names
    ]
    original_count = sum(
        not is_internal_pipeline_object(str(item["name"]))
        and not (
            LEGACY_PAGE_IMAGE_PATTERN.search(str(item["name"]))
            and str(item["name"]).rsplit("/", 1)[0] in original_bases
        )
        for item in non_folders
    )
    delete_items = [*legacy, *orphaned]
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "original_document_count": original_count,
        "legacy_page_image_count": len(legacy),
        "referenced_pipeline_image_count": len(referenced),
        "orphaned_pipeline_object_count": len(orphaned),
        "estimated_reclaimed_bytes": sum(
            int(item.get("size") or 0) for item in delete_items
        ),
        "delete_object_names": sorted(str(item["name"]) for item in delete_items),
        "legacy_object_names": sorted(str(item["name"]) for item in legacy),
        "orphaned_pipeline_object_names": sorted(
            str(item["name"]) for item in orphaned
        ),
        "protected_referenced_object_names": sorted(
            str(item["name"]) for item in referenced
        ),
    }


def _list_all_objects(bucket_name: str, namespace: str) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    page_token = None
    while True:
        result = oci_service.list_objects(
            bucket_name=bucket_name,
            namespace=namespace,
            prefix="",
            page_size=1000,
            page_token=page_token,
        )
        if not result.get("success"):
            raise RuntimeError(result.get("message") or "Object一覧を取得できません")
        objects.extend(result.get("objects", []))
        page_token = result.get("next_start_with")
        if not page_token:
            return objects


def _write_manifest(plan: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = output_dir / f"page-image-cleanup-{timestamp}.json"
    path.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    return path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Legacyページ画像と孤立Pipeline objectを安全に削除します"
    )
    parser.add_argument("--plan", action="store_true", help="削除せず計画のみ出力")
    parser.add_argument("--confirmation", help=f"実行時は {CONFIRMATION} を指定")
    parser.add_argument(
        "--manifest-dir",
        type=Path,
        default=Path("backups/page-image-cleanup"),
    )
    args = parser.parse_args(argv)
    if not args.plan and args.confirmation != CONFIRMATION:
        parser.error(f"実行には --confirmation {CONFIRMATION} が必要です")

    import os

    bucket_name = os.getenv("OCI_BUCKET")
    if not bucket_name:
        raise RuntimeError("OCI_BUCKETが設定されていません")
    namespace_result = oci_service.get_namespace()
    if not namespace_result.get("success"):
        raise RuntimeError(namespace_result.get("message") or "Namespaceを取得できません")
    namespace = str(namespace_result["namespace"])
    objects = _list_all_objects(bucket_name, namespace)
    referenced = pipeline_repository.referenced_page_image_object_names()
    plan = build_cleanup_plan(objects, referenced)
    manifest_path = _write_manifest(plan, args.manifest_dir)
    print(json.dumps({**plan, "manifest_path": str(manifest_path)}, ensure_ascii=False, indent=2))
    if args.plan:
        return 0

    for object_name in plan["delete_object_names"]:
        result = oci_service.delete_object(
            object_name, bucket_name=bucket_name, namespace=namespace
        )
        if not result.get("success"):
            raise RuntimeError(result.get("message") or f"削除失敗: {object_name}")

    remaining_objects = _list_all_objects(bucket_name, namespace)
    after_plan = build_cleanup_plan(remaining_objects, referenced)
    if after_plan["original_document_count"] != plan["original_document_count"]:
        raise RuntimeError("原本文書数が変化したため検証に失敗しました")
    remaining_names = {str(item.get("name") or "") for item in remaining_objects}
    missing_references = sorted(referenced - remaining_names)
    if missing_references:
        raise RuntimeError(
            "参照中のページ画像が見つかりません: " + ", ".join(missing_references)
        )
    unreadable_references = [
        object_name
        for object_name in sorted(referenced)
        if not oci_service.get_object_metadata(
            bucket_name, namespace, object_name
        ).get("success")
    ]
    if unreadable_references:
        raise RuntimeError(
            "参照中のページ画像を読み取れません: "
            + ", ".join(unreadable_references)
        )
    print(f"クリーンアップ完了: {len(plan['delete_object_names'])}件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
