#!/usr/bin/env python3
"""Replace v1/v2 secret scripts in existing Pressboxd templates, preserving markup."""
from pathlib import Path
import re, shutil, sys
src=Path(__file__).resolve().parent
root=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path.cwd()
def locate(name):
    for folder in ('templates','views'):
        p=root/folder/name
        if p.is_file(): return p
    raise SystemExit(f'Missing {name}: expected templates/ or views/ (no files modified).')
shows=locate('shows.ejs');top=locate('top_shows.ejs')
replacements=[(shows,'shows_secure_script.html'),(top,'top_secure_script.html')]
prepared=[]
for path,script in replacements:
    content=path.read_text(encoding='utf-8')
    content=re.sub(r'<!--\s*SHELDON_(?:SECRET|SECURE)_[A-Z]+_V\d+\s*-->\s*<script>.*?</script>\s*','',content,flags=re.S)
    if '</body>' not in content:raise SystemExit(f'Missing </body> in {path}; no files modified.')
    content=content.replace('</body>',(src/script).read_text(encoding='utf-8')+'\n</body>',1)
    prepared.append((path,content))
for path,content in prepared:
    if content!=path.read_text(encoding='utf-8'):
        shutil.copy2(path,path.with_suffix(path.suffix+'.pre-secret-v3.bak'))
        path.write_text(content,encoding='utf-8');print('Updated',path)
    else: print('Already up to date:',path)
print('Done. Your Sheldon server gate from v2 remains intact; redeploy the two template files.')
