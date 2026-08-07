interface Props {
  onDelete: () => void;
  label?: string;
}

/** Trash control overlaid on photo/video media (top-right). */
export function MediaDeleteButton({ onDelete, label = 'Удалить' }: Props) {
  return (
    <button
      type="button"
      className="msg-media-delete"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onDelete();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
        <path
          fill="currentColor"
          d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
        />
      </svg>
    </button>
  );
}
