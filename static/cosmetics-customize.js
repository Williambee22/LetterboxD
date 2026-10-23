(() => {
  'use strict';
  const dataNode = document.getElementById('pb-cosmetics-customize-data');
  if (!dataNode) return;
  let options;
  try { options = JSON.parse(dataNode.textContent); } catch { return; }
  const main = document.querySelector('main') || document.body;
  const link = document.createElement('a');
  link.href = '/store';
  link.textContent = '💎 Open GEM Store';
  link.className = 'pb-cosmetic-store-link';
  const inventory = document.createElement('a');
  inventory.href = '/me/cosmetics';
  inventory.textContent = '✦ My Cosmetics';
  inventory.className = 'pb-cosmetic-store-link';
  main.insertBefore(inventory,main.firstChild);
  main.insertBefore(link,main.firstChild);
  const file = document.querySelector('input[type="file"][name="pfp_file"]');
  if (file) {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:12px;color:#b7b6c9;margin:8px 0 12px';
    if (options.gifUnlocked) {
      file.accept = 'image/png,image/jpeg,image/webp,image/gif,.gif';
      note.textContent = '💎 Animated Avatar unlocked! You can now upload .gif files up to 5 MB.';
    } else {
      note.innerHTML = 'Animated GIF avatars require the <a href="/store#special" style="color:#cfadff">Animated Avatar Upload</a> unlock.';
    }
    file.insertAdjacentElement('afterend',note);
  }
})();
