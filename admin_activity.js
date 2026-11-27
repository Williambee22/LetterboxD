'use strict';

// Pressboxd admin activity feed. Read-only; uses existing database records.
// Register with require('./admin_activity').mount(app, getConn, adminRequired);
const PAGE_SIZE = 50;
const TYPES = {
  rating: 'Ratings', review: 'Reviews', comment: 'Review comments', reply: 'Review replies',
  vote: 'Review votes', registration: 'New accounts', topic: 'Forum topics', post: 'Forum replies',
  reaction: 'Forum reactions', follow: 'Follows', favorite: 'Favorite shows', tierlist: 'Public tierlists',
  prediction: 'Season predictions', entry: 'Gems entries', bet: 'Gems single bets'
};

// Every source produces the same columns. SQL identifiers below are static, never user supplied.
const sources = [
  {type:'rating', tables:['ratings','shows'], sql:`SELECT 'rating' AS kind,r.user_id,r.ts AS ts,s.title AS target,'/show/'||s.id AS href,printf('%g',r.rating_half/2.0)||CASE WHEN r.rating_half=2 THEN ' star' ELSE ' stars' END AS detail,r.show_id||':'||r.user_id AS event_key FROM ratings r JOIN shows s ON s.id=r.show_id`},
  {type:'review',tables:['reviews','shows'],sql:`SELECT 'review',r.user_id,r.ts,s.title,'/show/'||s.id||'?sort=newest','',r.show_id||':'||r.user_id FROM reviews r JOIN shows s ON s.id=r.show_id`},
  {type:'comment',tables:['review_comments','shows'],sql:`SELECT 'comment',c.commenter_user_id,CAST(strftime('%s',c.created_at) AS INTEGER),s.title,'/show/'||s.id||'?sort=newest',substr(c.comment_text,1,160),CAST(c.id AS TEXT) FROM review_comments c JOIN shows s ON s.id=c.show_id`},
  {type:'reply',tables:['review_comment_replies','shows'],sql:`SELECT 'reply',c.replier_user_id,CAST(strftime('%s',c.created_at) AS INTEGER),s.title,'/show/'||s.id||'?sort=newest',substr(c.reply_text,1,160),CAST(c.id AS TEXT) FROM review_comment_replies c JOIN shows s ON s.id=c.show_id`},
  {type:'vote',tables:['review_votes','shows'],sql:`SELECT 'vote',v.voter_user_id,v.ts,s.title,'/show/'||s.id||'?sort=newest',CASE WHEN v.vote>0 THEN 'upvoted' ELSE 'downvoted' END,v.show_id||':'||v.review_user_id||':'||v.voter_user_id FROM review_votes v JOIN shows s ON s.id=v.show_id WHERE v.vote<>0`},
  {type:'registration',tables:['users'],sql:`SELECT 'registration',u.id,u.created_ts,'','','',CAST(u.id AS TEXT) FROM users u`},
  {type:'topic',tables:['forum_topics'],sql:`SELECT 'topic',t.user_id,t.created_ts,t.title,'/forums/topic/'||t.id,'',CAST(t.id AS TEXT) FROM forum_topics t`},
  {type:'post',tables:['forum_posts','forum_topics'],sql:`SELECT 'post',p.user_id,p.created_ts,t.title,'/forums/topic/'||t.id||'#post-'||p.id,substr(p.body,1,160),CAST(p.id AS TEXT) FROM forum_posts p JOIN forum_topics t ON t.id=p.topic_id WHERE COALESCE(p.is_deleted,0)=0 AND p.id<>COALESCE((SELECT MIN(p0.id) FROM forum_posts p0 WHERE p0.topic_id=p.topic_id AND p0.user_id=t.user_id AND p0.created_ts=t.created_ts),-1)`},
  {type:'reaction',tables:['forum_post_reactions','forum_posts','forum_topics'],sql:`SELECT 'reaction',r.user_id,r.created_ts,t.title,'/forums/topic/'||t.id||'#post-'||p.id,r.emoji,r.post_id||':'||r.user_id FROM forum_post_reactions r JOIN forum_posts p ON p.id=r.post_id JOIN forum_topics t ON t.id=p.topic_id WHERE COALESCE(p.is_deleted,0)=0`},
  {type:'follow',tables:['follows','users'],sql:`SELECT 'follow',f.follower_id,f.created_ts,u.username,'','',f.follower_id||':'||f.followed_id FROM follows f JOIN users u ON u.id=f.followed_id`},
  {type:'favorite',tables:['user_favorite_shows','shows'],sql:`SELECT 'favorite',f.user_id,f.created_ts,s.title,'/show/'||s.id,'',f.user_id||':'||f.show_id FROM user_favorite_shows f JOIN shows s ON s.id=f.show_id`},
  {type:'tierlist',tables:['tierlists'],sql:`SELECT 'tierlist',t.user_id,t.updated_ts,t.name,'/tierlists/public/'||t.id,CASE WHEN t.created_ts=t.updated_ts THEN 'created' ELSE 'updated' END,CAST(t.id AS TEXT) FROM tierlists t WHERE t.is_public=1`},
  {type:'prediction',tables:['season_predictions'],sql:`SELECT 'prediction',p.user_id,MAX(p.submitted_ts),p.season_label,'/predictions/all','',p.season_label||':'||p.user_id FROM season_predictions p GROUP BY p.user_id,p.season_label`},
  {type:'entry',tables:['pb_betting_entries'],sql:`SELECT 'entry',e.user_id,e.created_ts,'#'||e.id,'/betsadmin',e.play_type||' · '||e.stake||' Gems',CAST(e.id AS TEXT) FROM pb_betting_entries e`},
  {type:'bet',tables:['pb_betting_bets','pb_betting_markets','pb_betting_events'],sql:`SELECT 'bet',b.user_id,b.placed_ts,m.corps||' · '||m.caption||' · '||e.name,'/betsadmin',b.choice||' '||printf('%.3f',b.line)||' · '||b.stake||' Gems',CAST(b.id AS TEXT) FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id JOIN pb_betting_events e ON e.id=m.event_id`}
];

function readActivity(db, query={}) {
  const kind = typeof query.kind==='string' && Object.hasOwn(TYPES,query.kind) ? query.kind : '';
  const username = typeof query.username==='string' ? query.username.trim().slice(0,100) : '';
  const rawPage=Number(query.page||1);
  const page=Number.isSafeInteger(rawPage)&&rawPage>0?Math.min(rawPage,100000):1;
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
  const active=sources.filter(s=>(!kind||s.type===kind)&&s.tables.every(t=>tables.has(t)));
  const filters={kind,username,page};
  if(!active.length)return {rows:[],hasNext:false,filters};
  const sql=`WITH activity(kind,user_id,ts,target,href,detail,event_key) AS (${active.map(s=>s.sql).join('\nUNION ALL\n')})
    SELECT a.*,u.username FROM activity a JOIN users u ON u.id=a.user_id
    WHERE a.ts IS NOT NULL AND a.ts>0 AND (@username='' OR instr(lower(u.username),lower(@username))>0)
    ORDER BY CAST(a.ts AS INTEGER) DESC,a.kind ASC,a.event_key ASC LIMIT @limit OFFSET @offset`;
  const rows=db.prepare(sql).all({username,limit:PAGE_SIZE+1,offset:(page-1)*PAGE_SIZE});
  const hasNext=rows.length>PAGE_SIZE;
  return {rows:rows.slice(0,PAGE_SIZE).map(r=>({...r,href:r.kind==='follow'?'/u/'+encodeURIComponent(r.target):r.href,profile:'/u/'+encodeURIComponent(r.username)})),hasNext,filters};
}

function mount(app,getConn,adminRequired){
  app.get('/admin/activity',adminRequired(async (req,res,next)=>{
    let db;
    try {
      db=getConn();
      // Recheck current privileges, not just the session's cached role.
      const uid=Number(req.session?.uid || req.session?.user?.id || 0);
      const user=db.prepare('SELECT is_admin FROM users WHERE id=?').get(uid);
      if(Number(user?.is_admin)!==1)return res.sendStatus(403);
      res.setHeader('Cache-Control','private, no-store');
      const result=readActivity(db,req.query);
      return res.render('admin_activity',{...result,types:TYPES,me:res.locals.me});
    } catch(err){return next(err);} finally {if(db)db.close();}
  }));
}
module.exports={mount,readActivity};
