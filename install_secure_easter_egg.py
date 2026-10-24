#!/usr/bin/env python3
"""Patch the existing Sheldon module and EJS templates in place; no styling changes."""
from pathlib import Path
import sys,re,shutil
SOURCE=Path(__file__).resolve().parent
ROOT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path.cwd()
module=ROOT/'sheldon_results.js'
if not module.is_file():sys.exit('Missing sheldon_results.js beside app.js')
def template(name):
 for d in ('templates','views'):
  p=ROOT/d/name
  if p.is_file(): return p
 sys.exit(f'Missing {name} in templates/ or views/')
shows=template('shows.ejs'); top=template('top_shows.ejs'); idx=template('sheldon_index.ejs'); sheet=template('sheldon_sheet.ejs')
files={p:p.read_text(encoding='utf-8') for p in (module,shows,top,idx,sheet)}
code=files[module]
if 'SHELDON_SECURE_V2' not in code:
 marker='function mount(app,getConn){const admin=requireAdmin(getConn);'
 if marker not in code: sys.exit('Unknown sheldon_results.js layout: missing mount marker; no files updated.')
 inject=(SOURCE/'server_gate.txt').read_text()
 code=code.replace(marker,marker+'\n'+inject+'\n',1)
 files[module]=code
 # exact public routes, leave admin untouched
 # middleware intercept /sheldon-results GET before all mounted routes, added at top of mount
for p,tag,asset in [(shows,'SHELDON_SECRET_SHOWS_V1','shows_secure_script.html'),(top,'SHELDON_SECRET_TOP_V1','top_secure_script.html')]:
 content=files[p]
 content=re.sub(r'<!-- '+tag+r'.*?-->\s*<script>.*?</script>\s*', '',content,flags=re.S)
 content=re.sub(r'<!-- SHELDON_SECURE_[A-Z]+_V2.*?-->\s*<script>.*?</script>\s*','',content,flags=re.S)
 if '</body>' not in content: sys.exit(f'Missing body tag in {p}')
 files[p]=content.replace('</body>',(SOURCE/asset).read_text()+'\n</body>',1)
for p in (idx,sheet):
 content=files[p]
 content=re.sub(r'<!-- SHELDON_RESULTS_EXIT_V2 -->\s*<script>.*?</script>\s*','',content,flags=re.S)
 if '</body>' not in content: sys.exit(f'Missing body tag in {p}')
 files[p]=content.replace('</body>',(SOURCE/'results_exit_script.html').read_text()+'\n</body>',1)
# Backup all changed, then update
for p,c in files.items():
 if p.read_text(encoding='utf-8')!=c:
  shutil.copy2(p,p.with_name(p.name+'.pre-secure-v2.bak'))
  p.write_text(c,encoding='utf-8')
  print('Updated',p.relative_to(ROOT))
 else: print('Already updated',p.relative_to(ROOT))
print('Complete. Restart app / deploy. No layout or database modifications.')
