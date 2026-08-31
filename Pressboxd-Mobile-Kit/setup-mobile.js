const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const kitRoot = __dirname;

const required = [
  path.join(repoRoot, 'app.js'),
  path.join(repoRoot, 'templates', 'base.ejs'),
  path.join(repoRoot, 'static')
];

for (const p of required) {
  if (!fs.existsSync(p)) {
    console.error(`Missing expected Pressboxd path: ${p}`);
    console.error('Run this script from the ROOT of your LetterboxD repository.');
    process.exit(1);
  }
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${path.relative(repoRoot, dest)}`);
}

// 1) Copy standalone mobile project.
const mobileSrc = path.join(kitRoot, 'mobile');
const mobileDest = path.join(repoRoot, 'mobile');
fs.cpSync(mobileSrc, mobileDest, { recursive: true, force: true });
console.log('Copied: mobile/');

// 2) Copy app-only website assets.
copy(
  path.join(kitRoot, 'website-additions', 'static', 'mobile-app.css'),
  path.join(repoRoot, 'static', 'mobile-app.css')
);
copy(
  path.join(kitRoot, 'website-additions', 'static', 'mobile-app.js'),
  path.join(repoRoot, 'static', 'mobile-app.js')
);

// 3) Patch shared EJS layout safely and idempotently.
const basePath = path.join(repoRoot, 'templates', 'base.ejs');
const backupPath = basePath + '.before-mobile.bak';
let base = fs.readFileSync(basePath, 'utf8');

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(basePath, backupPath);
  console.log('Backup: templates/base.ejs.before-mobile.bak');
}

// viewport-fit=cover is required for iPhone safe areas.
base = base.replace(
  /<meta name="viewport" content="width=device-width,initial-scale=1"\s*\/>/,
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>'
);

if (!base.includes('/static/mobile-app.css')) {
  const anchor = '<link rel="stylesheet" href="/static/styles.css">';
  if (!base.includes(anchor)) throw new Error('Could not find styles.css link in templates/base.ejs');
  base = base.replace(
    anchor,
    `${anchor}\r\n  <link rel="stylesheet" href="/static/mobile-app.css">\r\n  <meta name="theme-color" content="#000000">`
  );
}

if (!base.includes('id="nativeBottomNav"')) {
  const footerAnchor = '  <footer class="wrap footer">';
  if (!base.includes(footerAnchor)) throw new Error('Could not find footer anchor in templates/base.ejs');

  const nativeUi = `  <div id="nativeOfflineBanner" class="native-offline-banner" role="status">You are offline. Some Pressboxd features may be unavailable.</div>\r\n\r\n  <button id="nativeShareButton" class="native-share-fab" type="button" aria-label="Share this page" title="Share">\r\n    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m0 0 4 4m-4-4-4 4"/><path d="M5 12v7h14v-7"/></svg>\r\n  </button>\r\n\r\n  <nav id="nativeBottomNav" class="native-bottom-nav" aria-label="App navigation">\r\n    <a href="/shows" data-native-tab="shows">\r\n      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M8 3v4M16 3v4M4 9h16"/></svg>\r\n      <span>Shows</span>\r\n    </a>\r\n    <a href="/top" data-native-tab="top">\r\n      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>\r\n      <span>Top</span>\r\n    </a>\r\n    <a href="/predictions" data-native-tab="predictions">\r\n      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M22 19V3"/></svg>\r\n      <span>Predict</span>\r\n    </a>\r\n    <a href="/forums" data-native-tab="forums">\r\n      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>\r\n      <span>Forums</span>\r\n    </a>\r\n    <a href="<%= meUser ? '/me' : '/login' %>" data-native-tab="me">\r\n      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4-6 8-6s6.8 2 8 6"/></svg>\r\n      <span>Me</span>\r\n    </a>\r\n  </nav>\r\n\r\n`;

  base = base.replace(footerAnchor, nativeUi + footerAnchor);
}

if (!base.includes('/static/mobile-app.js')) {
  const scriptAnchor = '</body>';
  if (!base.includes(scriptAnchor)) throw new Error('Could not find </body> in templates/base.ejs');
  base = base.replace(
    scriptAnchor,
    '  <script src="/static/mobile-app.js"></script>\r\n' + scriptAnchor
  );
}

fs.writeFileSync(basePath, base, 'utf8');
console.log('Patched: templates/base.ejs');

console.log('\nDone. Next:');
console.log('  1) git diff');
console.log('  2) deploy the website changes to Railway');
console.log('  3) cd mobile');
console.log('  4) npm install');
console.log('  5) npm run add:android');
console.log('  6) npm run sync');
console.log('  7) npm run open:android');
