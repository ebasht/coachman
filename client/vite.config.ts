import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: [
        'app-icon-32.png',
        'app-icon-180.png',
        'app-icon-192.png',
        'app-icon-512.png',
        'push-sw.js',
      ],
      manifest: {
        id: process.env.VITE_PWA_ID || '/',
        name: 'Ямщик',
        short_name: 'Ямщик',
        description: 'Зашифрованный мессенджер',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2,png,webmanifest}'],
        globIgnores: ['**/icon-source.png', '**/brand/**'],
        importScripts: ['push-sw.js'],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Always serve the precached shell for navigations (critical for offline PWA cold start).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/health$/, /^\/runtime-config\.js$/],
        runtimeCaching: [
          {
            // Belt-and-suspenders if a hashed asset is requested outside precache matching.
            urlPattern: /\/(assets\/|app-icon|manifest\.webmanifest)/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'app-shell-assets',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            urlPattern: /\/runtime-config\.js$/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'runtime-config',
              networkTimeoutSeconds: 2,
              expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/runtime-config.js': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
});
