import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StoryAuthor, type StoryItem } from '../lib/api';
import { compressStoryImage } from '../lib/image';
import { UserAvatar } from './UserAvatar';
import { StoryViewer } from './StoryViewer';

/** Max photos in one picker selection. */
const MAX_STORY_PICK = 10;
/** Server-side active story stack cap (must stay in sync with store.MaxActiveStories). */
const MAX_ACTIVE_STORIES = 30;

interface Props {
  userId: string;
  username: string;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number | null;
  avatarUrl?: string | null;
  /** Web Share Target → publish these as stories once. */
  shareFiles?: File[] | null;
  onShareFilesConsumed?: () => void;
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name);
}

export function StoriesRail({
  userId,
  username,
  hasAvatar = false,
  avatarUpdatedAt = null,
  avatarUrl = null,
  shareFiles = null,
  onShareFilesConsumed,
}: Props) {
  const [authors, setAuthors] = useState<StoryAuthor[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
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
    const onStoryPush = () => void refresh();
    window.addEventListener('coachman-story-push', onStoryPush);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
      window.removeEventListener('coachman-story-push', onStoryPush);
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
  const slotsLeft = Math.max(0, MAX_ACTIVE_STORIES - me.stories.length);

  const openAuthor = (authorId: string) => {
    const list = authors.filter((a) => a.stories.length > 0);
    const index = list.findIndex((a) => a.userId === authorId);
    if (index < 0) return;
    setViewer({ authors: list, index });
  };

  const openPicker = () => {
    if (uploading) return;
    if (slotsLeft <= 0) {
      window.alert(`Можно хранить не больше ${MAX_ACTIVE_STORIES} историй`);
      return;
    }
    fileRef.current?.click();
  };

  const onPickFiles = async (list: FileList | File[] | null) => {
    if (!list || uploading) return;
    const asArray = Array.isArray(list) ? list : Array.from(list);
    if (!asArray.length) return;

    const images = asArray.filter(isImageFile);
    if (!images.length) {
      window.alert('Выберите изображения');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    const pickCap = Math.min(MAX_STORY_PICK, slotsLeft);
    let selected = images;
    if (images.length > pickCap) {
      selected = images.slice(0, pickCap);
      if (slotsLeft < images.length && slotsLeft <= MAX_STORY_PICK) {
        window.alert(
          `Добавлено ${pickCap} из ${images.length}: осталось ${slotsLeft} слот(ов) в истории`,
        );
      } else {
        window.alert(`Можно выбрать не больше ${MAX_STORY_PICK} фото за раз`);
      }
    }

    setUploading(true);
    let ok = 0;
    let failed = 0;
    try {
      for (let i = 0; i < selected.length; i++) {
        if (!mountedRef.current) break;
        setUploadProgress(`${i + 1}/${selected.length}`);
        try {
          const compressed = await compressStoryImage(selected[i]);
          await api.createStory(compressed.blob, {
            width: compressed.width,
            height: compressed.height,
          });
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      await refresh();
      if (failed > 0 && ok === 0) {
        window.alert('Не удалось опубликовать фото');
      } else if (failed > 0) {
        window.alert(`Опубликовано ${ok}, не удалось: ${failed}`);
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  useEffect(() => {
    if (!shareFiles?.length || uploading) return;
    const files = shareFiles;
    onShareFilesConsumed?.();
    void onPickFiles(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot share handoff
  }, [shareFiles]);

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
              else openPicker();
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
            <span className="stories-label">
              {uploading ? uploadProgress || '…' : 'История'}
            </span>
          </button>
          <button
            type="button"
            className="stories-add-fab"
            aria-label="Добавить до 10 фото"
            disabled={uploading || slotsLeft <= 0}
            onClick={openPicker}
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
          multiple
          hidden
          onChange={(e) => void onPickFiles(e.target.files)}
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
            // Let the viewer unmount before opening the system picker.
            window.setTimeout(() => openPicker(), 50);
          }}
        />
      )}
    </>
  );
}
