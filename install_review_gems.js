'use strict';
// Installs/upgrades Pressboxd review rewards and adds the small live (#💎) indicator.
// Run from the repository root: node install_review_gems.js
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const root=process.cwd();
const appPath=path.join(root,'app.js');
const templatePath=path.join(root,'templates','show_detail.ejs');
const modulePath=path.join(root,'review_gems.js');
for(const p of [appPath,templatePath,modulePath])if(!fs.existsSync(p)){
  console.error('Missing file: '+p+'; run in the Pressboxd project root with both JS files present.');process.exit(1);
}
const app=fs.readFileSync(appPath,'utf8');
const template=fs.readFileSync(templatePath,'utf8');
let newApp=app,newTemplate=template;
const startMarker="app.post('/show/:show_id/review', loginRequired(async (req, res) => {";
const endMarker="app.post('/show/:show_id/review/delete', loginRequired(async (req, res) => {";
const start=app.indexOf(startMarker),end=app.indexOf(endMarker);
if(start<0||end<=start||app.indexOf(startMarker,start+1)!==-1)throw Error('Review route not found uniquely; files unchanged.');
const before=app.slice(start,end);
let updated=before;
if(before.includes('reviewGems.award(conn')){
  // Upgrade previous installer: only replace the success/error flash branch.
  const old=/req\.flash\('ok', reward\.credited > 0\s*\? `Saved your review\. \+\$\{reward\.credited\} Gems earned!`\s*:\s*'Saved your review\. No additional Gems for this edit\.'\);/;
  if(old.test(updated)) updated=updated.replace(old,`req.flash('ok', !reward.eligible
        ? 'Saved your review. No Gems awarded: ' + reward.reason
        : reward.credited > 0
          ? \`Saved your review. +\${reward.credited} Gems earned!\`
          : 'Saved your review. No additional Gems for this edit.');`);
  else if(!updated.includes('!reward.eligible'))throw Error('Existing reward handler was customized; app.js unchanged.');
}else{
  const old=/await dbx\.upsertReview\(conn, showId, Number\(req\.session\.uid\), text\);\s*await dbx\.commit\(conn\);\s*req\.flash\('ok', 'Saved your review\.'\);/;
  if(!old.test(updated))throw Error('Unexpected review-save implementation; app.js unchanged.');
  updated=updated.replace(old,`// Save the review and review-Gems award atomically.
      const reviewGems = require('./review_gems');
      const reward = conn.transaction(() => {
        dbx.upsertReview(conn, showId, Number(req.session.uid), text);
        return reviewGems.award(conn, Number(req.session.uid), showId, text);
      })();
      await dbx.commit(conn);
      req.flash('ok', !reward.eligible
        ? 'Saved your review. No Gems awarded: ' + reward.reason
        : reward.credited > 0
          ? \`Saved your review. +\${reward.credited} Gems earned!\`
          : 'Saved your review. No additional Gems for this edit.');`);
}
newApp=app.slice(0,start)+updated+app.slice(end);

// Backfill all existing reviews on startup, after betting Gems tables are ready.
// Calling this repeatedly is safe: award() tracks amounts per user and show.
const startupMarker='mountBetting(app, getConn);';
const backfillMarker='// PRESSBOXD_REVIEW_GEMS_BACKFILL_V1';
if(!newApp.includes(backfillMarker)){
  if(newApp.split(startupMarker).length!==2)throw Error('Unique betting module startup point not found; files unchanged.');
  newApp=newApp.replace(startupMarker, startupMarker+`
    ${backfillMarker}
    {
      const reviewGemsBackfill = require('./review_gems');
      const backfillDb = getConn();
      try {
        const summary=reviewGemsBackfill.backfillExistingReviews(backfillDb);
        console.log('[Review Gems] historical review backfill:', summary);
      } finally {
        dbx.close(backfillDb);
      }
    }`);
}

// Add position:relative wrapper around only the review textarea, preserving drafts.
if(!template.includes('data-review-gems-counter')){
  const opening=/([ \t]*)<textarea\s*\r?\n\s*name="review_text"/;
  const m=template.match(opening);
  if(!m)throw Error('Expected review textarea not found; files unchanged.');
  const leading=m[1];
  const openingReplacement=`${leading}<div class="review-gems-wrap" style="position:relative;">\n${leading}  <textarea\n                  name="review_text"`;
  newTemplate=template.replace(opening, openingReplacement);
  const closeTextarea=/(data-review-draft-textarea\s*\r?\n\s*>[\s\S]*?<\/textarea>)/;
  if(!closeTextarea.test(newTemplate))throw Error('Review textarea closing tag not found; files unchanged.');
  newTemplate=newTemplate.replace(closeTextarea, `$1\n${leading}  <span data-review-gems-counter aria-live="polite" title="Potential Gems from this review" style="position:absolute;right:9px;bottom:9px;z-index:2;font-size:11px;line-height:1.2;color:var(--muted,#9aa6b6);background:rgba(15,18,26,.90);border:1px solid rgba(180,180,180,.18);border-radius:4px;padding:3px 5px;pointer-events:none;">(0💎)</span>\n${leading}</div>`);
  // Same anti-spam checks as server to avoid optimistic misleading payouts.
  // The server remains authoritative; prior awards may mean the incremental award is less.
  const js=String.raw`<script>
  (()=>{
    const form=document.querySelector('[data-review-draft-form]');
    const box=form?.querySelector('[data-review-draft-textarea]');
    const counter=form?.querySelector('[data-review-gems-counter]');
    if(!box||!counter)return;
    function qualifies(text){
      const s=text.trim();if(!s||Array.from(s).length>6000)return false;
      const words=s.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g)||[];
      const letters=(s.match(/[a-z]/gi)||[]).length;
      if(letters<8||words.length<2)return false;
      const condensed=s.toLowerCase().replace(/[^a-z]/g,'');
      if(/(.)\1{5,}/.test(condensed)||/(.{3,16})\1{3,}/.test(condensed))return false;
      const uniq=new Set(words);
      if(words.length>=5&&uniq.size/words.length<.35)return false;
      if(words.length>=5&&words.filter(w=>w.length===1).length/words.length>.6)return false;
      const longWords=words.filter(w=>w.length>=13);
      if(longWords.some(w=>w.length>32||((w.match(/[aeiouy]/g)||[]).length/w.length)<.20||/[^aeiouy]{7,}/.test(w)))return false;
      if(words.length>=25&&uniq.size<Math.max(7,Math.floor(words.length*.18)))return false;
      return true;
    }
    function update(){
      const s=box.value.trim(),n=Array.from(s).length;
      const amount=qualifies(s) ? 10+(n>400?5:0)+(n>800?10:0)+(n>1600?15:0)+(n>3000?25:0) : 0;
      counter.textContent='('+amount+'💎)';
      counter.title=amount?'Potential total Gems for a qualifying review; previously awarded Gems are not paid again.':'Write an original review to qualify for Gems.';
    }
    box.addEventListener('input',update);
    update();
  })();
</script>`;
  if(!newTemplate.includes('</body>'))throw Error('Template has no </body>; files unchanged.');
  newTemplate=newTemplate.replace('</body>',js+'\n</body>');
}
const syntax=path.join(root,'.review_gems_syntax_check.tmp.js');
try{
  fs.writeFileSync(syntax,newApp,'utf8');
  const check=spawnSync(process.execPath,['--check',syntax],{encoding:'utf8'});
  if(check.status!==0)throw Error('app.js syntax failure: '+check.stderr);
}finally{if(fs.existsSync(syntax))fs.unlinkSync(syntax);}
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const changes=[[appPath,newApp,app],[templatePath,newTemplate,template]].filter(x=>x[1]!==x[2]);
const backups=[];
try{
  for(const [filepath] of changes){const backup=filepath+'.before-review-gems-'+stamp+'.bak';fs.copyFileSync(filepath,backup,fs.constants.COPYFILE_EXCL);backups.push([filepath,backup]);}
  for(const [filepath,content] of changes)fs.writeFileSync(filepath,content,'utf8');
}catch(e){for(const [filepath,backup] of backups)fs.copyFileSync(backup,filepath);throw e;}
console.log('Automatic existing-review Gems backfill enabled. All qualifying reviews are checked on startup; prior awards are not repeated.');
console.log('Review Gems anti-spam protection and counter installed. Updated: '+(changes.map(x=>path.relative(root,x[0])).join(', ')||'already installed'));
console.log('The counter shows possible TOTAL rewards, not guaranteed new Gems after previous payouts.');
