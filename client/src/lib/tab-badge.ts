const APP_TITLE = 'Ямщик';
const UNREAD_TOTAL_KEY = 'cm:unreadTotal';

let baseIcon: HTMLImageElement | null = null;
let baseIconPromise: Promise<HTMLImageElement> | null = null;

function loadBaseIcon(): Promise<HTMLImageElement> {
  if (baseIcon) return Promise.resolve(baseIcon);
  if (!baseIconPromise) {
    baseIconPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        baseIcon = img;
        resolve(img);
      };
      img.onerror = reject;
      img.src = '/app-icon-32.png';
    });
  }
  return baseIconPromise;
}

function applyFavicon(href: string, type: string) {
  document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]').forEach((el) => el.remove());
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = type;
  link.href = href;
  document.head.appendChild(link);
}

function setDefaultFavicon() {
  applyFavicon('/app-icon-32.png', 'image/png');
}

async function setFaviconBadge(count: number) {
  if (count <= 0) {
    setDefaultFavicon();
    return;
  }

  const img = await loadBaseIcon();
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.drawImage(img, 0, 0, size, size);

  const label = count > 99 ? '99+' : String(count);
  const badgeX = 46;
  const badgeY = 18;
  const badgeR = count > 9 ? 15 : 13;

  ctx.fillStyle = '#ff6b6b';
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${count > 9 ? 10 : 12}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, badgeX, badgeY + 1);

  applyFavicon(canvas.toDataURL('image/png'), 'image/png');
}

function persistUnreadTotal(count: number) {
  if (count > 0) {
    localStorage.setItem(UNREAD_TOTAL_KEY, String(count));
  } else {
    localStorage.removeItem(UNREAD_TOTAL_KEY);
  }
}

export function getPersistedUnreadTotal(): number {
  const raw = localStorage.getItem(UNREAD_TOTAL_KEY);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function setAppIconBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?: (contents?: number | string) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (typeof nav.setAppBadge !== 'function') return;

  try {
    if (count > 0) {
      await nav.setAppBadge(count > 99 ? '99+' : count);
    } else if (typeof nav.clearAppBadge === 'function') {
      await nav.clearAppBadge();
    } else {
      await nav.setAppBadge(0);
    }
  } catch {
    // PWA not installed or OS does not support badging
  }
}

export function updateTabBadge(unreadTotal: number) {
  persistUnreadTotal(unreadTotal);
  document.title = unreadTotal > 0 ? `(${unreadTotal}) ${APP_TITLE}` : APP_TITLE;
  void setFaviconBadge(unreadTotal);
  void setAppIconBadge(unreadTotal);
}

export function syncTabBadge(counts: Record<string, number>) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  updateTabBadge(total);
}

export function clearTabBadge() {
  updateTabBadge(0);
}

export function restoreTabBadgeFromStorage() {
  const total = getPersistedUnreadTotal();
  if (total > 0) {
    document.title = `(${total}) ${APP_TITLE}`;
    void setAppIconBadge(total);
    void setFaviconBadge(total);
  }
}

export function isTabVisible() {
  return !document.hidden;
}

export function supportsAppIconBadge() {
  return typeof (navigator as Navigator & { setAppBadge?: unknown }).setAppBadge === 'function';
}
