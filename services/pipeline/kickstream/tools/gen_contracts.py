"""Generate kickstream/contracts.py from the shared JSON Schema.

Run `python -m kickstream.tools.gen_contracts` to regenerate.
Run with `--check` to exit non-zero when the checked-in file is stale.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

PIPELINE_ROOT = Path(__file__).resolve().parents[2]
SCHEMA = PIPELINE_ROOT.parents[1] / "packages" / "contracts" / "kickstream.schema.json"
TARGET = PIPELINE_ROOT / "kickstream" / "contracts.py"


def render(out: Path) -> None:
    # The formatter takes its line length from the pyproject.toml nearest the output file.
    with tempfile.TemporaryDirectory(dir=PIPELINE_ROOT) as tmp:
        staged = Path(tmp) / "contracts.py"
        subprocess.run(
            [
                sys.executable,
                "-m",
                "datamodel_code_generator",
                "--input",
                str(SCHEMA),
                "--input-file-type",
                "jsonschema",
                "--output",
                str(staged),
                "--output-model-type",
                "pydantic_v2.BaseModel",
                "--target-python-version",
                "3.13",
                "--use-standard-collections",
                "--use-union-operator",
                "--enum-field-as-literal",
                "all",
                "--disable-timestamp",
                "--formatters",
                "builtin",
            ],
            check=True,
        )
        out.write_bytes(staged.read_bytes())


def _normalized(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def main(argv: list[str]) -> int:
    if "--check" not in argv:
        render(TARGET)
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / "contracts.py"
        render(fresh)
        if _normalized(fresh) != _normalized(TARGET):
            print("kickstream/contracts.py is stale; run: python -m kickstream.tools.gen_contracts")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
