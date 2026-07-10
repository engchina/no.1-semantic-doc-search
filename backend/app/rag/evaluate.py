from __future__ import annotations

import argparse
import asyncio
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.rag.models import FieldFilter
from app.rag.search_pipeline import search_pipeline


@dataclass(frozen=True)
class EvaluationCase:
    case_id: str
    query: str
    gains: dict[str, float]
    field_filters: list[FieldFilter]
    image_path: Path | None


def load_cases(path: Path) -> list[EvaluationCase]:
    cases: list[EvaluationCase] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        raw = json.loads(line)
        relevant = raw.get("relevant")
        if isinstance(relevant, list) and relevant and isinstance(relevant[0], dict):
            gains = {
                str(item["document_id"]): float(item.get("gain", 1))
                for item in relevant
            }
        else:
            identifiers = raw.get("relevant_document_ids") or relevant or []
            gains = {str(value): 1.0 for value in identifiers}
        if not gains:
            raise ValueError(f"line {line_number}: at least one relevant document is required")
        image_path = Path(raw["image_path"]) if raw.get("image_path") else None
        cases.append(
            EvaluationCase(
                case_id=str(raw.get("id") or line_number),
                query=str(raw.get("query") or ""),
                gains=gains,
                field_filters=[FieldFilter.model_validate(value) for value in raw.get("field_filters", [])],
                image_path=image_path,
            )
        )
    return cases


def _dcg(ranked: list[str], gains: dict[str, float], k: int) -> float:
    return sum(
        (2 ** gains.get(document_id, 0) - 1) / math.log2(rank + 1)
        for rank, document_id in enumerate(ranked[:k], start=1)
    )


async def evaluate(cases: list[EvaluationCase]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for case in cases:
        image = case.image_path.read_bytes() if case.image_path else None
        response = await search_pipeline.search(
            query=case.query,
            top_k=120,
            field_filters=case.field_filters,
            document_types=[],
            current_version_only=True,
            user_hash="evaluation-principal",
            image=image,
            debug=True,
        )
        final_ids = [item.document_id for item in response.results]
        pre_ids = [str(value) for value in response.diagnostics.get("pre_rerank_document_ids", [])]
        relevant = set(case.gains)
        recall = len(relevant.intersection(pre_ids[:120])) / len(relevant)
        hit3 = float(bool(relevant.intersection(final_ids[:3])))
        ideal = sorted(case.gains, key=case.gains.get, reverse=True)
        ideal_dcg = _dcg(ideal, case.gains, 10)
        ndcg = _dcg(final_ids, case.gains, 10) / ideal_dcg if ideal_dcg else 0.0
        rows.append(
            {
                "id": case.case_id,
                "recall_at_120": recall,
                "hit_at_3": hit3,
                "ndcg_at_10": ndcg,
                "trace_id": response.trace_id,
                "degraded": response.diagnostics.get("degraded", []),
            }
        )
    count = max(1, len(rows))
    return {
        "cases": rows,
        "summary": {
            "case_count": len(rows),
            "recall_at_120": sum(row["recall_at_120"] for row in rows) / count,
            "hit_at_3": sum(row["hit_at_3"] for row in rows) / count,
            "ndcg_at_10": sum(row["ndcg_at_10"] for row in rows) / count,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate retrieval from an external JSONL set")
    parser.add_argument("golden_set", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--enforce-targets", action="store_true")
    args = parser.parse_args()
    report = asyncio.run(evaluate(load_cases(args.golden_set)))
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(serialized + "\n", encoding="utf-8")
    else:
        print(serialized)
    summary = report["summary"]
    if args.enforce_targets and (
        summary["recall_at_120"] < 0.98
        or summary["hit_at_3"] < 0.90
        or summary["ndcg_at_10"] < 0.90
    ):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
