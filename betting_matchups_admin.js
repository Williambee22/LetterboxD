'use strict';
// Adds a standalone head-to-head market monitor to /betsadmin/lines.
// Does not change scores, betting markets, or payouts.
const ejs = require('ejs');
let installed = false;

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[c]);
}
function format(n) {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(3) : '—';
}
function matchupRows(data) {
  const saved = Array.isArray(data?.markets) ? data.markets : [];
  const preview = Array.isArray(data?.preview?.lines) ? data.preview.lines : [];
  const rowById = new Map();
  for (const m of preview) {
    if (m && String(m.caption || '').startsWith('Matchup vs ')) {
      rowById.set(String(m.id), { ...m, published:false });
    }
  }
  for (const m of saved) {
    if (m && String(m.caption || '').startsWith('Matchup vs ')) {
      rowById.set(String(m.id), { ...m, published:true });
    }
  }
  const list = [...rowById.values()];
  list.sort((a,b)=>String(a.corps).localeCompare(String(b.corps)) || String(a.caption).localeCompare(String(b.caption)));
  return list;
}
function tableMarkup(data) {
  const rows = matchupRows(data);
  const htmlRows = rows.map(m=>{
    const favorite=String(m.corps||'');
    const opponent=String(m.caption||'').slice('Matchup vs '.length);
    const value=Number(m.line);
    const valid=Number.isFinite(value) && value>=0;
    const line=valid?value.toFixed(3):'—';
    const favored=valid?'-'+line:'—';
    const underdog=valid?'+'+line:'—';
    const status=String(m.status || (m.published?'active':'preview'));
    const statusClass=/^(active|settled)$/i.test(status) ? 'pb-mu-live' : 'pb-mu-dim';
    const actual=Number.isFinite(Number(m.actual)) && m.actual!==null && m.actual!==undefined ? format(m.actual) : '—';
    return `<tr>
      <td><strong>${escapeHtml(favorite)}</strong></td>
      <td class="pb-mu-point">${escapeHtml(favored)}</td>
      <td><strong>${escapeHtml(opponent)}</strong></td>
      <td class="pb-mu-point">${escapeHtml(underdog)}</td>
      <td><span class="pb-mu-status ${statusClass}">${escapeHtml(m.published ? status.toUpperCase() : 'PREVIEW ONLY')}</span></td>
      <td>${escapeHtml(actual)}</td>
      <td>${m.published?'Posted':'Not posted'}</td>
    </tr>`;
  }).join('\n');
  const selected=data?.selected;
  return `
<style>
#pb-matchup-monitor{margin-top:26px;padding:20px 16px;border:1px solid #374760;border-radius:10px;background:#182235;color:#eef3fc}
#pb-matchup-monitor h2{font-size:21px;margin:0 0 8px}
#pb-matchup-monitor p{font-size:13px;line-height:1.5;color:#b7c5da;margin:0 0 16px}
#pb-matchup-monitor .pb-mu-scroll{overflow-x:auto;border:1px solid #3c4a62;border-radius:7px}
#pb-matchup-monitor table{width:100%;border-collapse:collapse;min-width:720px}
#pb-matchup-monitor th,#pb-matchup-monitor td{padding:11px 13px;text-align:left;border-bottom:1px solid #34435a;font-size:13px}
#pb-matchup-monitor th{background:#222f46;color:#cddaf0;white-space:nowrap}
#pb-matchup-monitor tr:last-child td{border-bottom:0}
#pb-matchup-monitor .pb-mu-point{font-variant-numeric:tabular-nums;font-weight:750;color:#f2f6ff;white-space:nowrap}
#pb-matchup-monitor .pb-mu-status{font-size:11px;font-weight:800;letter-spacing:.035em;white-space:nowrap}
#pb-matchup-monitor .pb-mu-live{color:#83dec2}
#pb-matchup-monitor .pb-mu-dim{color:#f0c683}
#pb-matchup-monitor .pb-mu-empty{padding:16px;border:1px dashed #536078;border-radius:7px}
</style>
<section id="pb-matchup-monitor" aria-labelledby="pb-matchup-title">
<h2 id="pb-matchup-title">Head-to-Head Corps Matchups <span style="font-size:13px;color:#a8bfdc;font-weight:400">(${rows.length})</span></h2>
<p>Selected competition: <strong>${escapeHtml(selected?.name || 'No competition selected')}</strong>. Spreads compare the two corps' final overall scores at this event. World and Open Class can face each other; All-Age and SoundSport remain in their own scoring systems. Preview lines are not available to bet until published.</p>
${rows.length?`<div class="pb-mu-scroll"><table><thead><tr><th>Favored corps</th><th>Spread</th><th>Opponent</th><th>Spread</th><th>Market status</th><th>Actual margin</th><th>Availability</th></tr></thead><tbody>${htmlRows}</tbody></table></div>`:'<p class="pb-mu-empty">No head-to-head matchup lines are available for this competition yet. Matchups require an official lineup and qualifying projected overall scores.</p>'}
</section>`;
}
function addBottomSection(html,data) {
  if (typeof html !== 'string' || html.includes('id="pb-matchup-monitor"')) return html;
  const section=tableMarkup(data);
  // Place below all existing admin panels; preserve page layout and scripts.
  if (/<\/main>/i.test(html)) return html.replace(/<\/main>/i, section+'\n</main>');
  return html.replace(/<\/body>/i, section+'\n</body>');
}
function install() {
  if (installed) return;
  installed=true;
  const original=ejs.renderFile;
  function renderWithMatchups(filename) {
    const args=[...arguments];
    const callback=args[args.length-1];
    if (typeof callback==='function' && /[\\/]betsadmin_lines\.ejs$/i.test(String(filename))) {
      const data=args[1]||{};
      args[args.length-1]=function(error,html){
        if(error)return callback(error,html);
        try{callback(null,addBottomSection(html,data));}
        catch(e){callback(e);}
      };
    }
    return original.apply(this,args);
  }
  ejs.renderFile=renderWithMatchups;
  ejs.__express=renderWithMatchups;
}
module.exports={install,matchupRows,tableMarkup,addBottomSection};
