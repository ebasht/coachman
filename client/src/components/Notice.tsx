import type { ReactNode } from 'react';

type Variant = 'error' | 'success' | 'info' | 'warning';

const ICONS: Record<Variant, string> = {
  error: '✕',
  success: '✓',
  info: 'ℹ',
  warning: '!',
};

interface Props {
  variant?: Variant;
  children: ReactNode;
}

export function Notice({ variant = 'error', children }: Props) {
  return (
    <div className={`notice notice-${variant}`} role="alert">
      <span className="notice-icon" aria-hidden>
        {ICONS[variant]}
      </span>
      <span className="notice-text">{children}</span>
    </div>
  );
}
