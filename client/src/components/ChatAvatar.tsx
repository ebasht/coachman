import { useEffect, useState } from 'react';
import { useChatAvatarUrl } from '../hooks/useChatAvatarUrl';

interface Props {
  chatId: string;
  name: string;
  isSystem?: boolean;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number | null;
  avatarUrl?: string | null;
  className?: string;
}

export function ChatAvatar({
  chatId,
  name,
  isSystem,
  hasAvatar,
  avatarUpdatedAt,
  avatarUrl,
  className = '',
}: Props) {
  const wantsPhoto = !!(hasAvatar || avatarUpdatedAt || avatarUrl);
  const [cdnFailed, setCdnFailed] = useState(true);
  const url = useChatAvatarUrl(
    chatId,
    wantsPhoto,
    avatarUpdatedAt ?? null,
    avatarUrl,
    cdnFailed,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCdnFailed(true);
    setFailed(false);
  }, [chatId, avatarUrl, avatarUpdatedAt]);

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
    <span className={`${className} group`.trim()} aria-hidden title={name}>
      {isSystem ? '🌐' : '👥'}
    </span>
  );
}
