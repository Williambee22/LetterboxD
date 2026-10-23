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
    frame: /^(frame_sapphire|frame_rose|frame_inferno|frame_gold|frame_aurora|frame_prism)$/,
    motion: /^(motion_float|motion_pulse|motion_wobble)$/,
    background: /^(profile_night|profile_galaxy|profile_sunset)$/,
    nameplate: /^(name_electric|name_gold|name_rainbow)$/
  };
  for (const [kind,re] of Object.entries(allowed)) {
    if (!re.test(equipped[kind] || '')) equipped[kind] = null;
  }
  const username = String(data.username || '').trim();
  const heading = Array.from(main.querySelectorAll('h1')).find(h => h.textContent.trim().toLowerCase().includes(username.toLowerCase())) || main.querySelector('h1');
  if (heading) {
    if (equipped.nameplate) heading.classList.add('pb-cosmetic-heading','pc-'+equipped.nameplate);
    const store = document.createElement('a');
    store.className = 'pb-cosmetic-store-link';
    store.href = '/store';
    store.textContent = '💎 GEM Store';
    const links = [store];
    if (data.isMe) {
      const collection = document.createElement('a');
      collection.href = '/me/cosmetics';
      collection.className = 'pb-cosmetic-store-link';
      collection.textContent = '✦ My Cosmetics';
      links.push(collection);
    }
    const wrap = document.createElement('div');
    for (const link of links) wrap.appendChild(link);
    heading.insertAdjacentElement('afterend',wrap);
  }
  if (equipped.background) {
    // Keep the existing user-uploaded banner: add a compact separate atmosphere strip.
    const surface = document.createElement('div');
    surface.className = 'pb-profile-cosmetic-surface pc-'+equipped.background;
    surface.setAttribute('aria-hidden','true');
    main.insertBefore(surface,main.firstChild);
  }
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
