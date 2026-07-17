from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from app.rag.pipeline_models import EmbeddingRecipe, PipelineJobRequest, PipelineStepSelector


@dataclass(frozen=True)
class PlannedStep:
    kind: str
    component_key: str
    reason: str


BASE_ORDER = {
    "render": 10,
    "native_parse": 20,
    "mineru_parse": 30,
    "ocr": 40,
    "normalize": 50,
    "vlm": 60,
    "embedding": 70,
    "publish": 80,
}


def _sort_key(component: str) -> tuple[int, str]:
    family = component.split(":", 1)[0]
    return BASE_ORDER.get(family, 999), component


def _kind(component: str) -> str:
    family = component.split(":", 1)[0]
    return {
        "render": "RENDER",
        "native_parse": "NATIVE_PARSE",
        "mineru_parse": "MINERU_PARSE",
        "ocr": "OCR",
        "normalize": "NORMALIZE",
        "vlm": "VLM",
        "embedding": "EMBED",
        "publish": "PUBLISH",
    }[family]


def _recipe_dependencies(recipe: EmbeddingRecipe) -> set[str]:
    result: set[str] = set()
    for item in recipe.inputs:
        if item.source_type == "PAGE_IMAGE":
            result.add("render")
        elif item.source_type == "NATIVE_TEXT":
            result.add("native_parse")
        elif item.source_type == "MINERU_TEXT":
            result.add("mineru_parse")
        elif item.source_type == "OCR_TEXT":
            result.add("ocr")
        elif item.source_type in {"PAGE_TEXT", "CHUNK_TEXT"}:
            result.add("normalize")
        elif item.source_type == "VLM_TEXT":
            result.add(f"vlm:{item.source_ref}")
    return result


def _direct_dependencies(
    component: str,
    *,
    recipes: dict[str, EmbeddingRecipe],
    required_for_publish: set[str],
) -> set[str]:
    if component == "ocr":
        return {"render"}
    if component == "normalize":
        # OCR/MinerU are optional sources, not prerequisites for an isolated
        # VLM/embedding rerun. FULL jobs still include them explicitly and
        # planned_dependencies() orders Normalize after those selected steps.
        return {"native_parse"}
    if component.startswith("vlm:"):
        return {"render", "normalize"}
    if component.startswith("embedding:"):
        recipe = recipes.get(component.split(":", 1)[1])
        if not recipe:
            raise ValueError(f"Embeddingレシピが見つかりません: {component}")
        return _recipe_dependencies(recipe)
    if component == "publish":
        return set(required_for_publish)
    return set()


def _closure(
    requested: Iterable[str],
    *,
    recipes: dict[str, EmbeddingRecipe],
    required_for_publish: set[str],
) -> set[str]:
    result = set(requested)
    pending = list(result)
    while pending:
        component = pending.pop()
        for dependency in _direct_dependencies(
            component,
            recipes=recipes,
            required_for_publish=required_for_publish,
        ):
            if dependency not in result:
                result.add(dependency)
                pending.append(dependency)
    return result


def affected_downstream(
    selected: set[str],
    *,
    recipes: list[EmbeddingRecipe],
    profile_slots: list[int],
) -> set[str]:
    affected: set[str] = set()
    for component in selected:
        if component in {"render", "native_parse", "mineru_parse", "ocr"}:
            affected.add("normalize")
        if component == "render":
            affected.add("ocr")
        if component in {"render", "native_parse", "mineru_parse", "ocr", "normalize"}:
            affected.update(f"vlm:{slot}" for slot in profile_slots)
            for recipe in recipes:
                render_affected = component == "render" and any(
                    item.source_type in {"PAGE_IMAGE", "VLM_TEXT"}
                    for item in recipe.inputs
                )
                dependency_affected = component != "render" and _recipe_dependencies(
                    recipe
                ).intersection(
                    {component, "normalize"}
                    if component != "normalize"
                    else {"normalize"}
                )
                if render_affected or dependency_affected:
                    affected.add(f"embedding:{recipe.code}")
        if component.startswith("vlm:"):
            slot = component.split(":", 1)[1]
            affected.update(
                f"embedding:{recipe.code}"
                for recipe in recipes
                if any(
                    item.source_type == "VLM_TEXT" and item.source_ref == slot
                    for item in recipe.inputs
                )
            )
    return affected - selected


def selector_components(steps: list[PipelineStepSelector]) -> set[str]:
    return {item.component_key for item in steps}


def plan_steps(
    request: PipelineJobRequest,
    *,
    recipes: list[EmbeddingRecipe],
    profile_slots: list[int],
    mineru_enabled: bool,
    ocr_enabled: bool,
) -> tuple[list[PlannedStep], set[str], set[str]]:
    recipe_map = {item.code: item for item in recipes}
    slots = {str(slot) for slot in profile_slots}

    def _blocked(component: str) -> bool:
        # 無効なVLMプロファイル（とそれを参照するレシピ）は計画に含めない。
        # 含めると無効化したはずのプロファイルでVLMが実行されコストが発生する。
        family, _, ref = component.partition(":")
        if family == "vlm":
            return ref not in slots
        if family == "embedding":
            recipe = recipe_map.get(ref)
            return bool(recipe) and any(
                item.source_type == "VLM_TEXT" and str(item.source_ref) not in slots
                for item in recipe.inputs
            )
        return False

    enabled_components = {
        f"embedding:{item.code}"
        for item in recipes
        if item.enabled and not _blocked(f"embedding:{item.code}")
    }
    enabled_components.update(f"vlm:{slot}" for slot in profile_slots)
    required_for_publish = {"render", "native_parse", "normalize", *enabled_components}
    if request.mode == "FULL":
        requested = set(required_for_publish)
        if mineru_enabled:
            requested.add("mineru_parse")
        if ocr_enabled:
            requested.add("ocr")
        requested.add("publish")
    else:
        requested = selector_components(request.steps)
        if not ocr_enabled:
            requested.discard("ocr")
        requested = {component for component in requested if not _blocked(component)}
    prerequisites = _closure(
        requested,
        recipes=recipe_map,
        required_for_publish=required_for_publish,
    ) - requested
    # FULL is a closed set of enabled stages.  Downstream impact expansion is
    # only meaningful for CUSTOM reruns; applying it to FULL would add disabled
    # optional stages (for example OCR merely because Render is selected).
    downstream = (
        set()
        if request.mode == "FULL"
        else affected_downstream(
            requested,
            recipes=recipes,
            profile_slots=profile_slots,
        )
    )
    expanded = set(requested) | prerequisites
    if request.include_downstream:
        expanded.update(downstream)
        expanded = _closure(
            expanded,
            recipes=recipe_map,
            required_for_publish=required_for_publish,
        )
    reasons = {
        component: (
            "requested"
            if component in requested
            else "downstream"
            if component in downstream and request.include_downstream
            else "prerequisite"
        )
        for component in expanded
    }
    planned = [
        PlannedStep(kind=_kind(component), component_key=component, reason=reasons[component])
        for component in sorted(expanded, key=_sort_key)
    ]
    return planned, prerequisites, downstream


def planned_dependencies(
    planned: list[PlannedStep],
    *,
    recipes: list[EmbeddingRecipe],
) -> dict[str, set[str]]:
    """Return dependencies that are actually present in this concrete job."""
    components = {item.component_key for item in planned}
    recipe_map = {item.code: item for item in recipes}
    result: dict[str, set[str]] = {}
    for item in planned:
        component = item.component_key
        if component == "normalize":
            dependencies = components.intersection(
                {"native_parse", "mineru_parse", "ocr"}
            )
        elif component == "publish":
            dependencies = components - {"publish"}
        else:
            dependencies = _direct_dependencies(
                component,
                recipes=recipe_map,
                required_for_publish=components - {"publish"},
            ).intersection(components)
        result[component] = dependencies
    return result
