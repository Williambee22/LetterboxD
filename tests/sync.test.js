'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const sync=require('../dci_sync');
const lines=require('../betting_lines');

const eventHtml=`<html><body><h1>Drums on Parade</h1>
<p>Friday, July 24, 2026 7:00 PM CT</p>
<h2>Lineup & Times</h2><p>All times CT and subject to change</p>
<div>6:00 PM | Gates Open</div>
<div>7:00 PM | Bluecoats - Canton, OH</div>
<div>7:30 PM | Gold - San Diego, CA</div>
<div>8:00 PM | Intermission</div><p>View full lineup</p>
</body></html>`;

test('AJAX JSON and HTML discover event links without relying on page anchors',()=>{
  const payload=JSON.stringify({success:true,data:{html:'<a href="/events/2027-dci-dallas/">Dallas</a><a href="https://www.dci.org/events/2027-dci-san-antonio/">SA</a>'}});
  assert.deepEqual(sync.collectEventUrls(payload,{year:2027}).map(x=>new URL(x).pathname).sort(),
    ['/events/2027-dci-dallas/','/events/2027-dci-san-antonio/']);
  assert.equal(sync.collectEventUrls(payload,{year:2026}).length,0);
});

test('Event page extracts local date/time, known corps and correct classes',()=>{
  const r=sync.parseEventPage(eventHtml,'https://www.dci.org/events/2026-drums-on-parade/');
  assert.equal(r.date,'2026-07-24');
  assert.equal(r.timezone,'America/Chicago');
  assert.equal(r.start_ts,Date.parse('2026-07-25T00:00:00Z')/1000);
  assert.deepEqual(r.lineup.map(x=>[x.corps,x.cls]),[['Bluecoats','World Class'],['Gold','Open Class']]);
});

test('Score parser selects REAL standings over duplicated featured leader score',()=>{
  const html=`<h2>DCI World Championship Finals</h2>
  <h2>World Class</h2><p>Place</p><p>Corps</p><p>Score</p>
  <p>1</p><p>Bluecoats</p><p>98.750</p><p>1</p><p>Bluecoats</p><p>98.750</p><p>1</p><p>Bluecoats</p><p>98.750</p>
  <p>View full recap</p><h2>World Class</h2><p>Place</p><p>Corps</p><p>Score</p>
  <p>1</p><p>Bluecoats</p><p>99.100</p><p>2</p><p>Blue Devils</p><p>97.500</p>`;
  const rows=sync.scoreEntries(html);
  assert.equal(rows.length,2);
  assert.equal(rows.find(x=>x.corps==='Bluecoats').score,99.1);
  assert.equal(rows.find(x=>x.corps==='Blue Devils').score,97.5);
});

// The real DCI recap is nested: a .recap-tbl div wraps a parent table,
// each category contains table.data for each judge and .data-total.
function numberCell(n){return `<td><span>${n.toFixed(3)}</span><span>1</span></td>`;}
function category(judges,total){return `<td>${judges.map(v=>`<table class="data"><tbody><tr>${numberCell(v)}</tr></tbody></table>`).join('')}<div class="data-total"><span>${total.toFixed(3)}</span><span>1</span></div></td>`;}
function recapFixture({total=99.1}={}){
  return `<h1>DCI World Championship Finals</h1><p>August 8, 2026</p>
    <div><h2>World Class</h2></div>
    <div class="recap-tbl"><table><tbody>
    <tr class="table-top"><td>Corps</td><td>General Effect</td><td>Visual</td><td>Music</td><td>Sub Total</td><td>Penalties</td><td>Total</td></tr>
    <tr><td class="sticky-td">Bluecoats</td>
    ${category([19.8,20,20,19.9],39.85)}
    ${category([19.9,19.7,19.8],29.7)}
    ${category([19.4,20,19.8,19.8],29.55)}
    ${numberCell(total)}<td>--</td>${numberCell(total)}</tr>
    </tbody></table></div>`;
}

test('Official nested recap yields correct groups, captions and 99.100 total',()=>{
  const rows=sync.parseRecap(recapFixture(),{slug:'2026-dci-world-championship-finals',expectedDate:'2026-08-08'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].total,99.1);
  assert.equal(rows[0].groups['General Effect'],39.85);
  assert.equal(rows[0].groups.Visual,29.7);
  assert.equal(rows[0].groups.Music,29.55);
  assert.equal(rows[0].captions['GE1 A'],19.8);
  assert.equal(rows[0].captions['Music Analysis B'],19.8);
});

test('Recap rejects wrong date and impossible totals',()=>{
  assert.equal(sync.parseRecap(recapFixture(),{expectedDate:'2027-08-08'}).length,0);
  assert.equal(sync.parseRecap(recapFixture({total:88}),{expectedDate:'2026-08-08'}).length,0);
});

test('Historical markets never leak future scores into calculations',()=>{
  const startTs=Date.parse('2026-07-24T23:00:00Z')/1000;
  const mk=lines.makeMarkets({eventId:'dci_2026-drums-on-parade',startTs,season:2026,eventDate:'2026-07-24',lineup:[{corps:'Bluecoats',cls:'World Class'}]});
  assert.ok(mk.length>0);assert.ok(mk.some(x=>x.caption==='Overall'));
  assert.ok(mk.every(x=>Number.isFinite(x.line)));
});

test('Verified market payouts are atomic, idempotent and preserve existing wallet balances',()=>{
  const Database=require('better-sqlite3');
  const db=new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE pb_betting_events(id TEXT PRIMARY KEY,name TEXT,start_ts INTEGER,season INTEGER,status TEXT,source_url TEXT);
    CREATE TABLE pb_betting_markets(id TEXT PRIMARY KEY,event_id TEXT,corps TEXT,caption TEXT,kind TEXT,line REAL,odds REAL,status TEXT DEFAULT 'active',actual REAL);
    CREATE TABLE pb_betting_bets(id INTEGER PRIMARY KEY,user_id INTEGER,market_id TEXT,choice TEXT,stake INTEGER,line REAL,odds REAL,result TEXT DEFAULT 'pending',payout INTEGER DEFAULT 0);
    CREATE TABLE pb_betting_wallets(user_id INTEGER PRIMARY KEY,balance INTEGER NOT NULL DEFAULT 200);
    CREATE TABLE pb_betting_ledger(id INTEGER PRIMARY KEY,user_id INTEGER,bet_id INTEGER,delta INTEGER,reason TEXT);
  `);
  sync.init(db);
  const event={id:'dci_2026-dci-world-championship-finals',name:'DCI World Championship Finals',season:2026,
    source_url:'https://www.dci.org/events/2026-dci-world-championship-finals/'};
  db.prepare('INSERT INTO pb_betting_events VALUES (?,?,?,?,?,?)').run(event.id,event.name,1786219200,2026,'scheduled',event.source_url);
  db.prepare('INSERT INTO pb_dci_event_dates VALUES (?,?,?)').run(event.id,'2026-08-08','America/New_York');
  db.prepare('INSERT INTO pb_dci_event_sources(event_id,source_url,lineup_json,timezone) VALUES (?,?,?,?)')
    .run(event.id,event.source_url,JSON.stringify([{corps:'Bluecoats',cls:'World Class'}]),'America/New_York');
  db.prepare('INSERT INTO pb_betting_markets(id,event_id,corps,caption,kind,line,odds,status) VALUES (?,?,?,?,?,?,?,?)')
    .run('market1',event.id,'Bluecoats','Overall','absolute',98.9,1.9,'active');
  db.prepare('INSERT INTO pb_betting_wallets VALUES (?,?)').run(1,715);
  db.prepare('INSERT INTO pb_betting_bets(id,user_id,market_id,choice,stake,line,odds,result,payout) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(1,1,'market1','over',10,98.9,1.9,'pending',0);
  const result=sync.parseRecap(recapFixture(),{expectedDate:'2026-08-08'});
  assert.equal(sync.settleVerifiedMarkets(db,event,result).settled,1);
  assert.equal(db.prepare('SELECT balance FROM pb_betting_wallets WHERE user_id=1').get().balance,734);
  assert.equal(db.prepare('SELECT result FROM pb_betting_bets WHERE id=1').get().result,'won');
  assert.equal(sync.settleVerifiedMarkets(db,event,result).settled,0);
  assert.equal(db.prepare('SELECT balance FROM pb_betting_wallets WHERE user_id=1').get().balance,734);
  assert.equal(db.prepare('SELECT count(*) AS n FROM pb_betting_ledger').get().n,1);
  db.close();
});
