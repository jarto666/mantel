import { animate, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Layer, useInput } from "../input";
import { ease, spring } from "../motion";
import { gameById, sourceLabel, useStore } from "../store";
import { placeholderHue } from "../util";
import { Img } from "./Img";
import { useHints } from "./Hints";

const TEXT = {
  starting: (src: string) => ["Starting", `via ${src}`],
  started: () => ["Enjoy", "Mantel will wait in the background"],
  timeout: (src: string) => [`Handed off to ${src}`, "If the game opened, you’re all set"],
  error: () => ["Couldn’t launch", ""],
};

/** The cover lifts out of the shelf, flies to centre stage, and a shockwave rings out. */
export function LaunchOverlay() {
  const launching = useStore((s) => s.launching);
  const game = gameById(launching?.id ?? null);
  const card = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ launching: null });

  useInput(() => {
    close();
  }, Layer.modal, !!launching);
  useHints([["b", "Dismiss"]], Layer.modal, !!launching);

  useEffect(() => {
    if (!launching || launching.phase === "starting") return;
    const t = setTimeout(close, launching.phase === "started" ? 1700 : 4300);
    return () => clearTimeout(t);
  }, [launching]);

  // FLIP: start the card exactly where the focused cover was, then spring it home.
  const from = launching?.from;
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    if (!from) {
      animate(el, { opacity: [0, 1], scale: [0.85, 1] }, spring.soft);
      return;
    }
    const r = el.getBoundingClientRect();
    const dx = from.x + from.w / 2 - (r.left + r.width / 2);
    const dy = from.y + from.h / 2 - (r.top + r.height / 2);
    const s = from.w / r.width;
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    animate(el, { x: [dx, 0], y: [dy, 0], scale: [s, 1] }, { type: "spring", stiffness: 140, damping: 20, mass: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launching?.id]);

  if (!launching || !game) return null;
  const src = sourceLabel(game);
  const [title, sub] = TEXT[launching.phase](src);
  const hue = placeholderHue(game.name);

  return (
    <motion.div className={`launch phase-${launching.phase}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
      <motion.div className="launch-art" initial={{ scale: 1.3, opacity: 0 }} animate={{ scale: 1.05, opacity: 1 }} transition={{ duration: 6, ease }}>
        <Img srcs={[...game.art.hero, ...game.art.cover]} className="launch-art-img" />
      </motion.div>
      <div className="launch-burst">
        <span className="ring r1" />
        <span className="ring r2" />
        <span className="ring r3" />
        <span className="flare" />
      </div>
      <div className="launch-center">
        <div className="launch-card" ref={card}>
          <Img
            srcs={game.art.cover}
            className="launch-card-img"
            fallback={
              <div className="cover-placeholder" data-initial={game.name.trim()[0]?.toUpperCase()} style={{ "--h1": hue, "--h2": (hue + 42) % 360 } as React.CSSProperties}>
                <span>{game.name}</span>
              </div>
            }
          />
          <div className="cover-gloss" />
          <div className="cover-shine" />
        </div>
        <motion.div className="launch-status" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45, duration: 0.6, ease }}>
          <div className="launch-title">{title}</div>
          <div className="launch-sub">{launching.phase === "error" ? launching.message : sub}</div>
          {launching.phase === "starting" && <div className="launch-progress"><span /></div>}
        </motion.div>
      </div>
    </motion.div>
  );
}
