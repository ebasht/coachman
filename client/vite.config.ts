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
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: [
        'app-icon-32.png',
        'app-icon-180.png',
        'app-icon-192.png',
        'app-icon-512.png',
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
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2,png,webmanifest}'],
        globIgnores: ['**/icon-source.png', '**/brand/**', '**/push-sw.js'],
        // Single file — critical for iOS offline cold start (no importScripts).
        rollupFormat: 'iife',
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
