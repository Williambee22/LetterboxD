(() => {
  const cap = window.Capacitor;
  const isNative = !!(
    cap &&
    typeof cap.isNativePlatform === 'function' &&
    cap.isNativePlatform()
  );

  if (!isNative) return;

  document.documentElement.classList.add('native-capacitor');
  document.body.classList.add('native-capacitor');

  const plugins = cap.Plugins || {};
  const App = plugins.App;
  const Browser = plugins.Browser;
  const Haptics = plugins.Haptics;
  const Network = plugins.Network;
  const Share = plugins.Share;
  const StatusBar = plugins.StatusBar;

  // Make the native status bar match Pressboxd's black UI.
  if (StatusBar) {
    StatusBar.setBackgroundColor?.({ color: '#000000' }).catch?.(() => {});
    StatusBar.setOverlaysWebView?.({ overlay: false }).catch?.(() => {});
  }

  // Highlight the correct native tab from the current Express route.
  const path = window.location.pathname;
  const rules = [
    { tab: 'shows', active: path === '/shows' || path.startsWith('/show/') },
    { tab: 'top', active: path === '/top' || path === '/top_users' },
    { tab: 'predictions', active: path.startsWith('/predictions') },
    { tab: 'forums', active: path.startsWith('/forums') },
    { tab: 'me', active: path === '/me' || path.startsWith('/me/') }
  ];

  for (const rule of rules) {
    if (!rule.active) continue;
    document.querySelector(`[data-native-tab="${rule.tab}"]`)?.classList.add('active');
  }

  // Light haptic feedback on native app controls.
  const haptic = () => {
    if (!Haptics?.impact) return;
    Haptics.impact({ style: 'LIGHT' }).catch(() => {});
  };

  document.querySelectorAll('.native-bottom-nav a, .native-share-fab').forEach((el) => {
    el.addEventListener('click', haptic, { passive: true });
  });

  // Native share sheet for the page the user is currently viewing.
  const shareButton = document.getElementById('nativeShareButton');
  if (shareButton) {
    shareButton.addEventListener('click', async () => {
      if (!Share?.share) return;
      try {
        await Share.share({
          title: document.title || 'Pressboxd',
          text: document.title || 'Pressboxd',
          url: window.location.href,
          dialogTitle: 'Share from Pressboxd'
        });
      } catch (_) {
        // User cancellation is normal; do not surface an error.
      }
    });
  }

  // Native network state -> small in-app offline banner.
  const offlineBanner = document.getElementById('nativeOfflineBanner');
  const renderNetwork = (status) => {
    if (!offlineBanner) return;
    offlineBanner.classList.toggle('show', status?.connected === false);
  };

  if (Network) {
    Network.getStatus?.().then(renderNetwork).catch(() => {});
    Network.addListener?.('networkStatusChange', renderNetwork).catch?.(() => {});
  }

  // Open third-party links in the device browser instead of trapping them in Pressboxd.
  document.addEventListener('click', async (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    if (anchor.hasAttribute('download')) return;

    let url;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch (_) {
      return;
    }

    if (!['http:', 'https:'].includes(url.protocol)) return;

    const host = url.hostname.toLowerCase();
    const internal = host === 'pressboxd.com' || host === 'www.pressboxd.com';
    if (internal) return;

    if (!Browser?.open) return;

    event.preventDefault();
    try {
      await Browser.open({ url: url.href });
    } catch (_) {
      window.location.href = url.href;
    }
  }, true);

  // Android hardware back button: use web history first; exit at the app root.
  if (App?.addListener) {
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack || window.history.length > 1) {
        window.history.back();
      } else {
        App.exitApp?.();
      }
    }).catch?.(() => {});
  }
})();
