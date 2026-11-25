'use strict';
// Shared scheduling rule for the store, wager validation and automated DCI sync.
const {canonicalCorps} = require('./betting_lines');
const DAY = 86400;
function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function utcDayShift(day, offset) {
  const date = new Date(day + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0,10);
}
function lineupKeys(json) {
  try {
    const values=JSON.parse(json);
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map(x=>canonicalCorps(typeof x==='string'?x:x?.corps)).filter(Boolean))];
  } catch { return []; }
}
// Do not grant an extended opening unless the competition has a verified local date
// and a published participant list. We check BOTH the 48h-open date and the day
// immediately preceding the competition: this protects projections from new scores.
function openingForEvent(db,event) {
  const defaultOpen=Number(event.start_ts)-DAY;
  if (!Number.isFinite(defaultOpen)) return defaultOpen;
  // A season opener can be released earlier by an administrator. Once opened,
  // that timestamp remains fixed for all UI and wager validations.
  if (tableExists(db,'pb_betting_manual_open')) {
    const manual=db.prepare('SELECT opened_ts FROM pb_betting_manual_open WHERE event_id=?').get(event.id);
    if (manual) return Math.min(defaultOpen,Number(manual.opened_ts));
  }

  if (!tableExists(db,'pb_dci_event_sources') || !tableExists(db,'pb_dci_event_dates')) return defaultOpen;
  const source=db.prepare('SELECT lineup_json FROM pb_dci_event_sources WHERE event_id=?').get(event.id);
  const meta=db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(event.id);
  if (!source || !meta?.local_date) return defaultOpen;
  const participants=new Set(lineupKeys(source.lineup_json));
  if (!participants.size) return defaultOpen;
  const twoDaysPrior=utcDayShift(meta.local_date,-2);
  const previousDay=utcDayShift(meta.local_date,-1);
  if (!twoDaysPrior || !previousDay) return defaultOpen;

  // A published performance counts even before scores are released. Event dates
  // and participant lists come from the existing official DCI schedule cache.
  const priorEvents=db.prepare(`
    SELECT e.id, s.lineup_json FROM pb_betting_events e
    JOIN pb_dci_event_dates d ON d.event_id=e.id
    JOIN pb_dci_event_sources s ON s.event_id=e.id
    WHERE e.id<>? AND e.season=? AND e.status<>'canceled'
      AND d.local_date IN (?,?)
  `).all(event.id,event.season,twoDaysPrior,previousDay);
  for (const other of priorEvents) {
    for (const corps of lineupKeys(other.lineup_json)) {
      if (participants.has(corps)) return defaultOpen;
    }
  }
  // Also consider already confirmed performances even if their event's source
  // page is missing from the current official schedule cache.
  if (tableExists(db,'pb_dci_verified_scores')) {
    const scores=db.prepare(`
      SELECT DISTINCT corps_key,corps FROM pb_dci_verified_scores
      WHERE season=? AND date IN (?,?)
    `).all(event.season,twoDaysPrior,previousDay);
    if (scores.some(s=>participants.has(canonicalCorps(s.corps_key||s.corps)))) return defaultOpen;
  }
  return Number(event.start_ts)-2*DAY;
}
module.exports={openingForEvent};
