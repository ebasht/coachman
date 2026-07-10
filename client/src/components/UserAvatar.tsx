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
  const url = useAvatarUrl(userId, !!hasAvatar, avatarUpdatedAt ?? null, avatarUrl);
  const [failed, setFailed] = useState(false);

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
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className={className} aria-hidden>
      {chatInitials(name)}
    </span>
  );
}
