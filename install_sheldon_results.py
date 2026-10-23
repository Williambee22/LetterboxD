"""Run once from the Pressboxd project root. Does not alter existing DB rows."""
from pathlib import Path
import shutil, datetime, re, json
root=Path.cwd(); assets=Path(__file__).resolve().parent
app=root/'app.js'; pkg=root/'package.json'
if not app.exists() or not pkg.exists():raise SystemExit('Run from your Pressboxd project root, next to app.js and package.json.')
source=app.read_text(encoding='utf-8'); anchor='    mountBetting(app, getConn);'
# Match irrespective of indentation and keep module registration inside createApp.
if 'sheldonResults.mount(app, getConn)' not in source:
 m=re.search(r'(?m)^([ \t]*)mountBetting\(app,\s*getConn\);',source)
 if not m:raise SystemExit('Could not find mountBetting(app, getConn) in app.js. No edits made.')
 anchor=m.group(0); source=source.replace(anchor,anchor+'\n'+m.group(1)+'sheldonResults.mount(app, getConn);',1)
if "require('./sheldon_results')" not in source:
 m=re.search(r"(?m)^const mountBetting\s*=\s*require\('./betting'\);",source)
 if not m:raise SystemExit('Could not find betting import in app.js. No edits made.')
 source=source.replace(m.group(0),m.group(0)+"\nconst sheldonResults = require('./sheldon_results');",1)
package=json.loads(pkg.read_text(encoding='utf-8'));package.setdefault('dependencies',{})['exceljs']='^4.4.0'
# Back up before touching existing source.
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy2(app, root/f'app.js.bak_sheldon_{stamp}')
shutil.copy2(pkg, root/f'package.json.bak_sheldon_{stamp}')
app.write_text(source,encoding='utf-8');pkg.write_text(json.dumps(package,indent=2)+'\n',encoding='utf-8')
if (assets/'sheldon_results.js').resolve() != (root/'sheldon_results.js').resolve():
 shutil.copy2(assets/'sheldon_results.js',root/'sheldon_results.js')
(root/'templates').mkdir(exist_ok=True)
for file in (assets/'templates').glob('sheldon_*.ejs'):
 destination=root/'templates'/file.name
 if file.resolve()!=destination.resolve(): shutil.copy2(file,destination)
print('Installed Sheldon Results routes and templates. NEXT: npm install, then node --check app.js, then deploy.')
