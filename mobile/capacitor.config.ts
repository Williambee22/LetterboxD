import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pressboxd.app',
  appName: 'Pressboxd',
  webDir: 'www',

  // Pressboxd already has a production Express/EJS site.
  // The native shell loads that HTTPS origin so the existing
  // sessions, accounts, ratings, reviews and database stay shared.
  server: {
    url: 'https://www.pressboxd.com',
    cleartext: false,
    allowNavigation: [
      'pressboxd.com',
      'www.pressboxd.com'
    ]
  },

  android: {
    backgroundColor: '#000000',
    allowMixedContent: false
  },

  ios: {
    backgroundColor: '#000000',
    contentInset: 'automatic'
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#000000',
      showSpinner: false
    },
    StatusBar: {
      overlaysWebView: false,
      backgroundColor: '#000000'
    }
  }
};

export default config;
