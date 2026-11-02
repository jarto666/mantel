import { useLayoutEffect, useRef } from "react";

/** The sizes to try, against the full one. */
const FITS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
const LINES = 2;

/** A game's name in place of its logo, as large as fits on two lines whole. */
export function GameName({ name }: { name: string }) {
  const ref = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.classList.remove("is-cut");
      const fits = FITS.find((scale) => {
        el.style.setProperty("--fit", String(scale));
        const lines = el.clientHeight / parseFloat(getComputedStyle(el).lineHeight);
        return Math.round(lines) <= LINES && el.scrollWidth <= el.clientWidth + 1;
      });
      el.classList.toggle("is-cut", fits === undefined);
    };
    fit();
    // On the first screen the font may still be on its way.
    document.fonts.ready.then(fit);
  }, [name]);

  return (
    <h1 ref={ref} className="hero-name">
      {name}
    </h1>
  );
}
