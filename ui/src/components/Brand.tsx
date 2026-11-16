import "./brand.css";

/*
  Vigil's mark: an open eye whose pupil is a star. The eye is the watch that never closes; the
  star is a service of the shop, the same light the 3D sky is made of. The pupil and the dots of
  the wordmark take the colour of the shop's state (--state, set on <html> by the app), so the
  logo itself says whether all is quiet, something is being looked into, or something was fixed.
*/

export function Mark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`mark ${className}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path className="mark-lid" d="M2.5 16C7 8.6 11.3 6.4 16 6.4S25 8.6 29.5 16C25 23.4 20.7 25.6 16 25.6S7 23.4 2.5 16Z" />
      <circle className="mark-halo" cx="16" cy="16" r="7.2" />
      <path className="mark-star" d="M16 10.4 17.5 14.5 21.6 16 17.5 17.5 16 21.6 14.5 17.5 10.4 16 14.5 14.5Z" />
    </svg>
  );
}

/** "Vigil" with each i dotted by a star. Screen readers hear the plain word. */
export function Wordmark({ className = "" }: { className?: string }) {
  const dotted = (key: string) => (
    <span key={key} className="wm-i">
      ı<i />
    </span>
  );
  return (
    <span className={`wordmark ${className}`} aria-label="Vigil" role="img">
      <span aria-hidden="true">
        V{dotted("a")}g{dotted("b")}l
      </span>
    </span>
  );
}
