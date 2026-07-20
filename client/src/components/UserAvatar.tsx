import { useEffect, useState } from 'react';
import { chatInitials } from '../lib/chat-format';
import { useAvatarUrl } from '../hooks/useAvatarUrl';

interface Props {
  userId: string;
  name: string;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number | null;
  avatarUrl?: string | null;
  className?: string;
}

export function UserAvatar({
  userId,
  name,
  hasAvatar,
  avatarUpdatedAt,
  avatarUrl,
  className = '',
}: Props) {
  const wantsPhoto = !!(hasAvatar || avatarUpdatedAt || avatarUrl);
  const [cdnFailed, setCdnFailed] = useState(false);
  const url = useAvatarUrl(
    userId,
    wantsPhoto,
    avatarUpdatedAt ?? null,
    avatarUrl,
    cdnFailed,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCdnFailed(false);
    setFailed(false);
  }, [userId, avatarUrl, avatarUpdatedAt]);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (url && !failed) {
    return (
      <img
        className={className}
        src={url}
        alt=""
        draggable={false}
        onError={() => {
          // CDN may 403 while the authenticated API still works.
          if (avatarUrl && !cdnFailed) {
            setCdnFailed(true);
            return;
          }
          setFailed(true);
        }}
      />
    );
  }

  return (
    <span className={className} aria-hidden>
      {chatInitials(name)}
    </span>
  );
}
