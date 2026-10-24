#!/usr/bin/env python3
"""Install Sheldon Results Easter egg without altering existing page layout."""
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent
PROJECT = Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path.cwd()


def find_template(name):
    for folder in ('templates','views'):
        p=PROJECT/folder/name
        if p.is_file(): return p
    raise SystemExit(f'Cannot find {name} under {PROJECT}/templates or {PROJECT}/views. No files changed yet for this template.')


def apply(target, asset, tag):
    code=target.read_text(encoding='utf-8')
    payload=(ROOT/asset).read_text(encoding='utf-8').strip()
    if tag in code:
        print(f'Already installed: {target}')
        return
    if '</body>' not in code:
        raise SystemExit(f'Missing </body> in {target}. No changes made to this file.')
    if code.count('</body>') != 1:
        raise SystemExit(f'Unexpected body markup in {target}. Not modifying it.')
    shutil.copy2(target,target.with_suffix(target.suffix+'.sheldon-backup'))
    target.write_text(code.replace('</body>',payload+'\n</body>',1),encoding='utf-8')
    print(f'Updated {target}')

shows=find_template('shows.ejs')
top=find_template('top_shows.ejs')
# Both files are located and validated before modifying either.
for p in (shows,top):
    if '</body>' not in p.read_text(encoding='utf-8'):
        raise SystemExit(f'Missing </body> in {p}; aborting before changes.')
apply(shows,'shows_secret_script.html','SHELDON_SECRET_SHOWS_V1')
apply(top,'top_secret_script.html','SHELDON_SECRET_TOP_V1')
print('Installed. No CSS, routes, or data were changed.')
