import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StoryAuthor } from '../lib/api';
import { UserAvatar } from './UserAvatar';

const STORY_MS = 5000;

interface Props {
  authors: StoryAuthor[];
  startAuthorIndex: number;
  currentUserId: string;
  onClose: () => void;
  onAdd?: () => void;
}

export function StoryViewer({
  authors: initialAuthors,
  startAuthorIndex,
  currentUserId,
  onClose,
  onAdd,
}: Props) {
  const [authors, setAuthors] = useState(initialAuthors);
  const [authorIndex, setAuthorIndex] = useState(startAuthorIndex);
  const [storyIndex, setStoryIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<number | null>(null);
  const startedRef = useRef(0);
  const remainRef = useRef(STORY_MS);

  const author = authors[authorIndex];
  const story = author?.stories[storyIndex];
  const isMine = author?.userId === currentUserId;

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const goNext = useCallback(() => {
    setProgress(0);
    remainRef.current = STORY_MS;
    setAuthors((prev) => {
      const copy = prev.map((a) => ({ ...a, stories: a.stories.map((s) => ({ ...s })) }));
      const a = copy[authorIndex];
      if (a?.stories[storyIndex]) a.stories[storyIndex].seen = true;
      return copy;
    });
    if (story && !story.seen) {
      void api.viewStory(story.id).catch(() => {});
    }

    if (author && storyIndex < author.stories.length - 1) {
      setStoryIndex((i) => i + 1);
      return;
    }
    if (authorIndex < authors.length - 1) {
      setAuthorIndex((i) => i + 1);
      setStoryIndex(0);
      return;
    }
    onClose();
  }, [author, authorIndex, authors.length, onClose, story, storyIndex]);

  const goPrev = useCallback(() => {
    setProgress(0);
    remainRef.current = STORY_MS;
    if (storyIndex > 0) {
      setStoryIndex((i) => i - 1);
      return;
    }
    if (authorIndex > 0) {
      const prev = authors[authorIndex - 1];
      setAuthorIndex((i) => i - 1);
      setStoryIndex(Math.max(0, (prev?.stories.length ?? 1) - 1));
    }
  }, [authorIndex, authors, storyIndex]);

  useEffect(() => {
    if (!story?.id) return;
    if (!story.seen) {
      void api.viewStory(story.id).catch(() => {});
    }
  }, [story?.id, story?.seen]);

  useEffect(() => {
    clearTimer();
    if (!story || paused) return;
    startedRef.current = Date.now();
    const total = remainRef.current;
    timerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedRef.current;
      const pct = Math.min(1, elapsed / total);
      setProgress(pct);
      if (pct >= 1) {
        clearTimer();
        remainRef.current = STORY_MS;
        goNext();
      }
    }, 50);
    return clearTimer;
  }, [story?.id, storyIndex, authorIndex, paused, goNext, story]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, onClose]);

  if (!author || !story) {
    return null;
  }

  const pause = () => {
    if (paused) return;
    const elapsed = Date.now() - startedRef.current;
    remainRef.current = Math.max(200, remainRef.current - elapsed);
    setPaused(true);
  };
  const resume = () => setPaused(false);

  const onDelete = async () => {
    if (!isMine) return;
    if (!window.confirm('Удалить эту историю?')) return;
    try {
      await api.deleteStory(story.id);
      const nextAuthors = authors
        .map((a, i) => {
          if (i !== authorIndex) return a;
          return { ...a, stories: a.stories.filter((s) => s.id !== story.id) };
        })
        .filter((a) => a.stories.length > 0);
      if (!nextAuthors.length) {
        onClose();
        return;
      }
      const nextAuthorIdx = Math.min(authorIndex, nextAuthors.length - 1);
      setAuthors(nextAuthors);
      setAuthorIndex(nextAuthorIdx);
      setStoryIndex(0);
      setProgress(0);
      remainRef.current = STORY_MS;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  };

  return (
    <div className="story-viewer" role="dialog" aria-modal="true" aria-label="История">
      <div className="story-viewer-bars">
        {author.stories.map((s, i) => (
          <div key={s.id} className="story-viewer-bar">
            <div
              className="story-viewer-bar-fill"
              style={{
                width:
                  i < storyIndex ? '100%' : i === storyIndex ? `${Math.round(progress * 100)}%` : '0%',
              }}
            />
          </div>
        ))}
      </div>

      <header className="story-viewer-top">
        <div className="story-viewer-user">
          <UserAvatar
            userId={author.userId}
            name={author.username}
            hasAvatar={author.hasAvatar}
            avatarUpdatedAt={author.avatarUpdatedAt}
            avatarUrl={author.avatarUrl}
            className="story-viewer-avatar"
          />
          <div>
            <p className="story-viewer-name">{author.username.replace(/^@/, '')}</p>
            <p className="story-viewer-time">{formatStoryAge(story.createdAt)}</p>
          </div>
        </div>
        <div className="story-viewer-actions">
          {isMine && (
            <>
              {onAdd && (
                <button type="button" className="story-viewer-icon" onClick={onAdd} aria-label="Добавить">
                  +
                </button>
              )}
              <button type="button" className="story-viewer-icon" onClick={() => void onDelete()} aria-label="Удалить">
                ⌫
              </button>
            </>
          )}
          <button type="button" className="story-viewer-icon" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
      </header>

      <div
        className="story-viewer-media"
        onPointerDown={pause}
        onPointerUp={resume}
        onPointerCancel={resume}
        onPointerLeave={resume}
      >
        {story.url ? (
          <img src={story.url} alt="" draggable={false} />
        ) : (
          <p className="story-viewer-missing">Нет изображения</p>
        )}
        <button type="button" className="story-viewer-hit story-viewer-hit-prev" aria-label="Назад" onClick={goPrev} />
        <button type="button" className="story-viewer-hit story-viewer-hit-next" aria-label="Дальше" onClick={goNext} />
      </div>
    </div>
  );
}

function formatStoryAge(createdAt: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч`;
  return 'вчера';
}
