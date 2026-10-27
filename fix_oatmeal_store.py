from pathlib import Path
import re,sys
root=Path(sys.argv[1]).expanduser().resolve() if len(sys.argv)>1 else Path.cwd()
store=root/'templates'/'cosmetics_store.ejs';cos=root/'cosmetics.js'
for p in (store,cos):
 if not p.is_file():sys.exit(f'MISSING {p}\nRun this script from your Pressboxd root folder (beside app.js).')
s=store.read_text(encoding='utf8');c=cos.read_text(encoding='utf8')
if 'OATMEAL_ALWAYS_VISIBLE_V3' in s:
 print('Already installed in store template. Verify Git commit/deploy and clear cache.');sys.exit(0)
# Ensure actual inventory frame exists for permanent unlock/equip
if not re.search(r'\bid\s*:\s*[\'\"]frame_oatmeal[\'\"]',c):
 m=re.search(r'const\s+CATALOG\s*=\s*Object\.freeze\(\[',c)
 if not m:sys.exit('Cannot locate catalog; no files changed.')
 c=c[:m.end()]+"\n  { id:'frame_oatmeal', category:'frame', name:'Oatmeal', price:0, rarity:'Secret', description:'An exclusive warm oat-and-cinnamon frame, found through a hidden sequence.' },"+c[m.end():]
# Store must include frame section and existing product list
needle='<div class="pc2-product-grid">'
if needle not in s or 'catalog.filter(it=>it.category===cat)' not in s:
 sys.exit('Unexpected store markup. No files changed. Please send templates/cosmetics_store.ejs.')
# Hide Oatmeal from ordinary catalog loop while locked so it cannot duplicate mystery card.
s=s.replace('for(const item of catalog.filter(it=>it.category===cat))',"for(const item of catalog.filter(it=>it.category===cat && !(it.id==='frame_oatmeal' && !owned_ids.has('frame_oatmeal'))))")
# Inject guarantee, independent of catalog item rendering, in frame section.
insert='''<% /* OATMEAL_ALWAYS_VISIBLE_V3: secret card, always visible until owned */ %>
              <% if(cat==='frame' && !owned_ids.has('frame_oatmeal')){ %>
                <article class="pc2-product" data-secret-avatar-frame="oatmeal">
                  <div class="pc2-product-art pc-item-frame_oatmeal">
                    <div class="pc-preview-avatar" style="display:flex;align-items:center;justify-content:center;">
                      <span aria-label="Unknown avatar frame" style="display:flex;align-items:center;justify-content:center;position:relative;z-index:2;width:100%;height:100%;border-radius:50%;background:#25252b;color:#f0f0f3;font-size:52px;font-family:system-ui,sans-serif;font-weight:900;line-height:1;">?</span>
                    </div>
                    <span class="pc2-rarity">Secret</span>
                  </div>
                  <div class="pc2-product-info">
                    <h3>Secret Avatar Frame</h3>
                    <p>Unlocked after finding a secret.</p>
                    <div class="pc2-product-buy-row">
                      <span class="pc2-price">SECRET</span>
                      <span class="pc2-owned">???</span>
                    </div>
                  </div>
                </article>
              <% } %>
              '''
s=s.replace(needle,needle+'\n              '+insert,1)
# Add count if missing catalog item, optional: not necessary to change existing section header text.
for p,new in [(cos,c),(store,s)]:
 old=p.read_text(encoding='utf8')
 if old==new:
  print('UNCHANGED:',p.relative_to(root));continue
 backup=p.with_name(p.name+'.before-oatmeal-visible-v3.bak')
 if not backup.exists():backup.write_text(old,encoding='utf8')
 p.write_text(new,encoding='utf8');print('UPDATED:',p.relative_to(root))
print('DONE: locked Secret Avatar Frame appears in the Avatar Frames grid even if filtered out of catalog. Deploy these files.')
