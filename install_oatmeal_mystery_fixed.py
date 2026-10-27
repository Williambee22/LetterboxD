from pathlib import Path
import sys,re
root=Path(sys.argv[1]).expanduser().resolve() if len(sys.argv)>1 else Path.cwd()
cos=root/'cosmetics.js'; store=root/'templates/cosmetics_store.ejs'; css=root/'static/cosmetics.css'
for p in (cos,store,css):
    if not p.is_file(): raise SystemExit('Missing '+str(p)+' (run from repository root)')
orig={p:p.read_text(encoding='utf-8') for p in (cos,store,css)}
s=orig[cos]
if not re.search(r"(?:['\"]id['\"]|\bid)\s*:\s*['\"]frame_oatmeal['\"]",s):
    anchor='const CATALOG = Object.freeze(['
    if anchor not in s: raise SystemExit('Cannot find CATALOG in cosmetics.js. Nothing changed.')
    s=s.replace(anchor,anchor+"\n  { id:'frame_oatmeal', category:'frame', name:'Oatmeal', price:0, rarity:'Secret', description:'An exclusive warm oat-and-cinnamon avatar frame, earned through a hidden ritual.' },",1)
# Remove both past versions of the hidden-store filter; preserve dynamic DB-backed catalog.
s=re.sub(r"catalog\s*:\s*view\s*===\s*['\"]cosmetics_store['\"]\s*\?\s*(getCatalog\(db\)|CATALOG)\.filter\(item\s*=>\s*item\.id\s*!==\s*['\"]frame_oatmeal['\"]\)\s*:\s*\1\s*,", lambda m:'catalog:'+m.group(1)+',', s)
# Block buying free unlock; neither the catalog price nor a crafted POST can purchase it.
if '/* OATMEAL_MYSTERY_BUY_BLOCK */' not in s:
    m=re.search(r'function\s+buy\s*\(\s*db\s*,\s*userId\s*,\s*itemId\s*\)\s*\{',s)
    if not m: raise SystemExit('Missing buy() in cosmetics.js. Nothing changed.')
    s=s[:m.end()]+"\n  /* OATMEAL_MYSTERY_BUY_BLOCK */\n  if (String(itemId) === 'frame_oatmeal') throw new Error('Unlocked after finding a secret.');\n"+s[m.end():]
t=orig[store]
if 'OATMEAL_MYSTERY_V2' not in t:
    required=['const isOwned=owned_ids.has(item.id)','<%= item.name %>','<%= item.description %>','<% if(isEquipped){ %>']
    if not all(v in t for v in required): raise SystemExit('Unrecognized store template; nothing changed.')
    t=t.replace('const isEquipped=equipped[cat]===item.id;',"const isEquipped=equipped[cat]===item.id; const lockedOatmeal=item.id==='frame_oatmeal' && !isOwned;",1)
    # Only per-item preview, leave the intro/hero logo untouched.
    needle='<div class="pc-preview-avatar <%= cat===\'frame\'?\'pc-\'+item.id:cat===\'motion\'?\'pc-\'+item.id:\'pc-frame-prism\' %>"><img src="/static/logo.png" alt=""></div>'
    if needle not in t: raise SystemExit('Cannot locate frame preview in store. Nothing changed.')
    t=t.replace(needle,needle.replace('<img src="/static/logo.png" alt="">','<% if(lockedOatmeal){ %><span class="pc-oatmeal-question" aria-label="Secret avatar frame">?</span><% } else { %><img src="/static/logo.png" alt=""><% } %>'),1)
    t=t.replace('<%= item.name %>',"<%= lockedOatmeal ? 'Secret Avatar Frame' : item.name %>",1)
    t=t.replace('<%= item.description %>',"<%= lockedOatmeal ? 'Unlocked after finding a secret.' : item.description %>",1)
    t=t.replace('<span class="pc2-price">💎 <%= item.price.toLocaleString() %></span>', '<span class="pc2-price"><%= lockedOatmeal ? "SECRET" : "💎 " + item.price.toLocaleString() %></span>',1)
    t=t.replace('<% if(isEquipped){ %>', '<% if(lockedOatmeal){ %><span class="pc2-owned">???</span><% } else if(isEquipped){ %>',1)
    t=t.replace('</body>','<!-- OATMEAL_MYSTERY_V2 -->\n</body>',1)
c=orig[css]
if '/* OATMEAL_MYSTERY_ICON_V2 */' not in c:
    c+='\n/* OATMEAL_MYSTERY_ICON_V2 */\n.pc-oatmeal-question{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:#23232a;color:#ececf2;font-weight:900;font-size:clamp(28px,4vw,53px);line-height:1;font-family:system-ui,sans-serif;}\n.pc-item-frame_oatmeal:has(.pc-oatmeal-question) .pc-preview-avatar::before{background:conic-gradient(#888891,#33343c,#888891);box-shadow:none;}\n'
for p,v in ((cos,s),(store,t),(css,c)):
    if v==orig[p]: print('Already current:',p.relative_to(root));continue
    backup=p.with_name(p.name+'.before-oatmeal-mystery-v2.bak')
    if not backup.exists():backup.write_text(orig[p],encoding='utf-8')
    p.write_text(v,encoding='utf-8');print('UPDATED:',p.relative_to(root))
print('Done: locked frame is Secret Avatar Frame, ? logo and description. Unlock sequence routes are separate.')
