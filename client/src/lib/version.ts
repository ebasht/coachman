declare const __APP_VERSION__: string;

/** App version from client/package.json (injected at build time). */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
