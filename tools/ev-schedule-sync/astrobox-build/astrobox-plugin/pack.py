import zipfile
from pathlib import Path

dist_dir = Path("/Users/Banner/Documents/guomengtao/app-auth/tools/ev-schedule-sync/astrobox-build/astrobox-plugin/dist")
out = dist_dir / "EV-Schedule-Sync.abp"

files = list(dist_dir.glob("*"))
print(f"Files in dist: {[f.name for f in files]}")

with zipfile.ZipFile(str(out), "w", zipfile.ZIP_DEFLATED) as zf:
    for f in files:
        if f.name.endswith(".abp"):
            continue
        zf.write(str(f), f.name)
        print(f"Added: {f.name} ({f.stat().st_size} bytes)")

print(f"Size: {out.stat().st_size}")