import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "kickstream"
STAGES = {
    "simulator",
    "analytics",
    "narration",
    "overlay",
    "gateway",
    "studio",
    "output",
    "broadcasts",
    "people",
    "agents",
    "fans",
    "copilot",
}
SHARED = {"contracts", "domain", "ports"}


def _kickstream_imports(path: Path) -> set[str]:
    found = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("kickstream."):
            found.add(node.module.split(".")[1])
        elif isinstance(node, ast.Import):
            found.update(
                alias.name.split(".")[1] for alias in node.names if alias.name.startswith("kickstream.")
            )
    return found


def test_a_stage_imports_only_itself_and_the_shared_packages():
    for stage in STAGES:
        files = list((PACKAGE / stage).rglob("*.py"))
        assert files, f"stage {stage} has no modules"
        for path in files:
            unexpected = _kickstream_imports(path) - SHARED - {stage}
            assert not unexpected, f"{path.relative_to(PACKAGE)} imports {sorted(unexpected)}"


def test_concrete_adapters_are_named_only_in_the_composition_root():
    for path in PACKAGE.rglob("*.py"):
        if path.parent.name == "adapters" or path.name == "app.py":
            continue
        assert "adapters" not in _kickstream_imports(path), f"{path.relative_to(PACKAGE)} imports an adapter"


def test_shared_packages_do_not_depend_on_stages_or_adapters():
    for shared in ("domain", "ports"):
        for path in (PACKAGE / shared).rglob("*.py"):
            unexpected = _kickstream_imports(path) - SHARED
            assert not unexpected, f"{path.relative_to(PACKAGE)} imports {sorted(unexpected)}"
