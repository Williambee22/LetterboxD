'use strict';
const fs=require('fs');const vm=require('vm');const path=require('path');
const root=path.join(__dirname,'..');
function escapeHtml(input){return String(input??'').replace(/[&<>'"`]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;','`':'&#96;'}[s]));}
function compile(tpl){const re=/<%([=-]?)([\s\S]*?)%>/g;let m,last=0,js='let __output=""; with(__data){\n';while((m=re.exec(tpl))){js+='__output+='+JSON.stringify(tpl.slice(last,m.index))+';\n';js+=m[1]==='='?'__output+=__esc('+m[2]+');\n':m[1]==='-'?'__output+=('+m[2]+');\n':m[2]+'\n';last=re.lastIndex;}js+='__output+='+JSON.stringify(tpl.slice(last))+';\n}return __output;';return new Function('__data','__esc',js)}
const cosmetics=require('../cosmetics');const catalog=cosmetics.CATALOG.map(item=>({...item,defaultPrice:item.price,defaultName:item.name,defaultRarity:item.rarity,isOverridden:false,metadataOverridden:false}));
let x=catalog.find(x=>x.id==='frame_rose');x={...x,name:'Rose Royale',rarity:'Mythic',metadataOverridden:true};catalog[catalog.findIndex(x=>x.id==='frame_rose')]=x;
const data={me:{username:'admin',is_admin:1},catalog,history:[],metadataHistory:[{item_id:'frame_rose',old_name:'Rose Quartz',new_name:'Rose Royale',old_rarity:'Common',new_rarity:'Mythic',operation:'set',changed_ts:1790000000,admin_name:'admin'}],rarities:cosmetics.RARITIES,csrf:'a'.repeat(64),maxPrice:1000000000,notice:'',error:'',balance:100000,owned_ids:new Set(['frame_rose']),equipped:{frame:'frame_rose',motion:null,nameplate:null}};
for(const name of ['cosmetics_admin.ejs','cosmetics_store.ejs','cosmetics_inventory.ejs']){
 const html=compile(fs.readFileSync(path.join(root,'templates',name),'utf8'))(data,escapeHtml);
 if(!html.includes('<!doctype html>')||!html.includes('</html>'))throw Error('Bad HTML: '+name);
 if(!html.includes('/static/styles.css'))throw Error('Missing base CSS: '+name);
 if(name==='cosmetics_admin.ejs'){
   if((html.match(/action="\/store\/admin\/metadata"/g)||[]).length!==65)throw Error('Expected 64 edit +1 reset, got '+(html.match(/action="\/store\/admin\/metadata"/g)||[]).length);
   if((html.match(/action="\/store\/admin\/price"/g)||[]).length!==64)throw Error('64 edit price forms');
   if(!html.includes('Rose Royale'))throw Error('Renamed cosmetic not present');
   const scripts=Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));for(const s of scripts)new vm.Script(s[1]);
 }
 if(!html.includes('Rose Royale'))throw Error('Edited name absent: '+name);
 fs.writeFileSync(path.join(__dirname,name.replace('.ejs','.rendered.html')),html);
 console.log('OK',name,html.length);
}
