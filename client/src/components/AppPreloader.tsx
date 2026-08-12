interface Props {
  /** Accessible status text for screen readers. */
  label?: string;
}

/**
 * Full-viewport branded splash shown while the app boots (auth / IndexedDB).
 * Visual language matches the Ямщик mark: deep navy field, gold accents, ellipsis pulse.
 */
export function AppPreloader({ label = 'Загрузка…' }: Props) {
  return (
    <div className="app-preloader" role="status" aria-live="polite" aria-busy="true">
      <div className="app-preloader-glow app-preloader-glow-a" aria-hidden />
      <div className="app-preloader-glow app-preloader-glow-b" aria-hidden />
      <div className="app-preloader-stage">
        <div className="app-preloader-mark-wrap">
          <span className="app-preloader-ring" aria-hidden />
          <span className="app-preloader-ring app-preloader-ring-delay" aria-hidden />
          <img
            className="app-preloader-mark"
            src="/app-icon-192.png"
            alt=""
            width={96}
            height={96}
            decoding="async"
          />
        </div>
        <p className="app-preloader-brand">Ямщик</p>
        <div className="app-preloader-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="app-preloader-sr">{label}</span>
      </div>
    </div>
  );
}
