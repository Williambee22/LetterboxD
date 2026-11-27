'use strict';
const crypto = require('node:crypto');

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_betting_admin_removed_events (
    event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL,
    admin_id INTEGER NOT NULL, removed_ts INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
}
function removeEvent(db, id, adminId) {
  return db.transaction(() => {
    const event = db.prepare('SELECT id,name,status FROM pb_betting_events WHERE id=?').get(id);
    if (!event || event.status !== 'scheduled') throw new Error('Only scheduled competitions can be deleted.');
    const single = db.prepare('SELECT 1 FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id WHERE m.event_id=? LIMIT 1').get(id);
    const multi = db.prepare('SELECT 1 FROM pb_betting_entry_legs l JOIN pb_betting_markets m ON m.id=l.market_id WHERE m.event_id=? LIMIT 1').get(id);
    if (single || multi) throw new Error('Cannot delete a competition with submitted picks. No balances or picks were changed.');
    if (db.prepare("SELECT 1 FROM pb_betting_markets WHERE event_id=? AND status='settled' LIMIT 1").get(id)) throw new Error('Cannot delete a competition with settled markets.');
    if (db.prepare('SELECT 1 FROM pb_betting_no_score_events WHERE event_id=?').get(id)) throw new Error('Cannot delete a competition with a recorded refund.');
    db.prepare("UPDATE pb_betting_events SET status='canceled', updated_ts=unixepoch() WHERE id=?").run(id);
    db.prepare("UPDATE pb_betting_markets SET status='void' WHERE event_id=? AND status='active'").run(id);
    db.prepare('INSERT INTO pb_betting_admin_removed_events(event_id,event_name,admin_id) VALUES(?,?,?)').run(id,event.name,adminId);
    return event.name;
  }).immediate();
}
function mount(app, getConn) {
  function withDb(fn) { const db=getConn(); try { return fn(db); } finally { db.close(); } }
  function admin(req,res,next) {
    try {
      if (!req.session?.uid) return res.redirect('/login?next=%2Fbetsadmin%2Fevents');
      const allowed=withDb(db=>db.prepare('SELECT is_admin FROM users WHERE id=?').get(Number(req.session.uid)));
      if (Number(allowed?.is_admin)!==1) return res.sendStatus(403);
      res.setHeader('Cache-Control','private, no-store');
      next();
    } catch(e) { next(e); }
  }
  function token(req) { return req.session.betting_delete_csrf ||= crypto.randomBytes(32).toString('hex'); }
  app.get('/betsadmin/events', admin, (req,res,next)=>{
    try { withDb(db=>{
      init(db);
      const events=db.prepare(`SELECT e.id,e.name,e.season,e.start_ts,d.local_date,
        (SELECT COUNT(*) FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id WHERE m.event_id=e.id) AS singles,
        (SELECT COUNT(DISTINCT l.entry_id) FROM pb_betting_entry_legs l JOIN pb_betting_markets m ON m.id=l.market_id WHERE m.event_id=e.id) AS entries,
        EXISTS(SELECT 1 FROM pb_betting_markets m WHERE m.event_id=e.id AND m.status='settled') AS settled,
        EXISTS(SELECT 1 FROM pb_betting_no_score_events n WHERE n.event_id=e.id) AS refunded
        FROM pb_betting_events e LEFT JOIN pb_dci_event_dates d ON d.event_id=e.id
        WHERE e.status='scheduled' ORDER BY COALESCE(d.local_date,date(e.start_ts,'unixepoch'),'9999-12-31'),e.name`).all();
      const removed=db.prepare('SELECT r.*,u.username FROM pb_betting_admin_removed_events r LEFT JOIN users u ON u.id=r.admin_id ORDER BY removed_ts DESC LIMIT 100').all();
      res.render('betsadmin_events',{events,removed,csrf:token(req),notice:String(req.query.notice||'').slice(0,240),error:String(req.query.error||'').slice(0,240)});
    }); } catch(e) { next(e); }
  });
  app.post('/betsadmin/events/delete', admin, (req,res,next)=>{
    const expected=req.session.betting_delete_csrf;
    const given=req.body?.csrf;
    if(typeof expected!=='string'||typeof given!=='string'||Buffer.byteLength(given)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(given),Buffer.from(expected)))return res.sendStatus(403);
    const id=typeof req.body?.event_id==='string'?req.body.event_id.trim():'';
    if(!id||id.length>250||req.body?.confirm!=='yes')return res.sendStatus(400);
    try {
      const name=withDb(db=>{init(db);return removeEvent(db,id,Number(req.session.uid));});
      return res.redirect(303,'/betsadmin/events?notice='+encodeURIComponent(name+' deleted from the betting schedule.'));
    } catch(e) { return res.redirect(303,'/betsadmin/events?error='+encodeURIComponent(String(e.message||e).slice(0,240))); }
  });
}
module.exports={mount,init,removeEvent};
