import { useCallback, useEffect, useState } from 'react';
import { pushNeedsPWAInstall, pushPermission } from '../lib/push-subscribe';

export function usePushPermission() {
  const [permission, setPermission] = useState(() => pushPermission());
  const [needsInstall, setNeedsInstall] = useState(() => pushNeedsPWAInstall());

  const refresh = useCallback(() => {
    setPermission(pushPermission());
    setNeedsInstall(pushNeedsPWAInstall());
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  return { permission, needsInstall, refresh };
}
