import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type StoryAuthor, type StoryViewerPerson } from '../lib/api';
import { UserAvatar } from './UserAvatar';

const STORY_MS = 5000;
const DISMISS_DY_PX = 120;
const DISMISS_VY = 0.65; // px/ms
const AXIS_LOCK_PX = 8;

interface Props {
  authors: StoryAuthor[];
  startAuthorIndex: number;
  currentUserId: string;
  onClose: () => void;
  onAdd?: () => void;
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="currentColor">
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9z" />
    </svg>
  );
}

function IconEye() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="currentColor">
      <path d="M12 5c-5 0-9.3 3.1-11 7 1.7 3.9 6 7 11 7s9.3-3.1 11-7c-1.7-3.9-6-7-11-7zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zm0-2.2a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z" />
    </svg>
  );
}

function viewsLabel(n: number): string {
  if (n <= 0) return 'Нет просмотров';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} просмотр`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} просмотра`;
  return `${n} просмотров`;
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
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [viewers, setViewers] = useState<StoryViewerPerson[]>([]);
  const [viewersLoading, setViewersLoading] = useState(false);
  const timerRef = useRef<number | null>(null);
  const startedRef = useRef(0);
  const remainRef = useRef(STORY_MS);
  const mediaRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    t: number;
    axis: 'h' | 'v' | null;
  } | null>(null);

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
    if (showViewers) return;
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
  }, [author, authorIndex, authors.length, onClose, showViewers, story, storyIndex]);

  const goPrev = useCallback(() => {
    if (showViewers) return;
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
  }, [authorIndex, authors, showViewers, storyIndex]);

  useEffect(() => {
    if (!story?.id) return;
    if (!story.seen) {
      void api.viewStory(story.id).catch(() => {});
    }
  }, [story?.id, story?.seen]);

  useEffect(() => {
    setShowViewers(false);
    setViewers([]);
  }, [story?.id]);

  useEffect(() => {
    clearTimer();
    if (!story || paused || showViewers) return;
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
  }, [story?.id, storyIndex, authorIndex, paused, showViewers, goNext, story]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showViewers) {
          setShowViewers(false);
          return;
        }
        onClose();
      }
      if (showViewers) return;
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, onClose, showViewers]);

  const pause = () => {
    if (paused || showViewers) return;
    const elapsed = Date.now() - startedRef.current;
    remainRef.current = Math.max(200, remainRef.current - elapsed);
    setPaused(true);
  };

  const resume = () => {
    if (showViewers) return;
    setPaused(false);
  };

  const resetDrag = () => {
    gestureRef.current = null;
    setDragging(false);
    setDragY(0);
  };

  const openViewers = async () => {
    if (!isMine || !story) return;
    setShowViewers(true);
    setPaused(true);
    setViewersLoading(true);
    try {
      const { viewers: next } = await api.getStoryViewers(story.id);
      setViewers(next);
      setAuthors((prev) =>
        prev.map((a, i) => {
          if (i !== authorIndex) return a;
          return {
            ...a,
            stories: a.stories.map((s, si) =>
              si === storyIndex ? { ...s, viewCount: next.length } : s,
            ),
          };
        }),
      );
    } catch {
      setViewers([]);
    } finally {
      setViewersLoading(false);
    }
  };

  const closeViewers = () => {
    setShowViewers(false);
    setPaused(false);
  };

  const onMediaPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || showViewers) return;
    gestureRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: Date.now(),
      axis: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    pause();
  };

  const onMediaPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;

    if (!g.axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      g.axis = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
    }

    if (g.axis === 'v') {
      setDragging(true);
      setDragY(Math.max(0, dy));
    }
  };

  const onMediaPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;

    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const dt = Math.max(1, Date.now() - g.t);
    const axis = g.axis;

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }

    if (axis === 'v' || (!axis && dy > 40 && Math.abs(dy) > Math.abs(dx))) {
      const vy = dy / dt;
      if (dy > DISMISS_DY_PX || vy > DISMISS_VY) {
        gestureRef.current = null;
        onClose();
        return;
      }
      resetDrag();
      resume();
      return;
    }

    const isTap = !axis || (Math.abs(dx) < 12 && Math.abs(dy) < 12);
    if (isTap && dt < 280) {
      const rect = mediaRef.current?.getBoundingClientRect();
      const width = rect?.width ?? window.innerWidth;
      const left = rect?.left ?? 0;
      const relX = e.clientX - left;
      if (relX < width * 0.42) goPrev();
      else goNext();
    }

    resetDrag();
    resume();
  };

  const onMediaPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== e.pointerId) return;
    resetDrag();
    resume();
  };

  const onDelete = async () => {
    if (!isMine || !story) return;
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
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Не удалось удалить');
    }
  };

  if (!author || !story) {
    return null;
  }

  const portalTarget = document.getElementById('root') ?? document.body;
  const dismissProgress = Math.min(1, dragY / 280);
  const backdropAlpha = 1 - dismissProgress * 0.55;
  const isPulling = dragging && dragY > 0;
  const viewCount = story.viewCount ?? viewers.length;

  return createPortal(
    <div
      className={`story-viewer${isPulling ? ' is-dragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="История"
      style={{ background: `rgba(0, 0, 0, ${backdropAlpha})` }}
    >
      <div
        className="story-viewer-sheet"
        style={{
          transform: dragY
            ? `translateY(${dragY}px) scale(${1 - dismissProgress * 0.06})`
            : undefined,
          opacity: 1 - dismissProgress * 0.25,
          transition: dragging ? 'none' : 'transform 0.2s ease, opacity 0.2s ease',
        }}
      >
        <div className="story-viewer-chrome">
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
                    <IconTrash />
                  </button>
                </>
              )}
              <button type="button" className="story-viewer-icon story-viewer-close" onClick={onClose} aria-label="Закрыть">
                <IconClose />
              </button>
            </div>
          </header>
        </div>

        <div
          ref={mediaRef}
          className="story-viewer-media"
          onPointerDown={onMediaPointerDown}
          onPointerMove={onMediaPointerMove}
          onPointerUp={onMediaPointerUp}
          onPointerCancel={onMediaPointerCancel}
        >
          {story.url ? (
            <img src={story.url} alt="" draggable={false} />
          ) : (
            <p className="story-viewer-missing">Нет изображения</p>
          )}
          <div className="story-viewer-hit story-viewer-hit-prev" aria-hidden />
          <div className="story-viewer-hit story-viewer-hit-next" aria-hidden />
        </div>

        {isMine && (
          <button
            type="button"
            className="story-viewer-views-btn"
            onClick={() => void openViewers()}
            aria-label={viewsLabel(viewCount)}
          >
            <IconEye />
            <span>{viewsLabel(viewCount)}</span>
          </button>
        )}
      </div>

      {showViewers && (
        <div className="story-viewers-sheet" role="dialog" aria-label="Просмотры">
          <button type="button" className="story-viewers-backdrop" aria-label="Закрыть" onClick={closeViewers} />
          <div className="story-viewers-panel">
            <div className="story-viewers-handle" aria-hidden />
            <header className="story-viewers-head">
              <h3>{viewsLabel(viewersLoading ? viewCount : viewers.length)}</h3>
              <button type="button" className="story-viewer-icon story-viewer-close" onClick={closeViewers} aria-label="Закрыть">
                <IconClose />
              </button>
            </header>
            {viewersLoading ? (
              <p className="story-viewers-empty">Загрузка…</p>
            ) : viewers.length === 0 ? (
              <p className="story-viewers-empty">Пока никто не посмотрел</p>
            ) : (
              <ul className="story-viewers-list">
                {viewers.map((v) => (
                  <li key={v.userId} className="story-viewers-row">
                    <UserAvatar
                      userId={v.userId}
                      name={v.username}
                      hasAvatar={v.hasAvatar}
                      avatarUpdatedAt={v.avatarUpdatedAt}
                      avatarUrl={v.avatarUrl}
                      className="story-viewers-avatar"
                    />
                    <div className="story-viewers-meta">
                      <span className="story-viewers-name">{v.username.replace(/^@/, '')}</span>
                      <span className="story-viewers-time">{formatStoryAge(v.viewedAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>,
    portalTarget,
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
