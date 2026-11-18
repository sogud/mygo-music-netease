"""Build the local plugin ZIP without including session data or dependencies."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
manifest = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
destination = root / "dist" / f"netease-{manifest['version']}.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for name in ("plugin.json", "index.js", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"):
        archive.write(root / name, name)
print(destination)
