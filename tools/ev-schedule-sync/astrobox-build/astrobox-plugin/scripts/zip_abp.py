import zipfile, os, sys

dist = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dist')
out = os.path.join(os.path.dirname(dist), 'EV-Schedule-Sync.abp')

print(f'dist dir: {dist}')
print(f'output: {out}')
print(f'files in dist: {os.listdir(dist)}')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for f in os.listdir(dist):
        fp = os.path.join(dist, f)
        if os.path.isfile(fp) and not f.endswith('.abp'):
            zf.write(fp, f)
            print(f'  added: {f} ({os.path.getsize(fp)} bytes)')

size = os.path.getsize(out)
print(f'Created: {out}')
print(f'Size: {size} bytes')