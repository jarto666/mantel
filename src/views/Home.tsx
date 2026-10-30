import { AnimatePresence, motion, type Variants } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Cover } from "../components/Cover";
import { Glyph, SourceIcon } from "../components/Glyph";
import { useHints } from "../components/Hints";
import { Img } from "../components/Img";
import { AchievementsStat, Stat } from "../components/Stat";
import { Layer, useInput } from "../input";
import { ease, spring, useRem, useSettled } from "../motion";
import { launch, rescan, setFocus, sourceLabel, toggleFavorite, useStore } from "../store";
import type { Game } from "../types";
import { hours, lastPlayed, size } from "../util";

const SHELF_SIZE = 18;
const LIBRARY_KEY = "library";
/** Card geometry in rem; mirrors .shelf .cover in CSS. */
const CARD_W = 10.2;
const GAP = 1.25;
const FOCUS_SCALE = 1.32;

/** Recently played first, then favorites, then the newest installs. */
function shelf(games: Game[]): Game[] {
  const visible = games.filter((g) => !g.hidden && g.installed);
  const recent = visible.filter((g) => g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
  const favs = visible.filter((g) => g.favorite);
  const fresh = [...visible].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
  return [...new Set([...recent, ...favs, ...fresh])].slice(0, SHELF_SIZE);
}

type Button = "play" | "details" | "fav";

const heroVariants: Variants = {
  enter: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.045 } },
  exit: { opacity: 0, transition: { duration: 0.16 } },
};
const item: Variants = {
  enter: { opacity: 0, x: 28, filter: "blur(6px)" },
  show: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.55, ease } },
  exit: { opacity: 0, x: -16, transition: { duration: 0.16 } },
};

function Hero({ game, running, zone, btn, onPress }: { game: Game; running: boolean; zone: string; btn: number; onPress: (b: Button) => void }) {
  const t = game.playtimeMinutes;
  const buttons: Button[] = ["play", "details", "fav"];
  return (
    <motion.section className="hero" variants={heroVariants} initial="enter" animate="show" exit="exit">
      <motion.div className="hero-eyebrow" variants={item}>
        <SourceIcon source={game.source} />
        <span>{sourceLabel(game)}</span>
        {running && <span className="live"><span className="live-dot" />Running</span>}
      </motion.div>
      <motion.div className="hero-title" variants={item}>
        <Img srcs={game.art.logo} className="hero-logo" trim fallback={<h1 className="hero-name">{game.name}</h1>} />
      </motion.div>
      <motion.div className="hero-stats" variants={item}>
        <Stat value={t ? hours(t) : "—"} unit={t ? (t >= 60 ? "h" : "min") : undefined} label="Played" />
        <Stat value={lastPlayed(game.lastPlayed)} label="Last played" />
        {game.achievements && <AchievementsStat a={game.achievements} />}
        <Stat value={size(game.sizeBytes)} label="On disk" />
      </motion.div>
      <motion.div className="hero-actions" variants={item}>
        {buttons.map((b, n) => (
          <button
            key={b}
            className={`btn ${b === "play" ? "btn-play" : "btn-round"} ${zone === "hub" && n === btn ? "is-focused" : ""} ${b === "fav" && game.favorite ? "is-on" : ""}`}
            onClick={() => onPress(b)}
          >
            {b === "play" ? (
              <>
                <svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z" /></svg>
                {running ? "Resume" : "Play"}
              </>
            ) : b === "details" ? (
              <svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" className="star"><path d="M12 3.5l2.5 5.4 5.9.6-4.4 4 1.3 5.8L12 16.4l-5.3 2.9L8 13.5l-4.4-4 5.9-.6z" /></svg>
            )}
          </button>
        ))}
      </motion.div>
    </motion.section>
  );
}

function LibraryCard({ count, focused, onClick }: { count: number; focused: boolean; onClick: () => void }) {
  return (
    <div className={`cover library-card ${focused ? "is-focused" : ""}`} onClick={onClick}>
      <div className="cover-frame">
        <div className="library-card-inner">
          <svg viewBox="0 0 24 24">
            <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
          </svg>
          <span className="library-card-count">{count}</span>
          <span className="library-card-label">Game Library</span>
        </div>
      </div>
    </div>
  );
}

export function Home({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const loaded = useStore((s) => s.loaded);
  const scanning = useStore((s) => s.scanning);
  const running = useStore((s) => s.running);
  const list = useMemo(() => shelf(games), [games]);
  const total = useMemo(() => games.filter((g) => !g.hidden && g.installed).length, [games]);
  const rem = useRem();

  // Focus follows a game, not a slot: the shelf reorders when something gets played.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [dir, setDir] = useState(1);
  const [zone, setZone] = useState<"rail" | "hub">("rail");
  const [btn, setBtn] = useState(0);

  const keyAt = (i: number) => (i >= list.length ? LIBRARY_KEY : list[i].id);
  const found = focusKey === LIBRARY_KEY ? list.length : list.findIndex((g) => g.id === focusKey);
  const c = found >= 0 ? found : 0; // list.length = the library card
  const game: Game | undefined = list[c];
  const heroGame = useSettled(game, 70);
  const buttons: Button[] = ["play", "details", "fav"];

  useEffect(() => {
    if (active && game) setFocus(game);
  }, [active, game]);

  const openLibrary = () => useStore.setState({ view: "library" });
  const press = (b: Button) => {
    if (!game) return;
    if (b === "play") launch(game);
    if (b === "details") useStore.setState({ detailsId: game.id });
    if (b === "fav") toggleFavorite(game);
  };
  const move = (d: number) => {
    const next = c + d;
    if (next < 0 || next > list.length) return "edge" as const;
    setDir(d);
    setFocusKey(keyAt(next));
  };

  useInput(
    (a) => {
      if (!list.length) {
        if (a === "a") return void rescan();
        return false;
      }
      if (zone === "hub") {
        switch (a) {
          case "left":
            return btn > 0 ? setBtn(btn - 1) : "edge";
          case "right":
            return btn < buttons.length - 1 ? setBtn(btn + 1) : "edge";
          case "down":
          case "b":
            return setZone("rail");
          case "up":
            return "edge";
          case "a":
            press(buttons[btn]);
            return buttons[btn] === "play" ? "silent" : undefined;
          case "y":
            return press("details");
          case "x":
            return press("fav");
          default:
            return false;
        }
      }
      switch (a) {
        case "left":
          return move(-1);
        case "right":
          return move(1);
        case "up":
          if (!game) return "edge";
          setBtn(0);
          return setZone("hub");
        case "down":
          return "edge";
        case "a":
          if (!game) return openLibrary();
          launch(game);
          return "silent";
        case "y":
          return game ? press("details") : "edge";
        case "x":
          return game ? press("fav") : "edge";
        default:
          return false;
      }
    },
    Layer.view,
    active,
  );
  const isRunning = !!game && running?.id === game.id;
  useHints(
    !list.length
      ? [["a", "Scan again"], ["menu", "Control center"]]
      : !game
        ? [["a", "Open library"], ["view", "Search"], ["menu", "Control center"]]
        : [["a", isRunning ? "Resume" : "Play"], ["y", "Details"], ["x", game.favorite ? "Unfavorite" : "Favorite"], ["view", "Search"], ["menu", "Control center"]],
    Layer.view,
    active,
  );

  if (loaded && !list.length) {
    return (
      <main className="home">
        <div className="empty-state">
          <div className="eyebrow">{scanning ? "Looking for games…" : "Nothing here yet"}</div>
          <h1>No games found</h1>
          <p>
            Mantel reads your Steam, Epic Games, GOG, Xbox / Game Pass and Ubisoft Connect libraries.
            Install something in any of them, or add your own in Settings.
          </p>
          <span className="btn btn-play is-focused"><Glyph b="a" />Scan again</span>
        </div>
      </main>
    );
  }

  // Keep the focused card in the second slot so the previous one peeks in from the left.
  const anchor = Math.min(c, 1);
  const step = (CARD_W + GAP) * rem;
  const extra = CARD_W * (FOCUS_SCALE - 1) * rem;
  const xOf = (i: number) => (i - c + anchor) * step + (i > c ? extra : 0);

  return (
    <main className={`home zone-${zone}`}>
      <div className="hero-layer">
      <AnimatePresence mode="popLayout" initial={false}>
        {heroGame && (
          <Hero
            key={heroGame.id}
            game={heroGame}
            running={running?.id === heroGame.id}
            zone={zone}
            btn={btn}
            onPress={(b) => {
              setZone("hub");
              setBtn(buttons.indexOf(b));
              press(b);
            }}
          />
        )}
      </AnimatePresence>
      </div>

      <div className="shelf" data-dir={dir > 0 ? "r" : "l"}>
        <motion.div className="shelf-glow" animate={{ x: anchor * step }} transition={spring.rail} />
        {[...list, null].map((g, i) => {
          const focused = i === c;
          const hidden = i < c - anchor || xOf(i) > 125 * rem;
          return (
            <motion.div
              key={g?.id ?? "library"}
              className="shelf-slot"
              initial={false}
              animate={{ x: xOf(i), scale: focused ? FOCUS_SCALE : 1, opacity: hidden ? 0 : zone === "hub" && !focused ? 0.45 : 1 }}
              transition={spring.rail}
            >
              {g ? (
                <Cover
                  game={g}
                  focused={focused && zone === "rail"}
                  running={running?.id === g.id}
                  className={focused ? "is-current" : ""}
                  lazy={i > 10}
                  onClick={() => {
                    setZone("rail");
                    if (focused) launch(g);
                    else {
                      setDir(i > c ? 1 : -1);
                      setFocusKey(keyAt(i));
                    }
                  }}
                />
              ) : (
                <LibraryCard count={total} focused={focused && zone === "rail"} onClick={openLibrary} />
              )}
            </motion.div>
          );
        })}
      </div>
    </main>
  );
}
