import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StoryAuthor, type StoryItem } from '../lib/api';
import { compressChatImage, prepareChatImage } from '../lib/image';
import { UserAvatar } from './UserAvatar';
import { StoryViewer } from './StoryViewer';

interface Props {
  userId: string;
  username: string;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number | null;
  avatarUrl?: string | null;
}

export function StoriesRail({
  userId,
  username,
  hasAvatar = false,
  avatarUpdatedAt = null,
  avatarUrl = null,
}: Props) {
  const [authors, setAuthors] = useState<StoryAuthor[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [viewer, setViewer] = useState<{ authors: StoryAuthor[]; index: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { authors: next } = await api.getStoryFeed();
      if (mountedRef.current) setAuthors(next);
    } catch {
      if (mountedRef.current) setAuthors([]);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
    };
  }, [refresh]);

  const me = authors.find((a) => a.isMe) ?? {
    userId,
    username,
    hasAvatar,
    avatarUpdatedAt,
    avatarUrl,
    hasUnseen: false,
    latestAt: 0,
    isMe: true,
    stories: [] as StoryItem[],
  };

  const others = authors.filter((a) => !a.isMe && a.stories.length > 0);

  const openAuthor = (authorId: string) => {
    const list = authors.filter((a) => a.stories.length > 0);
    const index = list.findIndex((a) => a.userId === authorId);
    if (index < 0) return;
    setViewer({ authors: list, index });
  };

  const onPickFile = async (file: File | null) => {
    if (!file || uploading) return;
    setUploading(true);
    try {
      let blob: Blob = file;
      let width = 0;
      let height = 0;
      try {
        const compressed = await compressChatImage(file);
        blob = compressed.blob;
        width = compressed.width;
        height = compressed.height;
      } catch {
        blob = await prepareChatImage(file);
      }
      await api.createStory(blob, { width, height });
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Не удалось опубликовать');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (loading && authors.length === 0) {
    return null;
  }

  return (
    <>
      <div className="stories-rail" aria-label="Истории">
        <div className="stories-me-wrap">
          <button
            type="button"
            className={`stories-tile${me.stories.length ? (me.hasUnseen ? ' has-unseen' : ' has-seen') : ' is-empty'}`}
            onClick={() => {
              if (me.stories.length) openAuthor(me.userId);
              else fileRef.current?.click();
            }}
            disabled={uploading}
          >
            <span className="stories-ring">
              <UserAvatar
                userId={userId}
                name={username}
                hasAvatar={hasAvatar}
                avatarUpdatedAt={avatarUpdatedAt}
                avatarUrl={avatarUrl}
                className="stories-avatar"
              />
            </span>
            <span className="stories-label">{uploading ? '…' : 'Ваша история'}</span>
          </button>
          <button
            type="button"
            className="stories-add-fab"
            aria-label="Добавить историю"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            +
          </button>
        </div>

        {others.map((a) => (
          <button
            key={a.userId}
            type="button"
            className={`stories-tile${a.hasUnseen ? ' has-unseen' : ' has-seen'}`}
            onClick={() => openAuthor(a.userId)}
          >
            <span className="stories-ring">
              <UserAvatar
                userId={a.userId}
                name={a.username}
                hasAvatar={a.hasAvatar}
                avatarUpdatedAt={a.avatarUpdatedAt}
                avatarUrl={a.avatarUrl}
                className="stories-avatar"
              />
            </span>
            <span className="stories-label">{a.username.replace(/^@/, '')}</span>
          </button>
        ))}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {viewer && (
        <StoryViewer
          authors={viewer.authors}
          startAuthorIndex={viewer.index}
          currentUserId={userId}
          onClose={() => {
            setViewer(null);
            void refresh();
          }}
          onAdd={() => {
            setViewer(null);
            fileRef.current?.click();
          }}
        />
      )}
    </>
  );
}
