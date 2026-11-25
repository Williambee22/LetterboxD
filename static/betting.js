(()=>{'use strict';
const $=id=>document.getElementById(id);
const state={event:'all',kind:'all',cat:'all',q:'',picks:[],type:'power',queue:[]};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cat=x=>/general effect|^ge\b|^ge\d/i.test(x)?'ge':/music|brass|percussion/i.test(x)?'music':/visual|guard/i.test(x)?'visual':/total score|overall/i.test(x)?'total':'other';
const fmt=x=>(Number(x)>=0?'+':'')+Number(x).toFixed(3);
const POWER={2:3,3:5,4:10,5:20,6:37.5};
const FLEX={3:{3:3,2:1},4:{4:6,3:1.5},5:{5:10,4:2,3:0.4},6:{6:25,5:2,4:0.4}};
const odds=(type,n)=>type==='single'?1.9:type==='power'?(POWER[n]||0):(FLEX[n]?.[n]||0);
const corpsSlug=name=>String(name||'').trim().toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');
const initials=name=>String(name||'').trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase();
function portrait(name){const slug=corpsSlug(name);if(!slug)return `<span class="bt-corp-initials">${esc(initials(name))}</span>`;return `<img class="bt-corp-photo" src="/posters/${encodeURIComponent(slug)}default" alt="${esc(name)} logo" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="bt-corp-initials" hidden>${esc(initials(name))}</span>`;}
function render(){
  const items=MARKETS.filter(m=>(state.event==='all'||m.event_id===state.event)&&(state.kind==='all'||m.kind===state.kind)&&(state.cat==='all'||cat(m.caption)===state.cat)&&(`${m.corps} ${m.caption} ${m.event_name}`).toLowerCase().includes(state.q));
  $('shownCount').textContent=`${items.length} markets`; $('empty').hidden=items.length>0;
  $('marketGrid').innerHTML=items.map(m=>{
    const selected=state.picks.find(p=>p.market_id===m.id);
    return `<article class="bt-card"><div class="bt-card-head"><span>${esc(m.event_name)}</span><strong>${m.kind==='change'?'CHANGE':'FINAL'}</strong></div><div class="bt-card-feature"><div class="bt-corp-symbol">${portrait(m.corps)}</div></div><div class="bt-corps" title="${esc(m.corps)}">${esc(m.corps)}</div><div class="bt-caption">${esc(m.caption)}</div><div class="bt-line"><strong>${m.kind==='change'?fmt(m.line):Number(m.line).toFixed(3)}</strong><small>${m.kind==='change'?'Change':'Score'}</small></div><div class="bt-choices"><button class="more ${selected?.choice==='over'?'selected':''}" data-id="${esc(m.id)}" data-choice="over">↑ MORE</button><button class="less ${selected?.choice==='under'?'selected':''}" data-id="${esc(m.id)}" data-choice="under">↓ LESS</button></div></article>`;
  }).join('');
}
function message(s){$('btMessage').textContent=s;}
function selectionError(m){
  return state.picks.some(p=>{const other=MARKETS.find(x=>x.id===p.market_id);return other?.event_id===m.event_id && String(other.corps).toLowerCase()===String(m.corps).toLowerCase() && other.id!==m.id;});
}
function updatePicks(){
  if(state.picks.length===1)state.type='single';
  else if(state.type==='single' && state.picks.length>1)state.type='power';
  if(state.type==='flex' && state.picks.length<3)state.type=state.picks.length===1?'single':'power';
  const n=state.picks.length;
  document.querySelectorAll('#playTypes button').forEach(b=>{
    const type=b.dataset.play;
    b.disabled=type==='single'?n!==1:type==='power'?n<2:n<3;
    b.classList.toggle('on',state.type===type);
  });
  $('entryPicks').innerHTML=n?state.picks.map((p,i)=>{
    const m=MARKETS.find(x=>x.id===p.market_id);
    return `<div class="pb-selected-leg"><div><strong>${i+1}. ${esc(m?.corps)} · ${esc(p.choice.toUpperCase())} ${Number(m?.line||0).toFixed(3)}</strong><small>${esc(m?.event_name)} · ${esc(m?.caption)}</small></div><button type="button" data-remove="${i}" aria-label="Remove pick">×</button></div>`;
  }).join(''):'<div class="pb-slip-placeholder">Pick MORE or LESS to add your first selection.</div>';
  const multiplier=odds(state.type,n);
  const stake=Number($('stake').value);
  $('slipOdds').textContent=multiplier?multiplier.toFixed(2)+'×':'—';
  $('slipPayout').textContent=multiplier && Number.isFinite(stake)&&stake>0?Math.round(stake*multiplier).toLocaleString()+' 💎':'—';
  $('addEntry').disabled=!multiplier||!Number.isSafeInteger(stake)||stake<1||stake>10000||state.queue.length>=12;
  $('playExplanation').textContent=state.type==='flex'?'Flex Plays can return Gems without every pick winning.':'Power Plays require every pick to win. Single plays settle independently.';
  $('flexPayouts').textContent=state.type==='flex'&&FLEX[n]?Object.entries(FLEX[n]).reverse().map(([wins,x])=>`${wins}/${n} correct: ${x}×`).join(' · '):'Pushes or NOT SCORED legs are removed; entries with too few remaining legs are refunded.';
}
function showQueue(){
  $('queueCount').textContent=`${state.queue.length} entr${state.queue.length===1?'y':'ies'}`;
  $('queuedEntries').innerHTML=state.queue.map((entry,i)=>`<div class="pb-queue-entry"><b>#${i+1} · ${esc(entry.play_type.toUpperCase())} · ${entry.picks.length} picks · 💎${entry.stake}</b><span>${entry.picks.map(p=>{const m=MARKETS.find(x=>x.id===p.market_id);return esc((m?.corps||'')+' '+p.choice.toUpperCase());}).join(' · ')}</span><button type="button" data-remove-entry="${i}">Remove</button></div>`).join('');
  $('placeBet').disabled=state.queue.length===0;
}
$('marketGrid').addEventListener('click',e=>{
  const b=e.target.closest('button[data-id]');if(!b)return;
  const m=MARKETS.find(x=>x.id===b.dataset.id);if(!m)return;
  const idx=state.picks.findIndex(p=>p.market_id===m.id);
  if(idx>=0 && state.picks[idx].choice===b.dataset.choice)state.picks.splice(idx,1);
  else if(idx>=0)state.picks[idx].choice=b.dataset.choice;
  else if(state.picks.length>=6){message('A maximum of 6 picks is allowed per entry.');return;}
  else if(selectionError(m)){message('Only one selection per corps per competition is allowed in an entry.');return;}
  else state.picks.push({market_id:m.id,choice:b.dataset.choice});
  message('');render();updatePicks();
});
$('entryPicks').addEventListener('click',e=>{const b=e.target.closest('[data-remove]');if(!b)return;state.picks.splice(Number(b.dataset.remove),1);render();updatePicks();});
$('playTypes').addEventListener('click',e=>{const b=e.target.closest('button[data-play]');if(!b||b.disabled)return;state.type=b.dataset.play;updatePicks();});
for(const [container,key,attribute] of [['eventTabs','event','id'],['kindTabs','kind','kind'],['captionTabs','cat','cat']]){
  $(container).addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;state[key]=b.dataset[attribute];$(container).querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));render();});
}
$('search').addEventListener('input',e=>{state.q=e.target.value.trim().toLowerCase();render();});
$('stake').addEventListener('input',updatePicks);
document.querySelectorAll('[data-amount]').forEach(b=>b.addEventListener('click',()=>{$('stake').value=b.dataset.amount;updatePicks();}));
$('addEntry').addEventListener('click',()=>{
  const n=state.picks.length,stake=Number($('stake').value);
  if(!odds(state.type,n)||!Number.isSafeInteger(stake)||stake<1||stake>10000)return;
  state.queue.push({play_type:state.type,picks:state.picks.map(p=>({...p})),stake});
  state.picks=[];state.type='power';message('Entry added to queue. Add another entry, or submit your queue.');
  render();updatePicks();showQueue();
});
$('queuedEntries').addEventListener('click',e=>{const b=e.target.closest('[data-remove-entry]');if(!b)return;state.queue.splice(Number(b.dataset.removeEntry),1);showQueue();updatePicks();});
$('placeBet').addEventListener('click',async()=>{
  if(!state.queue.length)return;
  const button=$('placeBet');button.disabled=true;
  try{
    const r=await fetch('/api/betting/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entries:state.queue})});
    const j=await r.json();if(!r.ok)throw Error(j.error||'Could not place entries.');
    $('balance').textContent=Number(j.balance).toLocaleString();
    const byId=id=>MARKETS.find(m=>m.id===id);
    $('entryHistoryList').insertAdjacentHTML('afterbegin',state.queue.map((q,i)=>`<div class="bt-history-item"><div><b>#${esc(j.entries[i].id)} · ${esc(q.play_type.toUpperCase())} · ${q.picks.length} picks</b>${q.picks.map(p=>{const m=byId(p.market_id);return `<small>${esc(m?.corps)} / ${esc(m?.caption)} · ${esc(p.choice.toUpperCase())} ${Number(m?.line||0).toFixed(3)} · PENDING</small>`;}).join('')}</div><div><b>💎 ${q.stake} Gems</b><small>PENDING</small></div></div>`).join(''));
    message(`${j.entries.length} entr${j.entries.length===1?'y':'ies'} submitted. 💎 ${j.total_staked} Gems staked.`);
    state.queue=[];showQueue();
  }catch(err){message(err.message||'Could not submit entries.');}finally{button.disabled=state.queue.length===0;}
});
const daily=$('dailyGemClaim');
function refreshClaim(){if(!daily)return;const ts=Number(daily.dataset.next)||0,seconds=Math.ceil(ts-Date.now()/1000);if(seconds>0){const h=Math.floor(seconds/3600),m=Math.ceil((seconds%3600)/60);daily.disabled=true;daily.textContent=`💎 Next in ${h}h ${m}m`;}else{daily.disabled=false;daily.textContent='💎 Claim 10';}}
if(daily){daily.addEventListener('click',async()=>{daily.disabled=true;try{const r=await fetch('/api/gems/daily',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const j=await r.json();if(j.next_claim_ts)daily.dataset.next=String(j.next_claim_ts);if(j.balance!=null)$('balance').textContent=Number(j.balance).toLocaleString();if(!r.ok&&r.status!==429)throw Error(j.error||'Claim failed');message(j.ok?'Claimed 10 Gems! 💎':'Daily Gems already claimed.');}catch(e){message(e.message);}finally{refreshClaim();}});refreshClaim();setInterval(refreshClaim,60000);}
render();updatePicks();showQueue();
})();
