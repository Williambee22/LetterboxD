/* Enhances the currently displayed Pressboxd profile. No wallet writes. */
(() => {
  'use strict';
  const dataNode = document.getElementById('pb-cosmetics-profile-data');
  if (!dataNode) return;
  let data;
  try { data = JSON.parse(dataNode.textContent); } catch { return; }
  if (!data || typeof data !== 'object') return;
  const main = document.querySelector('main');
  if (!main) return;
  const equipped = data.equipped || {};
  const allowed = {
    frame: /^frame_[a-z_]+$/,
    motion: /^motion_[a-z_]+$/,
    nameplate: /^name_[a-z_]+$/
  };
  for (const [kind,re] of Object.entries(allowed)) {
    if (!re.test(equipped[kind] || '')) equipped[kind] = null;
  }
  const username = String(data.username || '').trim();
  const heading = Array.from(main.querySelectorAll('h1')).find(h => h.textContent.trim().toLowerCase().includes(username.toLowerCase())) || main.querySelector('h1');
  if (heading && equipped.nameplate) {
    heading.classList.add('pb-cosmetic-heading', 'pc-' + equipped.nameplate);
  }

  // Put the cosmetics controls beside Followers / Following, not below the
  // profile name. Using the native profile action row keeps the layout familiar.
  const actions = main.querySelector('.profile_top_actions.profile_counts') ||
    main.querySelector('.profile_top_actions');
  const links = document.createElement('div');
  links.className = 'pb-cosmetic-profile-actions';
  const store = document.createElement('a');
  store.className = 'pb-cosmetic-store-link';
  store.href = '/store';
  store.textContent = 'GEM Store';
  links.appendChild(store);
  if (data.isMe) {
    const collection = document.createElement('a');
    collection.href = '/me/cosmetics';
    collection.className = 'pb-cosmetic-store-link';
    collection.textContent = 'My Cosmetics';
    links.appendChild(collection);
  }
  // An older or customized profile template may omit .profile_top_actions.
  // Fall back to a single inline row rather than creating floating panels.
  if (actions) actions.appendChild(links);
  else if (heading) heading.insertAdjacentElement('afterend', links);

  if (!equipped.frame && !equipped.motion) return;
  const images = [...main.querySelectorAll('img')].filter(img => !img.closest('nav,footer'));
  if (!images.length) return;
  let pic = null;
  if (data.avatar_url) {
    try {
      const avatar = new URL(data.avatar_url,location.origin).pathname;
      pic = images.find(img => {
        try { return new URL(img.currentSrc || img.src,location.origin).pathname === avatar; } catch { return false; }
      });
    } catch { /* Fall back to class names. */ }
  }
  if (!pic) {
    pic = images.find(img => /avatar|profile.*(?:picture|photo|pic)|(?:pfp)/i.test((img.className || '')+' '+(img.parentElement?.className || '')+' '+(img.closest('[class]')?.className || '')));
  }
  if (!pic) return;
  // Only decorate the main profile's avatar, not every thumbnail or poster.
  const rect = pic.getBoundingClientRect();
  if (rect.width < 36 || rect.height < 36) return;
  const shell = document.createElement('span');
  shell.className = 'pb-cosmetic-avatar'+(equipped.frame?' pc-'+equipped.frame:'')+(equipped.motion?' pc-'+equipped.motion:'');
  const size = Math.min(Math.max(rect.width,36),320);
  shell.style.width = size+'px';
  shell.style.height = size+'px';
  // Retain the image if the original page has more elements inside its old wrapper.
  pic.parentNode.insertBefore(shell,pic);
  shell.appendChild(pic);
  // Small pre-existing avatar holders may use overflow:hidden to crop the
  // photograph. Allow the newly added halo to bleed into its surroundings,
  // but do not change large profile panels or the user's banner.
  let host = shell.parentElement;
  for (let depth = 0; host && depth < 2; depth++, host = host.parentElement) {
    const bounds = host.getBoundingClientRect();
    if (bounds.width > size + 44 || bounds.height > size + 44) break;
    host.classList.add('pb-cosmetic-avatar-host');
  }
})();
