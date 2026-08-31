(() => {
  const cap = window.Capacitor;
  const isNative = !!(
    cap &&
    typeof cap.isNativePlatform === 'function' &&
    cap.isNativePlatform()
  );

  if (!isNative) return;

  const html = document.documentElement;
  const body = document.body;

  html.classList.add('native-capacitor');
  body.classList.add('native-capacitor');

  const plugins = cap.Plugins || {};
  const App = plugins.App;
  const Browser = plugins.Browser;
  const Haptics = plugins.Haptics;
  const Network = plugins.Network;
  const Share = plugins.Share;
  const StatusBar = plugins.StatusBar;

  const path = window.location.pathname;

  function routeInfo() {
    if (path === '/' || path === '/shows') {
      return { key: 'shows', title: 'Shows', root: true, fallback: '/shows' };
    }

    if (path.startsWith('/show/')) {
      return { key: 'show', title: 'Show', root: false, fallback: '/shows' };
    }

    if (path === '/top') {
      return { key: 'top', title: 'Top Shows', root: true, fallback: '/top' };
    }

    if (path === '/top_users') {
      return { key: 'top', title: 'Top Users', root: true, fallback: '/top' };
    }

    if (path.startsWith('/predictions')) {
      return {
        key: 'predictions',
        title: 'Predictions',
        root: path === '/predictions',
        fallback: '/predictions'
      };
    }

    if (path.startsWith('/forums')) {
      return {
        key: 'forums',
        title: 'Forums',
        root: path === '/forums',
        fallback: '/forums'
      };
    }

    if (path === '/me' || path.startsWith('/me/')) {
      return {
        key: 'profile',
        title: 'Profile',
        root: path === '/me',
        fallback: '/me'
      };
    }

    if (path.startsWith('/u/')) {
      return { key: 'profile', title: 'Profile', root: false, fallback: '/shows' };
    }

    if (path.startsWith('/tierlists')) {
      return { key: 'other', title: 'Tier Lists', root: false, fallback: '/shows' };
    }

    if (path.startsWith('/login')) {
      return { key: 'other', title: 'Log In', root: false, fallback: '/shows' };
    }

    if (path.startsWith('/register')) {
      return { key: 'other', title: 'Create Account', root: false, fallback: '/shows' };
    }

    return {
      key: 'other',
      title: document.title?.replace(/\s*[-|]\s*Pressboxd.*$/i, '') || 'Pressboxd',
      root: false,
      fallback: '/shows'
    };
  }

  const route = routeInfo();
  html.classList.add(`native-route-${route.key}`);
  body.classList.add(`native-route-${route.key}`);

  try {
    StatusBar?.setBackgroundColor?.({ color: '#14181c' });
    StatusBar?.setOverlaysWebView?.({ overlay: false });
  } catch (_) {}

  const icons = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="M8 8l4-4 4 4"/><path d="M5 12v7h14v-7"/></svg>',
    shows: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>',
    top: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 01-10 0V4z"/><path d="M7 6H4v2a4 4 0 004 4M17 6h3v2a4 4 0 01-4 4"/></svg>',
    predict: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/><path d="M4 7l6-4 6 6 5-5"/></svg>',
    forums: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5z"/><path d="M8 9h8M8 12h5"/></svg>',
    me: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>'
  };

  function haptic() {
    try {
      Haptics?.impact?.({ style: 'LIGHT' });
    } catch (_) {}
  }

  function goBack() {
    haptic();

    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    window.location.href = route.fallback || '/shows';
  }

  async function shareCurrentPage() {
    haptic();

    try {
      if (Share?.share) {
        await Share.share({
          title: document.title || 'Pressboxd',
          text: document.title || 'Pressboxd',
          url: window.location.href,
          dialogTitle: 'Share from Pressboxd'
        });
      }
    } catch (_) {}
  }

  function shouldShowShare() {
    return (
      route.key === 'show' ||
      route.key === 'profile' ||
      path.startsWith('/forums/topic/')
    );
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function tab(href, key, label, icon, active) {
    const activeClass = key === active ? ' active' : '';
    return `<a href="${href}" class="${activeClass.trim()}" data-native-tab="${key}">${icon}<span>${label}</span></a>`;
  }

  /* ---------------------------------------------------------
     APP HEADER
     --------------------------------------------------------- */
  const header = document.createElement('header');
  header.className = 'native-app-header';
  header.id = 'nativeAppHeader';
  header.innerHTML = `
    <div class="native-header-leading">
      ${
        route.root
          ? ''
          : `<button type="button" class="native-icon-btn" id="nativeBackBtn" aria-label="Back">${icons.back}</button>`
      }
    </div>

    <div class="native-header-center">
      <a class="native-wordmark" href="/shows" aria-label="Pressboxd">
        <img
          src="/static/pressboxd-wordmark.png"
          alt="Pressboxd"
          class="native-wordmark-img"
        >
      </a>
      <div class="native-page-title">${escapeHtml(route.title)}</div>
    </div>

    <div class="native-header-actions" id="nativeHeaderActions">
      ${
        shouldShowShare()
          ? `<button type="button" class="native-icon-btn" id="nativeShareBtn" aria-label="Share">${icons.share}</button>`
          : ''
      }
    </div>
  `;

  body.prepend(header);

  const existingBell = document.querySelector('.topbar .notifWrap');
  const headerActions = document.getElementById('nativeHeaderActions');

  if (existingBell && headerActions) {
    headerActions.prepend(existingBell);
  }

  document.getElementById('nativeBackBtn')?.addEventListener('click', goBack);
  document.getElementById('nativeShareBtn')?.addEventListener('click', shareCurrentPage);

  /* ---------------------------------------------------------
     BOTTOM TABS
     --------------------------------------------------------- */
  const activeTab =
    route.key === 'show'
      ? 'shows'
      : route.key === 'profile'
        ? 'me'
        : route.key;

  const nav = document.createElement('nav');
  nav.className = 'native-bottom-nav';
  nav.id = 'nativeBottomNav';
  nav.setAttribute('aria-label', 'Pressboxd app navigation');
  nav.innerHTML = `
    ${tab('/shows', 'shows', 'Shows', icons.shows, activeTab)}
    ${tab('/top', 'top', 'Top', icons.top, activeTab)}
    ${tab('/predictions', 'predictions', 'Predict', icons.predict, activeTab)}
    ${tab('/forums', 'forums', 'Forums', icons.forums, activeTab)}
    ${tab('/me', 'me', 'Me', icons.me, activeTab)}
  `;

  body.appendChild(nav);

  nav.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', haptic, { passive: true });
  });

  /* ---------------------------------------------------------
     OFFLINE BANNER
     --------------------------------------------------------- */
  const offline = document.createElement('div');
  offline.id = 'nativeOfflineBanner';
  offline.className = 'native-offline-banner';
  offline.textContent = 'Offline — some Pressboxd features may not load.';
  body.appendChild(offline);

  const renderNetwork = (status) => {
    offline.classList.toggle('show', status?.connected === false);
  };

  if (Network) {
    try {
      Network.getStatus?.().then(renderNetwork).catch(() => {});
      Network.addListener?.('networkStatusChange', renderNetwork);
    } catch (_) {}
  }

  /* ---------------------------------------------------------
     SHOWS FILTER DRAWER
     --------------------------------------------------------- */
  const filterForm = document.getElementById('showsFilterForm');

  if (filterForm) {
    filterForm.classList.add('native-collapsible');

    const hasFilters = window.location.search.length > 1;
    if (hasFilters) filterForm.classList.add('is-open');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'native-filter-toggle';
    toggle.innerHTML = `
      <span>FILTERS &amp; SORTING</span>
      <span aria-hidden="true">${hasFilters ? '−' : '+'}</span>
    `;

    filterForm.parentNode.insertBefore(toggle, filterForm);

    toggle.addEventListener('click', () => {
      haptic();
      const open = filterForm.classList.toggle('is-open');
      toggle.lastElementChild.textContent = open ? '−' : '+';
    });
  }

  /* ---------------------------------------------------------
     APP-ONLY PAGE LABELS
     --------------------------------------------------------- */
  function addSectionLabel(target, text) {
    if (!target || target.previousElementSibling?.classList?.contains('native-section-label')) return;

    const label = document.createElement('div');
    label.className = 'native-section-label';
    label.textContent = text;
    target.parentNode.insertBefore(label, target);
  }

  if (route.key === 'shows') {
    const grid = document.querySelector('.postergrid');
    addSectionLabel(grid, 'ALL SHOWS');
  }

  if (route.key === 'show') {
    const reviews = document.querySelector('.reviewsSection');
    addSectionLabel(reviews, 'REVIEWS');
  }

  if (route.key === 'profile') {
    const ratings = document.querySelector('.profile_ratings_panel');
    const reviews = document.querySelector('.profile_reviews_panel');
    addSectionLabel(ratings, 'RATINGS');
    addSectionLabel(reviews, 'REVIEWS');
  }

  /* ---------------------------------------------------------
     EXTERNAL LINKS
     --------------------------------------------------------- */
  document.addEventListener(
    'click',
    async (event) => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.hasAttribute('download')) return;

      let url;

      try {
        url = new URL(anchor.href, window.location.href);
      } catch (_) {
        return;
      }

      if (!['http:', 'https:'].includes(url.protocol)) return;

      const host = url.hostname.toLowerCase();
      const internal = host === 'pressboxd.com' || host === 'www.pressboxd.com';

      if (internal || !Browser?.open) return;

      event.preventDefault();

      try {
        await Browser.open({ url: url.href });
      } catch (_) {
        window.location.href = url.href;
      }
    },
    true
  );

  /* ---------------------------------------------------------
     ANDROID HARDWARE BACK
     --------------------------------------------------------- */
  if (App?.addListener) {
    try {
      App.addListener('backButton', ({ canGoBack }) => {
        if (!route.root || canGoBack) {
          goBack();
        } else {
          App.exitApp?.();
        }
      });
    } catch (_) {}
  }
})();
