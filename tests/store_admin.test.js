'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'pc-admin-test-'));
fs.copyFileSync(path.join(__dirname,'../cosmetics.js'),path.join(folder,'cosmetics.js'));
fs.copyFileSync(path.join(__dirname,'../gems.js'),path.join(folder,'gems.js'));
const cosmetics=require(path.join(folder,'cosmetics.js'));
const gems=require(path.join(folder,'gems.js'));
class TestDb extends DatabaseSync {
  transaction(fn) {
    const run=()=>{
      this.exec('BEGIN IMMEDIATE');
      try {const out=fn();this.exec('COMMIT');return out;}
      catch(err){this.exec('ROLLBACK');throw err;}
    };
    run.immediate=run;
    return run;
  }
}
function setup(location=':memory:') {
  const db=new TestDb(location);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL,is_admin INTEGER NOT NULL DEFAULT 0)');
  for(const [id,name,admin] of [[1,'admin',1],[2,'member',0],[3,'member2',0]]) db.prepare('INSERT OR IGNORE INTO users(id,username,is_admin) VALUES (?,?,?)').run(id,name,admin);
  return db;
}
function wallet(db,uid,balance=100_000) {
  gems.balance(db,uid);
  db.prepare('UPDATE pb_betting_wallets SET balance=? WHERE user_id=?').run(balance,uid);
}
function req(uid,body={}) {
  return {session:{uid,cosmeticsCsrf:'a'.repeat(64)},body,query:{},get(key){return ({host:'www.pressboxd.com',origin:'https://www.pressboxd.com'})[key]||'';}};
}
function mockApp(){
  const handlers={};
  return {handlers,get(route,...fns){handlers['GET '+route]=fns;},post(route,...fns){handlers['POST '+route]=fns;}};
}
function res() {
  return {locals:{me:{username:'admin',is_admin:1}},statusCode:200,headers:{},status(n){this.statusCode=n;return this;},send(body){this.sent=body;return this;},redirect(url){this.redirected=url;return this;},set(h,v){this.headers[h]=v;return this;},render(view,data){this.view=view;this.data=data;return this;}};
}
function dispatch(fns,request,response) {
  for(const fn of fns){
    let more=false;
    fn(request,response,error=>{if(error)throw error;more=true;});
    if(!more)break;
  }
  return response;
}
test('all luxury cosmetics are present; retired backgrounds remain absent',()=>{
  assert.equal(cosmetics.CATALOG.length,64);
  assert.equal(cosmetics.CATEGORIES.includes('background'),false);
  assert.ok(cosmetics.ITEMS.has('frame_divine'));
  assert.ok(cosmetics.ITEMS.has('name_omnichrome'));
});
test('admin change updates only chosen item, no wallet, inventory, or old price lost',()=>{
  const db=setup();try{
    wallet(db,2,200000);
    cosmetics.buy(db,2,'frame_sapphire');
    const before=db.prepare("SELECT price_paid FROM pb_cosmetics_inventory WHERE user_id=2 AND item_id='frame_sapphire'").get().price_paid;
    const balance=gems.balance(db,2);
    cosmetics.changePrice(db,1,'frame_sapphire','3555');
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_sapphire').price,3555);
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_rose').price,1000);
    assert.equal(db.prepare("SELECT price_paid FROM pb_cosmetics_inventory WHERE user_id=2 AND item_id='frame_sapphire'").get().price_paid,before);
    assert.equal(gems.balance(db,2),balance);
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_sapphire').defaultPrice,1000);
  }finally{db.close()}
});
test('buyer pays the DB override, not source CATALOG price',()=>{
  const db=setup();try{
    cosmetics.changePrice(db,1,'frame_rose',4375);
    wallet(db,2,10000);
    const r=cosmetics.buy(db,2,'frame_rose');
    assert.equal(r.item.price,4375);
    assert.equal(r.balance,5625);
    assert.equal(db.prepare("SELECT price_paid FROM pb_cosmetics_inventory WHERE user_id=2 AND item_id='frame_rose'").get().price_paid,4375);
    assert.equal(db.prepare("SELECT delta FROM pb_betting_ledger WHERE user_id=2").get().delta,-4375);
  }finally{db.close()}
});
test('free price is allowed and purchase leaves existing Gems untouched',()=>{
  const db=setup();try{
    wallet(db,2,200);
    cosmetics.changePrice(db,1,'frame_prism',0);
    assert.equal(cosmetics.buy(db,2,'frame_prism').balance,200);
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_prism').price,0);
  }finally{db.close()}
});
test('only active DB admins can modify prices, even if session claims otherwise',()=>{
  const db=setup();try{
    assert.throws(()=>cosmetics.changePrice(db,2,'frame_sapphire',0),/Administrator/);
    db.prepare('UPDATE users SET is_admin=0 WHERE id=1').run();
    assert.throws(()=>cosmetics.changePrice(db,1,'frame_sapphire',0),/Administrator/);
    assert.equal(cosmetics.getCatalog(db)[0].price,1000);
  }finally{db.close()}
});
test('invalid prices and fake item IDs fail safely',()=>{
  const db=setup();try{
    for(const input of ['-1','4.5','1e6','Infinity','1000000001','abc','']) assert.throws(()=>cosmetics.changePrice(db,1,'frame_sapphire',input),/Gem price|whole-number|Price/);
    assert.throws(()=>cosmetics.changePrice(db,1,'frame_not_real',100),/Unknown cosmetic/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pb_cosmetics_price_overrides').get().n,0);
  }finally{db.close()}
});
test('reset restores catalog price and audit logs old and new prices',()=>{
  const db=setup();try{
    cosmetics.changePrice(db,1,'frame_sapphire',20000);
    const r=cosmetics.changePrice(db,1,'frame_sapphire',null,true);
    assert.equal(r.newPrice,1000);
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_sapphire').price,1000);
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_sapphire').isOverridden,false);
    const history=cosmetics.priceHistory(db);
    assert.deepEqual(history.map(x=>x.operation),['reset','set']);
    assert.deepEqual(history.map(x=>x.new_price),[1000,20000]);
    assert.equal(history[0].admin_name,'admin');
  }finally{db.close()}
});
test('override survives database reopen / redeploy',()=>{
  const loc=path.join(folder,'persist.db');
  let db=setup(loc);
  cosmetics.changePrice(db,1,'name_omnichrome',777777);
  db.close();
  db=setup(loc);
  assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='name_omnichrome').price,777777);
  db.close();
});
test('public store sends dynamically priced catalog to template',()=>{
  const db=setup();
  cosmetics.changePrice(db,1,'motion_float',8765);
  const app=mockApp();
  cosmetics.mount(app,()=>db);
  // database stays open via a close shim for route simulation
  db.close=()=>{};
  const reply=dispatch(app.handlers['GET /store'],req(2),res());
  assert.equal(reply.view,'cosmetics_store');
  assert.equal(reply.data.catalog.find(x=>x.id==='motion_float').price,8765);
});
test('only admin sessions can access price manager route',()=>{
  const db=setup();
  const app=mockApp();
  cosmetics.mount(app,()=>db);
  db.close=()=>{};
  assert.equal(dispatch(app.handlers['GET /store/admin'],req(2),res()).statusCode,403);
  assert.equal(dispatch(app.handlers['GET /store/admin'],req(null),res()).redirected,'/login?next=%2Fstore%2Fadmin');
  const reply=dispatch(app.handlers['GET /store/admin'],req(1),res());
  assert.equal(reply.view,'cosmetics_admin');
  assert.equal(reply.data.catalog.length,64);
  assert.equal(reply.data.csrf.length,64);
});
test('admin POST requires valid CSRF, and never trusts provided item price after submission',()=>{
  const db=setup();
  const app=mockApp();
  cosmetics.mount(app,()=>db);
  db.close=()=>{};
  const token='a'.repeat(64);
  let request=req(1,{csrf:'wrong',item_id:'frame_rose',price:'12000'});
  assert.equal(dispatch(app.handlers['POST /store/admin/price'],request,res()).statusCode,403);
  request=req(1,{csrf:token,item_id:'frame_rose',price:'12000'});
  const result=dispatch(app.handlers['POST /store/admin/price'],request,res());
  assert.match(result.redirected,/^\/store\/admin\?ok=/);
  assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_rose').price,12000);
  const nonAdmin=dispatch(app.handlers['POST /store/admin/price'],req(2,{csrf:token,item_id:'frame_rose',price:'1'}),res());
  assert.equal(nonAdmin.statusCode,403);
  assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_rose').price,12000);
});

test('names and rarities are updated in catalog, but IDs, category and CSS effect identifiers never change',()=>{
  const db=setup();try{
    const original=cosmetics.CATALOG.find(x=>x.id==='frame_rose');
    const changed=cosmetics.changeMetadata(db,1,'frame_rose','  Rose Diamond  ','Celestial');
    assert.equal(changed.newName,'Rose Diamond');
    const shown=cosmetics.getCatalog(db).find(x=>x.id==='frame_rose');
    assert.equal(shown.id,original.id);
    assert.equal(shown.category,original.category);
    assert.equal(shown.name,'Rose Diamond');
    assert.equal(shown.rarity,'Celestial');
    assert.equal(shown.defaultName,'Rose Quartz');
    assert.equal(shown.defaultRarity,'Common');
    assert.equal(shown.metadataOverridden,true);
    assert.equal(original.name,'Rose Quartz');
    assert.equal(original.rarity,'Common');
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_sapphire').name,'Sapphire Glow');
  }finally{db.close()}
});

test('changing cosmetics display properties never alters Gems, paid purchases, ownership or equipped effects',()=>{
  const db=setup();try{
    wallet(db,2,200000);
    cosmetics.buy(db,2,'frame_rose');
    const previousPaid=db.prepare("SELECT price_paid FROM pb_cosmetics_inventory WHERE user_id=2 AND item_id='frame_rose'").get().price_paid;
    const balance=gems.balance(db,2);
    cosmetics.changeMetadata(db,1,'frame_rose','Rose Diamond','Epic');
    assert.equal(gems.balance(db,2),balance);
    assert.equal(db.prepare("SELECT price_paid FROM pb_cosmetics_inventory WHERE user_id=2 AND item_id='frame_rose'").get().price_paid,previousPaid);
    assert.equal(cosmetics.owns(db,2,'frame_rose'),true);
    assert.equal(cosmetics.getEquipped(db,2).frame,'frame_rose');
    cosmetics.changePrice(db,1,'frame_rose',12345);
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_rose').name,'Rose Diamond');
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_rose').price,12345);
  }finally{db.close()}
});

test('new buyers see the edited item name but pay overridden DB price',()=>{
  const db=setup();try{
    cosmetics.changeMetadata(db,1,'frame_rose','Pink Stardust','Mythic');
    cosmetics.changePrice(db,1,'frame_rose',7500);
    wallet(db,2,10000);
    const result=cosmetics.buy(db,2,'frame_rose');
    assert.equal(result.item.name,'Pink Stardust');
    assert.equal(result.item.rarity,'Mythic');
    assert.equal(result.item.price,7500);
    assert.equal(result.balance,2500);
  }finally{db.close()}
});

test('only database-confirmed admins may edit name or rarity',()=>{
  const db=setup();try{
    assert.throws(()=>cosmetics.changeMetadata(db,2,'frame_rose','Stolen Name','Epic'),/Administrator/);
    db.prepare('UPDATE users SET is_admin=0 WHERE id=1').run();
    assert.throws(()=>cosmetics.changeMetadata(db,1,'frame_rose','Stolen Name','Epic'),/Administrator/);
    assert.equal(cosmetics.getCatalog(db).find(x=>x.id==='frame_rose').name,'Rose Quartz');
  }finally{db.close()}
});

test('metadata validation rejects fake IDs, unsupported rarities, overlong or control names',()=>{
  const db=setup();try{
    for(const name of ['', '   ', 'a'.repeat(81), 'bad\nname', 'x\0y']) {
      assert.throws(()=>cosmetics.changeMetadata(db,1,'frame_rose',name,'Epic'),/name|characters/);
    }
    assert.throws(()=>cosmetics.changeMetadata(db,1,'frame_rose','OK','UnrecognizedTier'),/rarity/);
    assert.throws(()=>cosmetics.changeMetadata(db,1,'frame_not_real','OK','Epic'),/Unknown cosmetic/);
    assert.equal(db.prepare('SELECT count(*) n FROM pb_cosmetics_metadata_overrides').get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM pb_cosmetics_metadata_audit').get().n,0);
  }finally{db.close()}
});

test('metadata reset restores original name and rarity, audits changes, and preserves custom price',()=>{
  const db=setup();try{
    cosmetics.changePrice(db,1,'frame_rose',9876);
    cosmetics.changeMetadata(db,1,'frame_rose','Rose Deluxe','Celestial');
    const result=cosmetics.changeMetadata(db,1,'frame_rose',null,null,true);
    assert.equal(result.newName,'Rose Quartz');
    assert.equal(result.newRarity,'Common');
    const shown=cosmetics.getCatalog(db).find(x=>x.id==='frame_rose');
    assert.equal(shown.name,'Rose Quartz');
    assert.equal(shown.rarity,'Common');
    assert.equal(shown.price,9876);
    assert.equal(shown.metadataOverridden,false);
    assert.equal(cosmetics.metadataHistory(db)[0].operation,'reset');
    assert.equal(cosmetics.metadataHistory(db)[0].admin_name,'admin');
  }finally{db.close()}
});

test('metadata overrides persist across DB restarts / redeploys',()=>{
  const dbPath=path.join(folder,'persist-metadata.db');
  let db=setup(dbPath);
  cosmetics.changeMetadata(db,1,'frame_sapphire','Ultramarine','Mythic');
  db.close();
  db=setup(dbPath);
  const row=cosmetics.getCatalog(db).find(x=>x.id==='frame_sapphire');
  assert.equal(row.name,'Ultramarine');
  assert.equal(row.rarity,'Mythic');
  db.close();
});

test('admin POST name/rarity route requires CSRF and ownership permissions',()=>{
  const db=setup();const app=mockApp();
  cosmetics.mount(app,()=>db);db.close=()=>{};
  const valid='a'.repeat(64);
  const blocked=dispatch(app.handlers['POST /store/admin/metadata'],req(1,{csrf:'bad',item_id:'frame_rose',name:'Malicious',rarity:'Epic'}),res());
  assert.equal(blocked.statusCode,403);
  const forbidden=dispatch(app.handlers['POST /store/admin/metadata'],req(2,{csrf:valid,item_id:'frame_rose',name:'Malicious',rarity:'Epic'}),res());
  assert.equal(forbidden.statusCode,403);
  const okay=dispatch(app.handlers['POST /store/admin/metadata'],req(1,{csrf:valid,item_id:'frame_rose',name:'Rose Royale',rarity:'Legendary'}),res());
  assert.match(okay.redirected,/^\/store\/admin\?ok=/);
  const store=dispatch(app.handlers['GET /store'],req(2),res());
  const inventory=dispatch(app.handlers['GET /me/cosmetics'],req(2),res());
  assert.equal(store.data.catalog.find(x=>x.id==='frame_rose').name,'Rose Royale');
  assert.equal(inventory.data.catalog.find(x=>x.id==='frame_rose').rarity,'Legendary');
  assert.ok(dispatch(app.handlers['GET /store/admin'],req(1),res()).data.rarities.includes('Celestial'));
});
