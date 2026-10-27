from pathlib import Path
import re,sys
root=Path(sys.argv[1]).expanduser().resolve() if len(sys.argv)>1 else Path.cwd()
cos=root/'cosmetics.js'
templates=root/'templates'
paths={'shows':templates/'shows.ejs','detail':templates/'show_detail.ejs','critics':templates/'show_critics.ejs','profile':templates/'profile.ejs'}
missing=[str(p) for p in [cos,*paths.values()] if not p.exists()]
if missing:raise SystemExit('Missing files; nothing changed:\n'+'\n'.join(missing))
source={p:p.read_text(encoding='utf-8') for p in [cos,*paths.values()]}
# Preserve the existing catalog and cosmetic graphics; install Oatmeal only if missing.
s=source[cos]
if not re.search(r"id\s*:\s*['\"]frame_oatmeal['\"]",s):
    marker='const CATALOG = Object.freeze(['
    if marker not in s:raise SystemExit('Unknown cosmetics catalog structure, no changes made')
    s=s.replace(marker,marker+"\n  { id:'frame_oatmeal', category:'frame', name:'Oatmeal', price:0, rarity:'Secret', description:'A hidden Crown 2002 achievement frame.' },",1)
# Remove previous oatmeal server endpoints, including old OATMEAL/BOWL grant endpoints.
s=re.sub(r'  /\* OATMEAL_SECRET_ROUTES \*/.*?(?=\n  (?:const |function |app\.|return |//)|\n\})','',s, count=0,flags=re.S) if False else s
old_start=s.find('  /* OATMEAL_SECRET_ROUTES */')
if old_start!=-1:
    old_end=s.find("\n  function page(",old_start)
    if old_end==-1: old_end=s.find("\n  const page",old_start)
    if old_end==-1: old_end=s.find("\n  app.get('/store",old_start)
    if old_end==-1: raise SystemExit('Could not bound old Oatmeal routes; nothing changed')
    s=s[:old_start]+s[old_end:]
# Re-running safe.
begin='  /* OATMEAL_CROWN_SECRET_ROUTES_START */'
end='  /* OATMEAL_CROWN_SECRET_ROUTES_END */'
if begin in s:
    s=s[:s.index(begin)] + s[s.index(end)+len(end):]
anchor='function mount(app, getConn) {'
if anchor not in s:raise SystemExit('Cosmetics mount not found; nothing changed')
route=(Path(__file__).with_name('oatmeal_routes.js.txt')).read_text()
s=s.replace(anchor,anchor+'\n'+route,1)
# Older installer hidden item from normal store; if absent, hide it in store only, not inventory.
if "id !== 'frame_oatmeal'" not in s and 'id !== "frame_oatmeal"' not in s:
    s=s.replace('catalog:getCatalog(db),',"catalog:view === 'cosmetics_store' ? getCatalog(db).filter(item => item.id !== 'frame_oatmeal') : getCatalog(db),",1)
    s=s.replace('catalog:CATALOG,',"catalog:view === 'cosmetics_store' ? CATALOG.filter(item => item.id !== 'frame_oatmeal') : CATALOG,",1)
source[cos]=s
for key,p in paths.items():
    content=source[p]
    # versioned replace avoids duplicates
    content=re.sub(r'\s*<script data-oatmeal-crown="[^\"]*">.*?</script>', '', content, flags=re.S)
    if '</body>' not in content:raise SystemExit(f'No closing body in {p}; nothing changed')
    script=(Path(__file__).with_name('oatmeal_'+key+'.html')).read_text()
    content=content.replace('</body>',script+'\n</body>',1)
    source[p]=content
# Remove obsolete scripts from prior OATMEAL/BOWL installer.
for key in ('shows','detail','critics','profile'):
    pass
for name in ('cosmetics_store.ejs','cosmetics_inventory.ejs'):
    p=templates/name
    if p.exists():
        t=p.read_text(encoding='utf-8')
        t=re.sub(r'\s*<script[^>]*>\s*/\* OATMEAL_SECRET_[\s\S]*?</script>', '',t)
        # Old version may have marker in inline script without leading comment
        t=re.sub(r'\s*<script>\s*\(\(\)\s*=>\s*\{[\s\S]*?__oatmeal/(?:prepare|claim)[\s\S]*?</script>', '',t)
        if t!=p.read_text(encoding='utf-8'):source[p]=t
# Important: backup originals then write.
for p,content in source.items():
    original=p.read_text(encoding='utf-8')
    if original==content:continue
    backup=p.with_name(p.name+'.before-oatmeal-crown.bak')
    if not backup.exists():backup.write_text(original,encoding='utf-8')
    p.write_text(content,encoding='utf-8')
    print('UPDATED',p.relative_to(root))
print('Oatmeal puzzle: Shows Crown 2002 -> View Critic Rating -> your avatar -> footer text x4')
