/* Pressboxd v14. Automatically decorate equipped user avatars anywhere on the site. */
(() => {
  'use strict';
  if (window.__pbGlobalCosmeticsV14) return;
  window.__pbGlobalCosmeticsV14 = true;

  const USER_RE = /^[a-z0-9_]{3,20}$/i;
  const FRAMES = new Set(["frame_sapphire","frame_rose","frame_inferno","frame_gold","frame_aurora","frame_prism","frame_obsidian","frame_crimson","frame_emerald","frame_amethyst","frame_frost","frame_copper","frame_moonstone","frame_nebula","frame_solar","frame_phantom","frame_toxic","frame_plasma","frame_eclipse","frame_celestial","frame_stardust","frame_hologram","frame_chromatic","frame_lightning","frame_nova","frame_abyss","frame_supernova","frame_quantum","frame_singularity","frame_divine"]);
  const MOTIONS = new Set(["motion_float","motion_pulse","motion_wobble","motion_drift","motion_bounce","motion_spin","motion_orbit","motion_shiver","motion_tilt","motion_glitch","motion_vortex","motion_astral"]);
  const OWN_NAME = (() => { try { return decodeURIComponent(document.querySelector('meta[name="pb-cosmetics-self"]')?.content || '').toLowerCase(); } catch { return ''; } })();
  const OWN_ID = Number(document.querySelector('meta[name="pb-cosmetics-self-id"]')?.content || 0);

  const HOLDER = '.avatar_sm,.avatar_lg,.avatar-sm,.avatar-lg,.avatarWrap,.avatar-wrap,.avatar_fallback,' +
    '.reviewavatar,.review-avatar,.comment-avatar,.commentAvatar,.friendRatingAvatar,.forum-avatar,' +
    '.forumAvatar,.user-avatar,.userAvatar,.post-avatar,.profile-avatar,.leader-avatar,' +
    '.userSearchAvatar,.pfp,.userpic,[data-avatar-holder]';
  const ROW = '.nav_user,.userSearchItem,.reviewhead,.reviewcard,.reviewuser,.review-user,' +
    '.comment-head,.comment-header,.comment-user,.commentItem,.forum-post,.forumPost,' +
    '.forum-reply,.post-author,.postAuthor,.friendRatingUser,.friendRatingItem,' +
    '.leaderRow,.leader-row,.userrow,.user-row,.user-card,.userCard,.userSearchItem,' +
    '.member-card,.follower,.following,.friend-row,.friendRow,.top-user,.topUser,' +
    'article,li,tr,[data-user-id],[data-username],[data-user-name]';
  const AVOID = '.pc-preview-avatar,.pc2-product,.pc-product,.pb-cosmetic-avatar,' +
    '.pc2-intro-preview,.pc2-product-art,.pb-global-avatar-fx';
  const avatars = new WeakMap();
  const cache = new Map();
  const pending = new Map();
  let scheduled = false;
  let inFlight = false;

  const normalize = s => String(s || '').trim().toLowerCase();
  const getUrl = s => {
    if (!s || /^data:|^blob:|^javascript:/i.test(s)) return '';
    try { const u = new URL(s, location.href); return /https?:/.test(u.protocol) ? u.href : ''; }
    catch { return ''; }
  };
  const bareUrl = url => { try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; } catch { return url; } };
  function fromProfileLink(anchor) {
    if (!anchor?.getAttribute) return '';
    try {
      const u = new URL(anchor.getAttribute('href'), location.href);
      if (u.origin !== location.origin) return '';
      if (u.pathname === '/me' || u.pathname === '/me/') return OWN_NAME;
      const match = u.pathname.match(/^\/u\/([^/]+)(?:\/(?:ratings|followers|following))?\/?$/i);
      if (!match) return '';
      const name = decodeURIComponent(match[1]);
      return USER_RE.test(name) ? normalize(name) : '';
    } catch { return ''; }
  }
  function routeUsername() {
    const m = location.pathname.match(/^\/u\/([^/]+)\/?$/);
    if (!m) return location.pathname === '/me' ? OWN_NAME : '';
    try { const s = decodeURIComponent(m[1]); return USER_RE.test(s) ? normalize(s) : ''; }
    catch { return ''; }
  }
  function isProfilePortrait(node) {
    return Boolean(node.closest('.profile_avatar_column,.profile_hero .avatar_lg,.profile-hero .avatar_lg'));
  }
  function nearestIdentity(node) {
    // Identity supplied on the avatar or its closest containing user row wins.
    for (let el = node, depth = 0; el && depth < 8; el = el.parentElement, depth++) {
      const uid = Number(el.getAttribute?.('data-user-id') || el.getAttribute?.('data-author-id') || 0);
      const username = el.getAttribute?.('data-username') || el.getAttribute?.('data-user-name') || el.getAttribute?.('data-author');
      if (Number.isSafeInteger(uid) && uid > 0) return { id: uid, name: USER_RE.test(username || '') ? normalize(username) : '' };
      if (username && USER_RE.test(username)) return { id: 0, name: normalize(username) };
      if (el.matches?.('a[href]')) {
        const name = fromProfileLink(el);
        if (name) return { id: 0, name };
      }
      if (el.matches?.('.nav_user') && OWN_NAME) return { id: OWN_ID, name: OWN_NAME };
      if (el.matches?.(ROW)) {
        const links = [...el.querySelectorAll('a[href]')]
          .map(fromProfileLink).filter(Boolean);
        const names = [...new Set(links)];
        if (names.length === 1) return { id: 0, name: names[0] };
        // A review or friend row with several author links is ambiguous;
        // don't accidentally give another person's avatar the wrong frame.
        break;
      }
      if (el.tagName === 'MAIN' || el.tagName === 'BODY') break;
    }
    if (isProfilePortrait(node)) {
      const name = routeUsername();
      return { id: location.pathname === '/me' ? OWN_ID : 0, name };
    }
    return { id: 0, name: '' };
  }
  function avatarSource(el) {
    if (el.tagName === 'IMG') return el.currentSrc || el.getAttribute('src') || '';
    if (el.tagName === 'PICTURE') return el.querySelector('img')?.currentSrc || '';
    if (el.matches?.('.avatar_fallback')) return '';
    let css = el.style?.backgroundImage || '';
    if (!css || css === 'none') {
      if (/(?:avatar|pfp|userpic)/i.test(el.className || '')) css = getComputedStyle(el).backgroundImage;
    }
    const match = css.match(/url\(["']?([^"')]+)["']?\)/i);
    return match ? match[1] : '';
  }
  function visualElement(el) {
    if (el.matches?.(AVOID) || el.closest(AVOID)) return false;
    if (el.closest('svg,canvas')) return false;
    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.getAttribute('src') || '';
      const context = [el.getAttribute('class'),el.parentElement?.getAttribute('class'),
        el.parentElement?.parentElement?.getAttribute('class'),el.getAttribute('alt')].join(' ');
      if (/(?:avatar|pfp|userpic|profile.pic|reviewuser|reviewavatar|member.photo|author.photo)/i.test(context)) return true;
      if (/(?:\/pfps\/|\/avatars\/|\/uploads\/pfps\/|\/static\/pfps\/)/i.test(src)) return true;
      const profileAnchor = el.closest('a[href]');
      if (fromProfileLink(profileAnchor)) {
        const r = el.getBoundingClientRect();
        const squareish = r.width > 11 && r.height > 11 && Math.abs(r.width-r.height) <= Math.max(10,r.width*.32);
        if (squareish && Math.max(r.width,r.height) <= 160) return true;
      }
      return Boolean(el.closest('.nav_user,.userSearchItem,.reviewhead,.comment-user,.friendRatingUser,.forum-post,.post-author,.leaderRow,.user-card') &&
        /(?:person|avatar|user|profile|member)/i.test(el.getAttribute('alt') || ''));
    }
    if (el.matches?.('.avatar_fallback')) return true;
    return Boolean(/(?:avatar|pfp|userpic)/i.test(el.className || '') && avatarSource(el));
  }
  function dimensions(el) {
    const r = el.getBoundingClientRect();
    return Math.min(r.width || el.offsetWidth || 0, r.height || el.offsetHeight || 0);
  }
  function nearestHost(el) {
    if (el.tagName !== 'IMG' && el.tagName !== 'PICTURE' && el.matches?.(HOLDER) &&
        el.tagName !== 'A') return el;
    for (let p=el.parentElement, i=0; p && i<4; p=p.parentElement, i++) {
      if (p.matches?.('.pb-cosmetic-avatar,.pb-global-avatar-host')) return p.matches('.pb-global-avatar-host') ? p : null;
      if (p.matches?.(HOLDER) && !['IMG','PICTURE','A'].includes(p.tagName)) {
        if (p.querySelectorAll('img').length > 1) continue;
        return p;
      }
      if (p.matches?.(ROW)) break;
    }
    return null;
  }
  function candidate(el) {
    if (!el.isConnected || !visualElement(el)) return null;
    const host = nearestHost(el);
    const size = dimensions(host || el);
    if (size < 12 || size > 360) return null;
    const identity = nearestIdentity(el);
    const raw = avatarSource(el);
    const url = getUrl(raw);
    if (!identity.id && !identity.name && !url) return null;
    const alternatives = raw && url ? [...new Set([raw,url,bareUrl(url),bareUrl(raw)])].filter(s => /^(?:https?:\/\/|\/)/.test(s)) : [];
    const key = [identity.id,identity.name,url].join('|');
    return { el, host, size, id: identity.id, name: identity.name, url, alternatives, key };
  }
  function keyInfo(c) {
    if (c.id) return cache.get('id:'+c.id);
    if (c.name) return cache.get('name:'+c.name);
    return c.url ? cache.get('url:'+bareUrl(c.url)) : undefined;
  }
  function forget(el) {
    const previous = avatars.get(el);
    if (!previous) return;
    previous.fx?.remove();
    previous.host?.classList.remove(...[...MOTIONS].map(x => 'pc-global-'+x));
    // Shells remain around a previously styled avatar to preserve layout.
    avatars.delete(el);
  }
  function apply(c, record) {
    if (!c.el.isConnected) return;
    const frame = FRAMES.has(record?.frame) ? record.frame : '';
    const motion = MOTIONS.has(record?.motion) ? record.motion : '';
    const previous = avatars.get(c.el);
    if (previous?.key === c.key && previous.frame === frame && previous.motion === motion) return;
    if (previous) forget(c.el);
    if (!frame && !motion) { avatars.set(c.el, { key:c.key, frame:'', motion:'' }); return; }

    let host = c.host;
    if (!host || host.tagName === 'IMG' || host.tagName === 'PICTURE') {
      host = document.createElement('span');
      host.className = 'pb-global-avatar-host pb-global-avatar-shell';
      host.style.width = c.size+'px';
      host.style.height = c.size+'px';
      c.el.before(host);
      host.appendChild(c.el);
    }
    host.classList.add('pb-global-avatar-host');
    host.classList.remove(...[...MOTIONS].map(x => 'pc-global-'+x));
    if (motion) host.classList.add('pc-global-'+motion);
    const fx = document.createElement('span');
    fx.className = 'pb-global-avatar-fx' + (frame ? ' pc-'+frame : '');
    fx.setAttribute('aria-hidden','true');
    host.appendChild(fx);
    const size = Math.min(360, Math.max(12,c.size));
    host.style.setProperty('--pc-mini-rim',Math.max(1,Math.min(3,size*.028)).toFixed(1)+'px');
    host.style.setProperty('--pc-mini-blur',Math.max(3,Math.min(9,size*.10)).toFixed(1)+'px');
    host.setAttribute('data-cosmetic-size',size <= 30 ? 'xs':size <= 54 ? 'sm':size <= 85 ? 'md':'lg');
    avatars.set(c.el, {key:c.key,host,fx,frame,motion});
  }
  function addCandidate(el) {
    const c = candidate(el);
    if (!c) return;
    const old = avatars.get(el);
    if (old && old.key === c.key) return;
    pending.set(el,c);
    schedule();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush,100);
  }
  async function flush() {
    scheduled = false;
    if (inFlight) { if (pending.size) schedule(); return; }
    inFlight = true;
    const batch = [...pending.values()].filter(c => c.el.isConnected);
    pending.clear();
    if (!batch.length) { inFlight=false; return; }
    const unknown = batch.filter(c => keyInfo(c) === undefined);
    const ids = [...new Set(unknown.map(c=>c.id).filter(Boolean))];
    const usernames = [...new Set(unknown.filter(c=>!c.id).map(c=>c.name).filter(Boolean))];
    const urls = [...new Set(unknown.filter(c=>!c.name&&!c.id).flatMap(c=>c.alternatives))];
    const calls = Math.max(Math.ceil(ids.length/100),Math.ceil(usernames.length/100),Math.ceil(urls.length/100));
    let failed = false;
    for (let i=0;i<calls;i++) {
      const partIds=ids.slice(i*100,(i+1)*100);
      const partNames=usernames.slice(i*100,(i+1)*100);
      const partUrls=urls.slice(i*100,(i+1)*100);
      try {
        const response = await fetch('/api/cosmetics/avatar-effects',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},
          body:JSON.stringify({user_ids:partIds,usernames:partNames,avatar_urls:partUrls})
        });
        if (!response.ok) throw new Error('avatar-effects '+response.status);
        const result = await response.json();
        for (const id of partIds) cache.set('id:'+id, {});
        for (const name of partNames) cache.set('name:'+name, {});
        for (const url of partUrls) cache.set('url:'+bareUrl(getUrl(url)), {});
        for (const info of result.users || []) {
          if (Number.isSafeInteger(info.user_id)) cache.set('id:'+info.user_id, info);
          if (info.username) cache.set('name:'+normalize(info.username), info);
          // Server intentionally suppresses avatar_url when it is used by multiple users.
          if (info.avatar_url) cache.set('url:'+bareUrl(getUrl(info.avatar_url)), info);
        }
      } catch (err) {
        failed = true;
        console.warn('Pressboxd avatar effects lookup failed:', err);
      }
    }
    for (const c of batch) {
      const info = keyInfo(c);
      if (info !== undefined) apply(c,info);
    }
    inFlight = false;
    if (pending.size) schedule();
    // Do not alter avatars on failed requests; a subsequent page view retries.
    if (failed) return;
  }
  function scan(root=document) {
    if (!root?.querySelectorAll) return;
    const selector='img,.avatar_fallback,[class*="avatar"],[class*="Avatar"],[class*="pfp"]';
    const nodes = root.matches?.(selector)
      ? [root,...root.querySelectorAll(selector)] : root.querySelectorAll(selector);
    for (const el of nodes) {
      // Candidate selection eliminates non-photo containers, product previews,
      // and duplicate fallback+image pairs; don't decorate a whole user card.
      if (el.tagName !== 'IMG' && !el.matches('.avatar_fallback') &&
          el.querySelector('img,.avatar_fallback')) continue;
      addCandidate(el);
    }
  }
  let observerQueued=false;
  function deferredScan() {
    if (observerQueued) return;
    observerQueued=true;
    requestAnimationFrame(() => { observerQueued=false; scan(); });
  }
  const observer = new MutationObserver(changes => {
    if (changes.some(change => {
      if (change.type === 'childList') {
        return [...change.addedNodes].some(n => n.nodeType === 1 && !n.matches?.('.pb-global-avatar-fx'));
      }
      const el=change.target;
      if (el.matches?.('.pb-global-avatar-host,.pb-global-avatar-fx')) return false;
      return true;
    })) deferredScan();
  });
  document.addEventListener('toggle',e=>{ if (e.target?.tagName === 'DETAILS' && e.target.open) deferredScan(); },true);
  document.addEventListener('load',e=>{ if (e.target?.tagName === 'IMG') addCandidate(e.target); },true);
  // Covers dropdowns, lazy cards and tabs that reveal already-rendered avatars.
  document.addEventListener('click',()=>{ setTimeout(deferredScan,30); },true);
  window.addEventListener('pageshow',deferredScan);
  function start() {
    scan();
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,
      attributeFilter:['src','srcset','data-user-id','data-username','data-user-name','style','open','hidden']});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start,{once:true});
  else start();
})();

/* BEGIN PB_GLOBAL_NAMEPLATES_V18
 * Integrated into cosmetics-global.js. Uses the existing read-only cosmetics API.
 * Usernames are styled only when identity and equipped item are confirmed.
 * Works without a separate nameplates-global.js runtime file.
 */
(() => {
  'use strict';
  if (window.__pbIntegratedNameplatesV18) return;
  window.__pbIntegratedNameplatesV18 = true;

  const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
  const NAME_IDS = new Set(["name_electric","name_gold","name_rainbow","name_ember","name_glacier","name_jade","name_lavender","name_rosefire","name_chrome","name_ghost","name_neon","name_copper","name_sunset","name_ocean","name_celestial","name_static","name_fire","name_void","name_holographic","name_royalty","name_omnichrome"]);
  const CLASS_NAMES = ["pc-name_electric","pc-name_gold","pc-name_rainbow","pc-name_ember","pc-name_glacier","pc-name_jade","pc-name_lavender","pc-name_rosefire","pc-name_chrome","pc-name_ghost","pc-name_neon","pc-name_copper","pc-name_sunset","pc-name_ocean","pc-name_celestial","pc-name_static","pc-name_fire","pc-name_void","pc-name_holographic","pc-name_royalty","pc-name_omnichrome"];
  const AVOID = '.pc-name-sample,.pc2-product,.pc-product,.pc2-intro-preview,.pc-preview-avatar,' +
    '.pb-global-avatar-host,.pb-global-avatar-fx,.pb-cosmetic-avatar,' +
    'script,style,template,svg,button,option,input,textarea';
  const AUTHOR = '.username,.user-name,.user_name,.userName,.reviewuser,.review-user,' +
    '.comment-user,.commentUser,.commentAuthor,.comment-author,.forum-author,.forumAuthor,' +
    '.post-author,.postAuthor,.author-name,.authorName,.author,.userSearchName,' +
    '.userSearchUsername,.friendName,.friend-name,.leader-name,.leaderName,' +
    '.display-name,.profile_username_row h1';
  const ROWS = '.nav_user,.userSearchItem,.reviewcard,.reviewhead,.review-head,' +
    '.commentItem,.comment-item,.comment,.forum-post,.forumPost,.forum-reply,' +
    '.forumReply,.forumPost,.forum-post,.post,.post-card,.friend-row,.friendRow,' +
    '.friend-item,.leader-row,.leaderRow,.userrow,.user-row,.user-card,.userCard,' +
    '.member-card,.follower,.following,.top-user,.topUser,.friendRatingItem,' +
    '[data-user-id],[data-author-id],[data-username],[data-user-name],[data-author]';
  const norm = s => String(s || '').trim().replace(/^@/, '').toLowerCase();
  const validName = s => USER_RE.test(String(s || '').trim());
  const ownName = (() => {
    try { return norm(decodeURIComponent(document.querySelector('meta[name="pb-cosmetics-self"]')?.content || '')); }
    catch { return ''; }
  })();
  const ownId = Number(document.querySelector('meta[name="pb-cosmetics-self-id"]')?.content || 0);
  const cache = new Map();
  const pending = new Map();
  let scheduled = false;
  let fetching = false;
  let rerun = false;

  function linkName(a) {
    if (!a?.getAttribute) return '';
    try {
      const url = new URL(a.getAttribute('href'), location.href);
      if (url.origin !== location.origin) return '';
      if (/^\/me\/?$/.test(url.pathname)) return validName(ownName) ? ownName : '';
      const m = url.pathname.match(/^\/u\/([^/]+)(?:\/(?:ratings|followers|following))?\/?$/i);
      if (!m) return '';
      const value = decodeURIComponent(m[1]);
      return validName(value) ? norm(value) : '';
    } catch { return ''; }
  }
  function currentProfile() {
    if (/^\/me\/?$/.test(location.pathname)) return ownName;
    const m = location.pathname.match(/^\/u\/([^/]+)\/?$/i);
    if (!m) return '';
    try { const name = decodeURIComponent(m[1]); return validName(name) ? norm(name) : ''; }
    catch { return ''; }
  }
  function getDataIdentity(el) {
    if (!el?.getAttribute) return null;
    let node = el;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const name = node.getAttribute?.('data-username') ||
        node.getAttribute?.('data-user-name') || node.getAttribute?.('data-author') || '';
      const id = Number(node.getAttribute?.('data-user-id') ||
        node.getAttribute?.('data-author-id') || 0);
      if (validName(name)) return { name: norm(name), id: Number.isSafeInteger(id) && id > 0 ? id : 0 };
      if (Number.isSafeInteger(id) && id > 0) return { name: '', id };
      if (node.matches?.('a[href]')) {
        const fromLink = linkName(node);
        if (fromLink) return { name: fromLink, id: fromLink === ownName ? ownId : 0 };
      }
      if (node === document.body || node === document.querySelector('main')) break;
    }
    return null;
  }
  const keyFor = identity => identity.id ? 'id:' + identity.id : identity.name ? 'name:' + identity.name : identity.url ? 'url:' + identity.url : '';
  function queue(root, identity, kind) {
    if (!root?.isConnected || root.closest?.(AVOID)) return;
    if (!identity?.id && !identity?.name && !identity?.url) return;
    const key = keyFor(identity);
    if (!key) return;
    const list = pending.get(key) || [];
    if (!list.some(item => item.root === root && item.kind === kind)) list.push({ root, kind });
    pending.set(key, list);
    schedule();
  }
  function avatarUrl(row) {
    const img = row.querySelector('img[src]');
    if (!img) return '';
    const src = img.getAttribute('src') || '';
    const classContext = [img.className, img.parentElement?.className, img.getAttribute('alt')].join(' ');
    if (!/(avatar|pfp|userpic|author|member|profile)/i.test(classContext + ' ' + src)) return '';
    if (/^(data:|blob:|javascript:)/i.test(src)) return '';
    return src;
  }
  function scan(root = document) {
    if (!root?.querySelectorAll) return;
    const links = root.matches?.('a[href]') ? [root, ...root.querySelectorAll('a[href]')] : root.querySelectorAll('a[href]');
    for (const a of links) {
      const name = linkName(a);
      if (name) queue(a, { name, id: name === ownName ? ownId : 0 }, 'link');
    }
    if (currentProfile()) {
      const h = document.querySelector('.profile_username_row h1');
      if (h) queue(h, { name: currentProfile(), id: currentProfile() === ownName ? ownId : 0 }, 'heading');
    }
    const standalone = root.matches?.(AUTHOR) ? [root, ...root.querySelectorAll(AUTHOR)] : root.querySelectorAll(AUTHOR);
    for (const target of standalone) {
      if (target.closest?.('a[href]')) continue; // handled by exact owner link
      const identity = getDataIdentity(target);
      if (identity) queue(target, identity, 'author');
    }
    const rows = root.matches?.(ROWS) ? [root, ...root.querySelectorAll(ROWS)] : root.querySelectorAll(ROWS);
    for (const row of rows) {
      if (row.closest?.(AVOID)) continue;
      const explicit = getDataIdentity(row);
      if (explicit) { queue(row, explicit, 'row'); continue; }
      const linksInRow = new Set([...row.querySelectorAll('a[href]')].map(linkName).filter(Boolean));
      if (linksInRow.size === 1) {
        queue(row, { name: [...linksInRow][0], id: 0 }, 'row');
      } else if (linksInRow.size === 0) {
        // A unique avatar URL may identify the author when the name is not linked.
        // The server refuses ambiguous/default pictures. Validate the returned
        // username against the actual displayed text before adding any style.
        const url = avatarUrl(row);
        if (url) queue(row, { url }, 'row');
      }
    }
  }
  function escapedName(name) { return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function inScope(node, kind) {
    const el = node.parentElement;
    if (!el || el.closest(AVOID)) return false;
    if (el.closest('.pb-global-nameplate')) return false;
    // Row-level discovery must not color text in unrelated reviews or UI.
    // Only author/name fields or linked username tokens are eligible.
    if (kind === 'row' && !el.closest(AUTHOR) && !el.closest('a[href*="/u/"]') &&
      !el.closest('.nav_user,.userSearchItem')) return false;
    return true;
  }
  function decorate(container, username, nameplate, kind) {
    if (!container?.isConnected || !validName(username) || !NAME_IDS.has(nameplate)) return;
    if (container.closest?.(AVOID)) return;
    const matcher = new RegExp('(^|[^A-Za-z0-9_])(@?' + escapedName(username) + ')(?=$|[^A-Za-z0-9_])', 'i');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!inScope(node, kind)) continue;
      if (!matcher.test(node.nodeValue || '')) continue;
      matches.push(node);
      if (matches.length >= 10) break;
    }
    for (const textNode of matches) {
      if (!textNode.isConnected || !inScope(textNode, kind)) continue;
      const m = (textNode.nodeValue || '').match(matcher);
      if (!m) continue;
      const start = (m.index || 0) + m[1].length;
      const token = textNode.splitText(start);
      token.splitText(m[2].length);
      const span = document.createElement('span');
      span.className = 'pb-global-nameplate pc-' + nameplate;
      span.textContent = token.nodeValue;
      token.replaceWith(span);
    }
  }
  async function flush() {
    scheduled = false;
    if (fetching) { rerun = true; return; }
    fetching = true;
    const jobs = [...pending.entries()];
    pending.clear();
    try {
      const unknown = jobs.map(([key]) => key).filter(key => !cache.has(key));
      for (let start = 0; start < unknown.length; start += 100) {
        const keys = unknown.slice(start, start + 100);
        const usernames = keys.filter(k => k.startsWith('name:')).map(k => k.slice(5));
        const user_ids = keys.filter(k => k.startsWith('id:')).map(k => Number(k.slice(3)));
        const avatar_urls = keys.filter(k => k.startsWith('url:')).map(k => k.slice(4));
        try {
          const response = await fetch('/api/cosmetics/avatar-effects', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ usernames, user_ids, avatar_urls })
          });
          if (!response.ok) throw new Error('nameplates API HTTP ' + response.status);
          const json = await response.json();
          for (const key of keys) cache.set(key, null);
          for (const item of json.users || []) {
            if (item?.user_id) cache.set('id:' + item.user_id, item);
            if (validName(item?.username)) cache.set('name:' + norm(item.username), item);
            if (item?.avatar_url) {
              // Both relative and absolute forms are accepted by the same API.
              cache.set('url:' + item.avatar_url, item);
            }
          }
        } catch (error) {
          console.warn('Pressboxd nameplates:', error);
          // Failed lookups are not cached; later DOM updates can retry.
        }
      }
      for (const [key, targets] of jobs) {
        const result = cache.get(key);
        if (!result?.username || !NAME_IDS.has(result.nameplate)) continue;
        // Username is always validated against the rendered text, never inferred
        // from another person's portrait or a shared avatar placeholder.
        for (const {root,kind} of targets) decorate(root, result.username, result.nameplate, kind);
      }
    } finally {
      fetching = false;
      if (pending.size || rerun) { rerun = false; schedule(); }
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush, 100);
  }
  let observerQueued = false;
  function deferredScan() {
    if (observerQueued) return;
    observerQueued = true;
    requestAnimationFrame(() => { observerQueued = false; scan(); });
  }
  const observer = new MutationObserver(changes => {
    if (changes.some(change => change.type === 'childList'
      ? [...change.addedNodes].some(n => n.nodeType === 1 && !n.matches?.('.pb-global-nameplate,.pb-global-avatar-fx'))
      : true)) deferredScan();
  });
  function start() {
    scan();
    observer.observe(document.body, {subtree:true,childList:true,attributes:true,
      attributeFilter:['href','data-username','data-user-name','data-user-id','data-author','data-author-id']});
  }
  document.addEventListener('click', () => setTimeout(deferredScan, 30), true);
  window.addEventListener('pageshow', deferredScan);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
/* END PB_GLOBAL_NAMEPLATES_V18 */

