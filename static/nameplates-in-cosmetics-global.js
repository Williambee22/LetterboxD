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
  const NAME_IDS = new Set(['name_electric', 'name_gold', 'name_rainbow']);
  const CLASS_NAMES = ['pc-name_electric', 'pc-name_gold', 'pc-name_rainbow'];
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
