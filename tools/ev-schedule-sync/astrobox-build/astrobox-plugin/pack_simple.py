import zipfile, os

dist = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')
out_name = 'EV-Schedule-Sync.abp'
out = os.path.join(dist, out_name)

files = [f for f in os.listdir(dist) if os.path.isfile(os.path.join(dist, f)) and not f.endswith('.abp')]
print(f'Files: {files}')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for f in files:
        fp = os.path.join(dist, f)
        zf.write(fp, f)

print(f'Created: {out} ({os.path.getsize(out)} bytes)')