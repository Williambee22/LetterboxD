from pathlib import Path
import re,sys
root=Path(sys.argv[1]).expanduser().resolve() if len(sys.argv)>1 else Path.cwd()
cos=root/'cosmetics.js'; store=root/'templates'/'cosmetics_store.ejs'; css=root/'static'/'cosmetics.css'
for p in [cos,store,css]:
    if not p.exists():raise SystemExit('Missing '+str(p)+'; run from Pressboxd root or supply project path.')
orig={p:p.read_text(encoding='utf-8') for p in [cos,store,css]}
s=orig[cos]
if not re.search(r'id\s*:\s*[\'"]frame_oatmeal[\'"]',s):
    raise SystemExit('Oatmeal is not yet installed in cosmetics.js; install Oatmeal and Crown sequence first.')
# Restore the item to the shop listing so a mystery card is visible.
s=s.replace("catalog:view === 'cosmetics_store' ? getCatalog(db).filter(item => item.id !== 'frame_oatmeal') : getCatalog(db),","catalog:getCatalog(db),")
s=s.replace("catalog:view === 'cosmetics_store' ? CATALOG.filter(item => item.id !== 'frame_oatmeal') : CATALOG,","catalog:CATALOG,")
# Server-side prevention of the free item being purchased directly.
if '/* OATMEAL_MYSTERY_BUY_BLOCK */' not in s:
    match=re.search(r'(function buy\s*\(\s*db\s*,\s*userId\s*,\s*itemId\s*\)\s*\{)',s)
    if not match:raise SystemExit('Cannot find buy() in cosmetics.js; no files changed.')
    s=s[:match.end()]+"\n  /* OATMEAL_MYSTERY_BUY_BLOCK */\n  if (String(itemId) === 'frame_oatmeal') throw new Error('Unlocked after finding a secret.');\n"+s[match.end():]
# Prevent catalog admin edits from changing real award behavior? no.
t=orig[store]
if 'OATMEAL_MYSTERY_STORE' not in t:
    # The known rendering template has card image, heading, description and price.
    if '<%= item.name %>' not in t or '<%= item.description %>' not in t:
        raise SystemExit('Unknown store template; cannot locate item name/description. No files changed.')
    t=t.replace('<%= item.name %>', "<%= item.id==='frame_oatmeal' && !isOwned ? 'Secret Avatar Frame' : item.name %>")
    t=t.replace('<%= item.description %>', "<%= item.id==='frame_oatmeal' && !isOwned ? 'Unlocked after finding a secret.' : item.description %>")
    # Insert ? centered in existing avatar circle, hiding the ordinary image.
    img='<img src="/static/logo.png" alt="">'
    if img not in t:raise SystemExit('Cannot find the store avatar preview image. No files changed.')
    t=t.replace(img,"<% if(item.id==='frame_oatmeal' && !isOwned){ %><span class=\"pc-oatmeal-question\" aria-label=\"Secret avatar frame\">?</span><% }else{ %>"+img+"<% } %>",1) if False else t
    # Use match inside the frame/motion/unlock preview specifically, not hero image.
    m=re.search(r'(<div class="pc-preview-avatar [^\n]*?<img src="/static/logo.png" alt="">)(</div>)',t)
    if not m:raise SystemExit('Cannot find individual item preview. No files changed.')
    replacement=m.group(1).replace(img,"<% if(item.id==='frame_oatmeal' && !isOwned){ %><span class=\"pc-oatmeal-question\" aria-label=\"Secret avatar frame\">?</span><% } else { %>"+img+"<% } %>")+m.group(2)
    t=t[:m.start()]+replacement+t[m.end():]
    # Locked card cannot be bought, shows discovery clue in the existing buy row.
    if '<% if(isEquipped){ %>' not in t:raise SystemExit('Could not find purchase button conditions. No files changed.')
    t=t.replace('<% if(isEquipped){ %>',"<% if(item.id==='frame_oatmeal' && !isOwned){ %><span class=\"pc2-owned\">???</span><% } else if(isEquipped){ %>",1)
    t=t.replace('<span class="pc2-price">💎 <%= item.price.toLocaleString() %></span>', '<span class="pc2-price"><%= item.id===\'frame_oatmeal\' && !isOwned ? \"SECRET\" : \"💎 \"+item.price.toLocaleString() %></span>',1)
    t=t.replace('</body>','<!-- OATMEAL_MYSTERY_STORE -->\n</body>',1)
c=orig[css]
if '/* OATMEAL_MYSTERY_ICON */' not in c:
    c+='\n/* OATMEAL_MYSTERY_ICON */\n.pc-oatmeal-question{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:#222127;color:#e7e7ed;font-weight:900;font-size:clamp(28px,4vw,53px);line-height:1;font-family:system-ui,sans-serif;}\n.pc2-product-art.pc-item-frame_oatmeal:has(.pc-oatmeal-question) .pc-preview-avatar::before{background:conic-gradient(#86868e,#33343a,#86868e);box-shadow:none;}\n'
for p,contents in [(cos,s),(store,t),(css,c)]:
    if contents==orig[p]:print('No change:',p.relative_to(root));continue
    b=p.with_name(p.name+'.before-oatmeal-mystery.bak')
    if not b.exists():b.write_text(orig[p],encoding='utf-8')
    p.write_text(contents,encoding='utf-8')
    print('Updated:',p.relative_to(root))
print('Locked Oatmeal is now shown as Secret Avatar Frame; owned users see Oatmeal normally.')
