import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, toSrc } from "../api";
import { usePageHidden } from "../hooks";
import { idleFor } from "../input";
import { gameById, useStore } from "../store";
import { streamTrailer } from "../trailer";
import type { Game } from "../types";
import { placeholderHue } from "../util";

/** How long a game must stay focused before its trailer starts. */
const DWELL = 1700;
/** Matches the fade-out in CSS; the stream is torn down after it. */
const FADE_OUT = 600;
/** With nobody around, the trailer gives way to the still art: video costs battery. */
const IDLE_STOP = 3 * 60_000;

interface Layer {
  id: string;
  src: string | null;
  /** Hue for a generated backdrop when the game has no art at all. */
  hue: number;
  /** A portrait cover stretched to 16:9 needs extra blur to hide the upscale. */
  soft: boolean;
}

function preload(srcs: string[]): Promise<string | null> {
  return srcs.reduce<Promise<string | null>>(
    (prev, path) =>
      prev.then(
        (hit) =>
          hit ??
          new Promise((resolve) => {
            const img = new Image();
            const src = toSrc(path);
            img.onload = () => img.decode().then(() => resolve(img.naturalWidth > 8 ? src : null), () => resolve(src));
            img.onerror = () => resolve(null);
            img.src = src;
          }),
      ),
    Promise.resolve(null),
  );
}

async function layerFor(game: Game): Promise<Layer> {
  const hue = placeholderHue(game.name);
  const hero = await preload(game.art.hero);
  if (hero) return { id: game.id, src: hero, soft: false, hue };
  return { id: game.id, src: await preload(game.art.cover), soft: true, hue };
}

/**
 * The focused game's trailer over its art, muted and looping, once focus has rested on it
 * for a moment. Paused under overlays; stopped while a game runs or Mantel is out of sight.
 */
function Trailer() {
  const focusId = useStore((s) => s.focusId);
  const enabled = useStore((s) => s.settings?.trailers ?? false);
  const onHome = useStore((s) => s.view === "home" && !s.detailsId);
  const covered = useStore((s) => s.overlay !== null || s.launching !== null);
  const running = useStore((s) => s.running !== null);
  const hidden = usePageHidden();
  const video = useRef<HTMLVideoElement>(null);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const [shown, setShown] = useState(false);
  const live = enabled && onHome && !running && !hidden;

  useEffect(() => {
    const game = gameById(focusId);
    const el = video.current;
    if (!live || !game?.steamAppId || !el) return;
    const stream = new AbortController();
    const start = setTimeout(async () => {
      try {
        const info = await api.getDetails(game.id);
        if (!info?.trailer || stream.signal.aborted) return;
        // About two thirds of the screen's pixels is plenty under the shade, and spares the decoder.
        const height = Math.round(innerHeight * devicePixelRatio * 0.6);
        await streamTrailer(el, info.trailer, height, () => coveredRef.current, stream.signal);
      } catch (e) {
        if (stream.signal.aborted) return;
        api.log("warn", `trailer for ${game.name}: ${e}`);
        setShown(false);
      }
    }, DWELL);
    const idle = setInterval(() => {
      if (idleFor() < IDLE_STOP) return;
      clearInterval(idle);
      setShown(false);
      setTimeout(() => stream.abort(), FADE_OUT);
    }, 5000);
    return () => {
      clearTimeout(start);
      clearInterval(idle);
      setShown(false);
      setTimeout(() => stream.abort(), FADE_OUT);
    };
  }, [focusId, live]);

  useEffect(() => {
    const el = video.current;
    if (!el?.src) return;
    if (covered) el.pause();
    else el.play().catch(() => {});
  }, [covered]);

  return (
    <video
      ref={video}
      className={`bg-trailer ${shown ? "is-shown" : ""}`}
      muted
      playsInline
      disablePictureInPicture
      onPlaying={() => setShown(true)}
    />
  );
}

/**
 * Full-bleed art of the focused game. New art arrives like a focus pull: it starts
 * slightly oversized and soft, then settles sharp while the old frame dissolves.
 */
export function Background({ mode }: { mode: "home" | "dim" | "page" }) {
  const focusId = useStore((s) => s.focusId);
  const detailsId = useStore((s) => s.detailsId);
  const id = detailsId ?? focusId;
  const [layer, setLayer] = useState<Layer | null>(null);
  const want = useRef<string | null>(null);

  useEffect(() => {
    const game = gameById(id);
    if (!game) return;
    want.current = game.id;
    // Decode before swapping so the cross-fade never shows a half-painted frame.
    layerFor(game).then((next) => want.current === game.id && setLayer(next));
  }, [id]);

  return (
    <div className={`bg bg-${mode}`}>
      <AnimatePresence initial={false}>
        {layer && (
          <motion.div
            key={layer.id}
            className={`bg-layer ${layer.soft ? "soft" : ""}`}
            initial={{ opacity: 0, scale: 1.09, filter: "blur(14px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, transition: { duration: 0.9, ease: "easeOut" } }}
            transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
          >
            <div
              className="bg-image"
              style={{
                backgroundImage: layer.src
                  ? `url("${layer.src}")`
                  : `radial-gradient(60% 70% at 72% 28%, hsl(${(layer.hue + 42) % 360} 70% 45% / 0.75), transparent 70%), linear-gradient(160deg, hsl(${layer.hue} 50% 22%), hsl(${(layer.hue + 42) % 360} 60% 7%))`,
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {mode === "home" && <Trailer />}
      <div className="bg-light" />
      <div className="bg-shade" />
      <div className="bg-grain" />
    </div>
  );
}
