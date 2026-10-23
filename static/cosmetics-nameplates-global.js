/* Pressboxd nameplate cosmetics v17.
   Styles only confirmed, equipped usernames on the entire site.
   Does not modify avatar frames, motion, wallet balances, or profile banners. */
(() => {
  'use strict';
  if (window.__pbGlobalNameplatesV17) return;
  window.__pbGlobalNameplatesV17 = true;

  const USER_RE = /^[a-z0-9_]{3,20}$/i;
  const IDS = new Set(['name_electric', 'name_gold', 'name_rainbow']);
  const CLASSES = ['pc-name_electric', 'pc-name_gold', 'pc-name_rainbow'];
  const NAME_SELECTORS = [
    '.username', '.user-name', '.user_name', '.userName', '.reviewuser',
    '.review-user', '.comment-user', '.commentUser', '.forum-author',
    '.forumAuthor', '.post-author', '.postAuthor', '.author-name',
    '.authorName', '.leader-name', '.leaderName', '.userSearchName',
    '.userSearchUsername', '.friendName', '.friend-name',
    '[data-username]', '[data-user-name]', '[data-author]'
  ].join(',');
  const ROW_SELECTOR = [
    '.reviewcard', '.reviewhead', '.commentItem', '.comment-item',
    '.forum-post', '.forumPost', '.forum-reply', '.friend-row', '.friendRow',
    '.leaderRow', '.leader-row', '.user-row', '.userrow', '.userSearchItem',
    '.member-card', '.follower', '.following', '.top-user', '.topUser',
    '[data-user-id]', '[data-author-id]', '[data-username]', '[data-user-name]',
    'article', 'li', 'tr'
  ].join(',');
  const AVOID = '.pc-name-sample,.pc2-product,.pc-product,' +
    '.pb-global-avatar-host,.pb-cosmetic-avatar,.pb-global-avatar-fx,' +
    '.pc-preview-avatar,script,style,template';
  const OWN_NAME = (() => {
    try { return decodeURIComponent(document.querySelector('meta[name="pb-cosmetics-self"]')?.content || '').toLowerCase(); }
    catch { return ''; }
  })();
  const OWN_ID = Number(document.querySelector('meta[name="pb-cosmetics-self-id"]')?.content || 0);
  const normalize = s => String(s || '').trim().toLowerCase();
  const textName = s => normalize(s).replace(/^@/, '');
  const cache = new Map();
  const pending = new Map();
  const applied = new WeakMap();
  let timer = null;
  let busy = false;
  let retry = false;

  function profileName(a) {
    if (!a?.getAttribute) return '';
    try {
      const url = new URL(a.getAttribute('href'), location.href);
      if (url.origin !== location.origin) return '';
      if (/^\/me\/?$/.test(url.pathname)) return USER_RE.test(OWN_NAME) ? OWN_NAME : '';
      const match = url.pathname.match(/^\/u\/([^/]+)(?:\/(?:ratings|followers|following))?\/?$/i);
      if (!match) return '';
      const name = decodeURIComponent(match[1]);
      return USER_RE.test(name) ? normalize(name) : '';
    } catch { return ''; }
  }
  function pageName() {
    if (/^\/me\/?$/.test(location.pathname)) return OWN_NAME;
    const m = location.pathname.match(/^\/u\/([^/]+)\/?$/i);
    if (!m) return '';
    try { const s = decodeURIComponent(m[1]); return USER_RE.test(s) ? normalize(s) : ''; }
    catch { return ''; }
  }
  function identityFromElement(el) {
    // Never attribute all usernames inside a multi-user section to one account.
    for (let p = el, depth = 0; p && depth < 5; p = p.parentElement, depth++) {
      const n = p.getAttribute?.('data-username') || p.getAttribute?.('data-user-name') || p.getAttribute?.('data-author');
      const id = Number(p.getAttribute?.('data-user-id') || p.getAttribute?.('data-author-id') || 0);
      if (USER_RE.test(n || '')) return { name: normalize(n), id: Number.isSafeInteger(id) && id > 0 ? id : 0 };
      if (Number.isSafeInteger(id) && id > 0) return { name: '', id };
      if (p.matches?.('a[href]')) {
        const name = profileName(p);
        if (name) return { name, id: name === OWN_NAME ? OWN_ID : 0 };
      }
      if (p.matches?.(ROW_SELECTOR)) {
        const names = [...new Set([...p.querySelectorAll('a[href]')].map(profileName).filter(Boolean))];
        if (names.length === 1) return { name: names[0], id: names[0] === OWN_NAME ? OWN_ID : 0 };
        break;
      }
      if (p.tagName === 'BODY' || p.tagName === 'MAIN') break;
    }
    return { name: '', id: 0 };
  }
  function eligible(el) {
    return el?.isConnected && !el.closest(AVOID) && !el.matches?.('.pb-cosmetic-heading');
  }
  function leafTargets(container, name) {
    // Find text spans inside a linked avatar+name, rather than tinting its image.
    if (!eligible(container)) return [];
    const targets = [];
    for (const el of container.querySelectorAll('span,b,strong,small,em,h1,h2,h3,label')) {
      if (!eligible(el) || textName(el.textContent) !== name) continue;
      const nested = [...el.querySelectorAll('span,b,strong,small,em,h1,h2,h3,label')]
        .some(x => textName(x.textContent) === name);
      if (!nested) targets.push(el);
      if (targets.length >= 6) break;
    }
    if (targets.length) return targets;
    if (textName(container.textContent) !== name) return [];

    // For mixed image/text anchors, wrap only the text node; preserve the image.
    if (container.querySelector('img,svg,picture,.avatar_sm,.avatar_lg')) {
      for (const child of [...container.childNodes]) {
        if (child.nodeType !== 3 || textName(child.textContent) !== name) continue;
        const span = document.createElement('span');
        span.textContent = child.textContent;
        child.replaceWith(span);
        return [span];
      }
      return [];
    }
    return [container];
  }
  function add(target, identity) {
    if (!eligible(target)) return;
    if (!identity.name && !identity.id) return;
    // A name provided alongside a known ID must equal the rendered text.
    if (identity.name && textName(target.textContent) !== identity.name) return;
    // Never use generic descriptive text (e.g. 'See followers') as a username.
    if (!identity.name && !USER_RE.test(textName(target.textContent))) return;
    const key = identity.id ? 'id:' + identity.id : 'name:' + identity.name;
    const existing = applied.get(target);
    if (existing?.key === key) return;
    pending.set(target, { target, key, identity });
    schedule();
  }
  function scan(root = document) {
    if (!root?.querySelectorAll) return;
    const selectors = 'a[href], ' + NAME_SELECTORS + ', .profile_username_row h1';
    const matches = root.matches?.(selectors) ? [root, ...root.querySelectorAll(selectors)] : root.querySelectorAll(selectors);
    for (const el of matches) {
      if (!eligible(el)) continue;
      if (el.matches('a[href]')) {
        const name = profileName(el);
        if (!name) continue;
        for (const target of leafTargets(el, name)) add(target, { name, id: name === OWN_NAME ? OWN_ID : 0 });
        continue;
      }
      if (el.matches('.profile_username_row h1')) {
        const name = pageName();
        if (name && textName(el.textContent) === name) add(el, { name, id: name === OWN_NAME ? OWN_ID : 0 });
        continue;
      }
      const identity = identityFromElement(el);
      const name = identity.name || (USER_RE.test(textName(el.textContent)) ? textName(el.textContent) : '');
      if (!name || !identity.id && !identity.name) continue;
      for (const target of leafTargets(el, name)) add(target, identity);
    }
  }
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(flush, 110);
  }
  function apply(target, key, item) {
    if (!target.isConnected) return;
    const plate = IDS.has(item?.nameplate) ? item.nameplate : '';
    const previous = applied.get(target);
    if (previous?.key === key && previous.plate === plate) return;
    target.classList.remove('pb-global-nameplate', ...CLASSES);
    if (plate) target.classList.add('pb-global-nameplate', 'pc-' + plate);
    applied.set(target, { key, plate });
  }
  async function flush() {
    timer = null;
    if (busy) { retry = true; return; }
    busy = true;
    const batch = [...pending.values()].filter(x => x.target.isConnected);
    pending.clear();
    try {
      if (!batch.length) return;
      const unknown = batch.filter(x => !cache.has(x.key));
      const ids = [...new Set(unknown.map(x => x.identity.id).filter(Boolean))];
      const usernames = [...new Set(unknown.filter(x => !x.identity.id).map(x => x.identity.name).filter(Boolean))];
      const calls = Math.max(Math.ceil(ids.length / 100), Math.ceil(usernames.length / 100));
      for (let i = 0; i < calls; i++) {
        const partIds = ids.slice(i*100, (i+1)*100);
        const partNames = usernames.slice(i*100, (i+1)*100);
        try {
          const response = await fetch('/api/cosmetics/avatar-effects', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ user_ids: partIds, usernames: partNames, avatar_urls: [] })
          });
          if (!response.ok) throw new Error('nameplate lookup HTTP ' + response.status);
          const data = await response.json();
          for (const id of partIds) cache.set('id:' + id, {});
          for (const name of partNames) cache.set('name:' + name, {});
          for (const user of data.users || []) {
            if (Number.isSafeInteger(user.user_id)) cache.set('id:' + user.user_id, user);
            if (USER_RE.test(user.username || '')) cache.set('name:' + normalize(user.username), user);
          }
        } catch (err) {
          console.warn('Pressboxd nameplates lookup:', err);
          // Failed keys are not cached: reload or future DOM updates can retry.
        }
      }
      for (const { target, key } of batch) {
        if (cache.has(key)) apply(target, key, cache.get(key));
      }
    } finally {
      busy = false;
      if (pending.size || retry) { retry = false; schedule(); }
    }
  }
  let queued = false;
  function deferredScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }
  const observer = new MutationObserver(changes => {
    if (changes.some(change => change.type === 'childList'
      ? [...change.addedNodes].some(n => n.nodeType === 1 && !n.matches?.('.pb-global-avatar-fx'))
      : !change.target.matches?.('.pb-global-nameplate'))) deferredScan();
  });
  function start() {
    scan();
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['href','data-username','data-user-name','data-user-id','data-author','data-author-id'] });
  }
  document.addEventListener('click', () => setTimeout(deferredScan, 40), true);
  window.addEventListener('pageshow', deferredScan);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
