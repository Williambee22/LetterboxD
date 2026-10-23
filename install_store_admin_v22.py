#!/usr/bin/env python3
"""Add name and rarity editing to an existing Pressboxd v21 Store Admin.

Surgically edits cosmetics.js without modifying the item's static CATALOG,
original default prices, or anything under static/. Preserves existing
SQLite data, custom avatar frames and all other features. Saves backups.
"""
from datetime import datetime
from pathlib import Path
import sys, shutil

ROOT=Path(__file__).resolve().parent
ASSETS=ROOT/'admin_v22_assets'
CODE=ROOT/'cosmetics.js'
PAGE=ROOT/'templates'/'cosmetics_admin.ejs'


def section(source, left, right):
    start=source.find(left)
    if start < 0: raise ValueError('Missing section: '+left[:70])
    end=source.find(right,start+len(left))
    if end < 0: raise ValueError('Missing end of section: '+right[:70])
    return source[start:end]


def patch(source, old, new, label):
    count=source.count(old)
    if count != 1:
        raise ValueError(f'Safe patch refused ({label}): expected one matching code section; found {count}. No files changed.')
    return source.replace(old,new,1)


def prepare():
    for path in [CODE, PAGE, ASSETS/'base_v21_cosmetics.js',ASSETS/'updated_v22_cosmetics.js',ASSETS/'cosmetics_admin.ejs']:
        if not path.is_file(): raise FileNotFoundError('Missing required file: '+str(path))
    current=CODE.read_text(encoding='utf-8')
    base=(ASSETS/'base_v21_cosmetics.js').read_text(encoding='utf-8')
    updated=(ASSETS/'updated_v22_cosmetics.js').read_text(encoding='utf-8')

    already=('function changeMetadata(db, adminId,' in current and
             "app.post('/store/admin/metadata'" in current and
             'function metadataHistory(db,' in current)
    if not already:
        if 'function changePrice(db, adminId,' not in current or "app.get('/store/admin'" not in current:
            raise ValueError('Install the v21 Store Admin first, then run this v22 installer.')
        if 'pb_cosmetics_metadata_overrides' in current:
            raise ValueError('This file contains an incomplete metadata integration. Refusing to overwrite your work.')

        # Keep CATALOG text *verbatim*, including manually adjusted prices and newly added items.
        current=patch(current,
            'const MAX_PRICE = 1_000_000_000; // Maximum allowed price in virtual Gems.',
            "const MAX_PRICE = 1_000_000_000; // Maximum allowed price in virtual Gems.\nconst RARITIES = Object.freeze([...new Set(CATALOG.map(item => item.rarity))]);",
            'rarity list')
        start='    CREATE TABLE IF NOT EXISTS pb_cosmetics_metadata_overrides ('
        sql=section(updated,start,'\n  `);')
        end='    CREATE INDEX IF NOT EXISTS idx_pb_cosmetics_price_audit_recent\n      ON pb_cosmetics_price_audit(changed_ts DESC, id DESC);'
        current=patch(current,end,end+'\n'+sql.rstrip(),'database tables')
        left='function getCatalog(db) {'
        right='function priceHistory(db, limit=25) {'
        current=patch(current,section(base,left,right),section(updated,left,right),'dynamic catalog')
        insert_before='// Admin permissions are verified against the current database row, not a'
        history=section(updated,'// Separate audit log of all catalog name / rarity edits.\n',insert_before)
        current=patch(current,insert_before,history+insert_before,'metadata audit function')
        before='function owns(db, userId, itemId) {'
        helper=section(updated,'// Change human-readable item properties only.',before)
        current=patch(current,before,helper+before,'metadata edit function')
        old_return='    return { item: {...item,price:currentPrice}, balance: gems.balance(db, uid) };'
        new_return=section(updated,"    const metadata=db.prepare('SELECT name,rarity FROM pb_cosmetics_metadata_overrides",'\n  });\n  return typeof tx.immediate')
        current=patch(current,old_return,new_return.rstrip(),'checkout display name')
        old_locals='        history:priceHistory(db,25),\n        csrf:csrfToken(req),'
        new_locals='        history:priceHistory(db,25),\n        metadataHistory:metadataHistory(db,25),\n        rarities:RARITIES,\n        csrf:csrfToken(req),'
        current=patch(current,old_locals,new_locals,'admin page locals')
        next_route="  app.get('/store',(req,res)=>page(req,res,'cosmetics_store'));"
        route=section(updated,"  app.post('/store/admin/metadata'",next_route)
        current=patch(current,next_route,route+next_route,'name rarity admin route')
        old_export='module.exports={CATALOG,ITEMS,CATEGORIES,MAX_PRICE,initialize,owns,inventory,getEquipped,getCatalog,priceHistory,isStoreAdmin,changePrice,buy,equip,mount};'
        new_export='module.exports={CATALOG,ITEMS,CATEGORIES,MAX_PRICE,RARITIES,initialize,owns,inventory,getEquipped,getCatalog,priceHistory,metadataHistory,isStoreAdmin,changePrice,changeMetadata,buy,equip,mount};'
        current=patch(current,old_export,new_export,'module exports')

    target=ASSETS.joinpath('cosmetics_admin.ejs').read_text(encoding='utf-8')
    return {CODE:current,PAGE:target}


def main():
    changed={p:value for p,value in prepare().items() if not p.exists() or p.read_text(encoding='utf-8')!=value}
    if not changed:
        print('v22 already installed; no files changed.')
        return
    folder=ROOT/'cosmetics_backups'/('store_admin_v22_'+datetime.now().strftime('%Y%m%d_%H%M%S_%f'))
    for p in changed:
        if p.exists():
            backup=folder/p.relative_to(ROOT)
            backup.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(p,backup)
    for p,value in changed.items():
        tmp=p.with_name(p.name+'.storeadmin-v22.tmp')
        tmp.write_text(value,encoding='utf-8')
        tmp.replace(p)
        print('Updated:',p.relative_to(ROOT))
    print('Done! Redeploy, then visit /store/admin as an administrator.')
    print('Backups:',folder.relative_to(ROOT))
    print('No CSS files, CATALOG entries, wallet balances, or owned cosmetics changed.')


if __name__=='__main__':
    try:main()
    except Exception as err:
        print('Install stopped:',err,file=sys.stderr)
        sys.exit(1)
