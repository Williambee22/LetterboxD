/* Pressboxd global equipped-avatar effects. Handles initial + dynamically added avatars. */
(() => {
  'use strict';
  const ownMeta = document.querySelector('meta[name="pb-cosmetics-self"]');
  let self = '';
  try { self = decodeURIComponent(ownMeta?.content || ''); } catch { /* guest */ }
  const USER = /^[a-z0-9_]{3,20}$/i;
  const FRAME = /^(frame_sapphire|frame_rose|frame_inferno|frame_gold|frame_aurora|frame_prism)$/;
  const MOTION = /^(motion_float|motion_pulse|motion_wobble)$/;
  const AVATAR_CONTEXT = /(?:avatar|user[-_]?pic|user[-_]?photo|profile[-_]?pic|profile[-_]?photo|pfp|reviewuser|comment-user|friendRatingUser|forum[-_]?user|post[-_]?user|nav_user|leaderRow|userrow|user-card)/i;
  const AVATAR_HOLDER = /(?:^|\s)(?:avatar(?:_sm|_lg)?|reviewavatar|comment-avatar|friendRatingAvatar|forum-avatar|user-avatar|post-avatar|profile-avatar|avatar-sm|avatar-lg|leader-avatar|avatarWrap|avatar_fallback|userpic|pfp)(?:\s|$)/i;
  const anchors = 'a[href]';
  const cache = new Map();
  const pending = new Map();
  const seen = new WeakSet();
  let timer = 0;
  const urlOf = url => { try { return new URL(url, location.href).href; } catch { return ''; } };
  const normalize = str => String(str || '').trim().toLowerCase();

  function fromAnchor(anchor) {
    if (!anchor) return '';
    try {
      const url = new URL(anchor.getAttribute('href'), location.origin);
      if (url.origin !== location.origin) return '';
      const m = url.pathname.match(/^\/u\/([^/]+)\/?$/i);
      if (m) {
        const name = decodeURIComponent(m[1]);
        return USER.test(name) ? name.toLowerCase() : '';
      }
      if (/^\/me\/?$/i.test(url.pathname)) return normalize(self);
    } catch { /* invalid href */ }
    return '';
  }

  function usernameFor(node) {
    for (let el=node, depth=0; el && depth<4; el=el.parentElement,depth++) {
      const direct = el.getAttribute?.('data-username') || el.getAttribute?.('data-user-name');
      if (direct && USER.test(direct)) return normalize(direct);
      if (el.tagName === 'A') {
        const linked = fromAnchor(el);
        if (linked) return linked;
      }
      // Stop at the nearest small user row; don't take someone else's link from a huge panel.
      if (depth > 0 && /(?:reviewhead|reviewuser|comment-head|comment-user|friendRatingUser|leaderRow|nav_user|user-card|post-author|forum-post|notifItem|userrow|user-row|member-card|follower)/i.test(el.className || '')) {
        for (const a of el.querySelectorAll(anchors)) {
          const linked = fromAnchor(a);
          if (linked) return linked;
        }
        break;
      }
    }
    // A profile's main portrait might not be enclosed by its profile link.
    const profile = document.getElementById('pb-cosmetics-profile-data');
    if (profile && location.pathname.match(/^\/(?:me|u\/[^/]+)\/?$/i)) {
      try {
        const data=JSON.parse(profile.textContent);
        const main=document.querySelector('main');
        if (main?.contains(node) && !node.closest('nav,header,footer') && USER.test(data.username || '')) {
          const img=node.tagName==='IMG'?node:node.querySelector('img');
          if (img && (img.currentSrc || img.src) && data.avatar_url &&
              urlOf(img.currentSrc || img.src).split('?')[0] === urlOf(data.avatar_url).split('?')[0]) {
            return normalize(data.username);
          }
        }
      } catch { /* profile script handles this */ }
    }
    return '';
  }

  function looksLikeAvatar(img) {
    if (!img || img.closest('.pc-preview-avatar, .pc-product, .pb-cosmetic-avatar, .pb-global-avatar-host')) return false;
    const cls = [img.className, img.parentElement?.className, img.parentElement?.parentElement?.className].join(' ');
    const src = img.getAttribute('src') || '';
    if (img.classList.contains('avatar_fallback')) return true;
    if (AVATAR_CONTEXT.test(cls) || /(?:\/pfps\/|\/avatars\/|\/uploads\/pfps\/|\/static\/pfps\/)/i.test(src)) return true;
    if (img.closest('.nav_user,.reviewuser,.comment-user,.friendRatingUser,.user-card,.leaderRow,.forum-post,.post-author,.notifItem')) return true;
    const a=img.closest('a[href]');
    if (a && fromAnchor(a)) {
      const r=img.getBoundingClientRect();
      return (r.width > 0 && r.width <= 180 && r.height <= 180);
    }
    return false;
  }

  function findHost(img) {
    let cur = img.parentElement;
    for (let depth=0;cur && depth<3;cur=cur.parentElement,depth++) {
      if (AVATAR_HOLDER.test(String(cur.className||''))) return cur;
      if (cur.classList?.contains('pb-cosmetic-avatar')) return null;
    }
    return null;
  }

  function sizeOf(node) {
    const r=node.getBoundingClientRect();
    const w=r.width || node.offsetWidth;
    const h=r.height || node.offsetHeight;
    return w>0 && h>0 ? Math.min(w,h) : 0;
  }

  function avatarImageKey(img) {
    return urlOf(img.currentSrc || img.src || img.getAttribute('src') || '');
  }

  function candidate(img) {
    if (!looksLikeAvatar(img)) return null;
    const host=img.matches?.('.reviewavatar,.comment-avatar,.friendRatingAvatar,.avatar_sm,.forum-avatar,.user-avatar') ? img : findHost(img);
    const size = sizeOf(host || img);
    if (size < 14 || size > 350) return null;
    const user=usernameFor(img);
    const url=img.tagName==='IMG' ? avatarImageKey(img) : ''; 
    if (!user && !url) return null;
    return { img, host, size, user, url };
  }

  function apply(candidate, info) {
    if (!candidate.img.isConnected || seen.has(candidate.img)) return;
    const frame=FRAME.test(info?.frame || '') ? info.frame : '';
    const motion=MOTION.test(info?.motion || '') ? info.motion : '';
    if (!frame && !motion) return;
    let host=candidate.host;
    if (!host) {
      // A stand-alone image needs a containing shell; keep existing image styles.
      host=document.createElement('span');
      host.className='pb-global-avatar-host pb-global-avatar-shell';
      host.style.width=candidate.size+'px';
      host.style.height=candidate.size+'px';
      candidate.img.parentNode.insertBefore(host,candidate.img);
      host.append(candidate.img);
    }
    host.classList.add('pb-global-avatar-host');
    if (motion) host.classList.add('pc-global-'+motion);
    // Dedicated effect node preserves online/presence dots implemented using
    // ::after on the original avatar holder.
    const fx=document.createElement('span');
    fx.className='pb-global-avatar-fx'+(frame?' pc-'+frame:'');
    fx.setAttribute('aria-hidden','true');
    host.appendChild(fx);
    const sz=Math.max(14,Math.min(candidate.size,350));
    const multiplier=Math.min(1,sz/110);
    host.style.setProperty('--pc-mini-rim', Math.max(1,Math.min(5,sz*.045)).toFixed(1)+'px');
    host.style.setProperty('--pc-mini-spread', Math.max(2, Math.min(19,sz*.17)).toFixed(1)+'px');
    host.style.setProperty('--pc-mini-blur', Math.max(2, Math.min(23,sz*.20)).toFixed(1)+'px');
    host.style.setProperty('--pc-mini-softness', Math.max(3,Math.min(52,sz*.48)).toFixed(1)+'px');
    host.style.setProperty('--pc-mini-opacity', (0.6 + multiplier*.22).toFixed(2));
    host.setAttribute('data-cosmetic-size',sz<=32?'xs':sz<=52?'sm':sz<=80?'md':'lg');
    seen.add(candidate.img);
  }

  function getInfo(c) {
    if (c.user && cache.has('u:'+c.user)) return cache.get('u:'+c.user);
    if (c.url && cache.has('a:'+c.url)) return cache.get('a:'+c.url);
    return null;
  }

  async function flush() {
    timer=0;
    const list=[...pending.values()];
    pending.clear();
    if (!list.length) return;
    const fresh=list.filter(c=>c.img.isConnected && !seen.has(c.img));
    const uncached=fresh.filter(c=>!getInfo(c));
    // If a user doesn't have cosmetics we still cache an empty result so the
    // same avatar isn't requested repeatedly when more comments are appended.
    const users=[...new Set(uncached.map(c=>c.user).filter(Boolean))];
    const urls=[...new Set(uncached.map(c=>c.url).filter(Boolean))];
    if (users.length || urls.length) {
      const calls=Math.max(Math.ceil(users.length/100),Math.ceil(urls.length/100));
      for (let i=0;i<calls;i++) {
        const batchUsers=users.slice(i*100,(i+1)*100);
        const batchUrls=urls.slice(i*100,(i+1)*100);
        try {
          const response=await fetch('/api/cosmetics/avatar-effects',{
            method:'POST',credentials:'same-origin',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({usernames:batchUsers,avatar_urls:batchUrls})
          });
          if (!response.ok) throw new Error('lookup '+response.status);
          const data=await response.json();
          for (const u of batchUsers) cache.set('u:'+u,{});
          for (const a of batchUrls) cache.set('a:'+a,{});
          for (const record of data.users || []) {
            const name=normalize(record.username);
            if (name) cache.set('u:'+name,record);
            if (record.avatar_url) cache.set('a:'+urlOf(record.avatar_url),record);
          }
        } catch { /* Leave original avatars intact on API/network errors. */ }
      }
    }
    for (const c of fresh) {
      const info=getInfo(c);
      if (info) apply(c,info);
    }
  }

  function scan(root=document) {
    if (!root || !root.querySelectorAll) return;
    const selector='img,.avatar_fallback,.reviewavatar,.comment-avatar,.friendRatingAvatar,.avatar_sm,.forum-avatar,.user-avatar';
    const imgs=root.matches?.(selector) ? [root,...root.querySelectorAll(selector)] : root.querySelectorAll(selector);
    for (const img of imgs) {
      if (img.matches?.('.reviewavatar,.comment-avatar,.friendRatingAvatar,.avatar_sm,.forum-avatar,.user-avatar') && img.querySelector('img,.avatar_fallback')) continue;
      if (seen.has(img)) continue;
      const c=candidate(img);
      if (!c) continue;
      pending.set(img,c);
    }
    if (pending.size && !timer) timer=setTimeout(flush,85);
  }

  // Some avatars live in initially hidden friend-rating dropdowns. Scan again
  // when the <details> element opens, without requiring the HTML to re-render.
  document.addEventListener('toggle', event => {
    if (event.target?.tagName === 'DETAILS' && event.target.open) {
      requestAnimationFrame(() => scan(event.target));
    }
  }, true);
  // Un-sized lazy-loaded images can gain dimensions after their load event.
  document.addEventListener('load', event => {
    if (event.target?.tagName === 'IMG') scan(event.target);
  }, true);

  // A few EJS components append content after page load. Batch changes into one pass.
  let observerQueued=false;
  const observer=new MutationObserver(changes=>{
    if (observerQueued) return;
    if (!changes.some(m=>m.type==='childList' && m.addedNodes.length)) return;
    observerQueued=true;
    requestAnimationFrame(()=>{observerQueued=false;scan();});
  });
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{
    scan();observer.observe(document.body,{subtree:true,childList:true});
  },{once:true});
  else {scan();observer.observe(document.body,{subtree:true,childList:true});}
})();
