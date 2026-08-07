import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';

const THRESHOLD_PX = 64;
const MAX_PULL_PX = 96;
const RESISTANCE = 0.42;

type Props = {
  onRefresh: () => void | Promise<void>;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
};

/**
 * Telegram-style pull-to-refresh on a scrollable list.
 * Activates only when scrollTop === 0 and the user pulls down.
 */
export function PullToRefresh({ onRefresh, className, children, disabled }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);
  const pullRef = useRef(0);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  refreshingRef.current = refreshing;

  const setPullBoth = (n: number) => {
    pullRef.current = n;
    setPull(n);
  };

  const finishRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    setRefreshing(true);
    setPullBoth(THRESHOLD_PX * 0.7);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
      setPullBoth(0);
    }
  }, [onRefresh]);

  const onTouchStart = (e: ReactTouchEvent) => {
    if (disabled || refreshingRef.current) return;
    const el = scrollerRef.current;
    if (!el || el.scrollTop > 0) {
      pullingRef.current = false;
      return;
    }
    startYRef.current = e.touches[0]?.clientY ?? 0;
    pullingRef.current = true;
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    if (!pullingRef.current || disabled || refreshingRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    if (el.scrollTop > 0) {
      pullingRef.current = false;
      setPullBoth(0);
      return;
    }
    const y = e.touches[0]?.clientY ?? 0;
    const dy = y - startYRef.current;
    if (dy <= 0) {
      setPullBoth(0);
      return;
    }
    const next = Math.min(MAX_PULL_PX, dy * RESISTANCE);
    setPullBoth(next);
  };

  const onTouchEnd = () => {
    if (!pullingRef.current) return;
    pullingRef.current = false;
    if (refreshingRef.current) return;
    if (pullRef.current >= THRESHOLD_PX) {
      void finishRefresh();
    } else {
      setPullBoth(0);
    }
  };

  // Non-passive touchmove so preventDefault works on iOS/Android WebView.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const move = (e: TouchEvent) => {
      if (!pullingRef.current || disabled || refreshingRef.current) return;
      if (el.scrollTop > 0) return;
      const y = e.touches[0]?.clientY ?? 0;
      const dy = y - startYRef.current;
      if (dy > 0 && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', move, { passive: false });
    return () => el.removeEventListener('touchmove', move);
  }, [disabled]);

  const showIndicator = pull > 2 || refreshing;
  const armed = pull >= THRESHOLD_PX || refreshing;
  const indicatorH = refreshing ? Math.max(pull, 44) : pull;

  return (
    <div
      ref={scrollerRef}
      className={['pull-to-refresh', className].filter(Boolean).join(' ')}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div
        className={[
          'pull-to-refresh-indicator',
          showIndicator ? 'visible' : '',
          armed ? 'armed' : '',
          refreshing ? 'refreshing' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ height: indicatorH }}
        aria-hidden={!showIndicator}
      >
        <span className="pull-to-refresh-spinner" />
      </div>
      {children}
    </div>
  );
}
