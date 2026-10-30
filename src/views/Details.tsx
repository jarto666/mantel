import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, toSrc } from "../api";
import { SourceIcon } from "../components/Glyph";
import { useHints } from "../components/Hints";
import { Img } from "../components/Img";
import { AchievementsStat, Stat } from "../components/Stat";
import { AchievementList, TROPHY } from "../components/AchievementList";
import { useScrollFocus } from "../hooks";
import { Layer, useInput } from "../input";
import { ease, spring } from "../motion";
import { gameById, launch, rescan, setHidden, sourceLabel, toast, toggleFavorite, useStore } from "../store";
import { TextPrompt } from "../components/TextPrompt";
import type { Details as Info, Game } from "../types";
import { hours, lastPlayed, placeholderHue, size, SOURCE_NAME } from "../util";

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
  run: () => void;
}

function actionsFor(game: Game, running: boolean, showAchievements: () => void): Action[] {
  const close = () => useStore.setState({ detailsId: null });
  const list: Action[] = [
    {
      id: "play",
      label: !game.installed ? `Install via ${SOURCE_NAME[game.source]}` : running ? "Resume" : "Play",
      primary: true,
      icon: game.installed ? <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" /> : <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
      run: () => {
        close();
        launch(game);
      },
    },
    {
      id: "fav",
      label: game.favorite ? "Favorited" : "Favorite",
      icon: <path d="M12 3.5l2.5 5.4 5.9.6-4.4 4 1.3 5.8L12 16.4l-5.3 2.9L8 13.5l-4.4-4 5.9-.6z" fill={game.favorite ? "currentColor" : "none"} />,
      run: () => toggleFavorite(game),
    },
  ];
  if (game.achievements) {
    list.push({ id: "achievements", label: "Achievements", icon: TROPHY, run: showAchievements });
  }
  if (game.installDir) {
    list.push({
      id: "folder",
      label: "Folder",
      icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
      run: () => api.openGameFolder(game.id).catch((e) => toast(String(e), "warn")),
    });
  }
  if (game.source === "custom") {
    list.push({
      id: "rename",
      label: "Rename",
      icon: <path d="M4 20h4l10-10-4-4L4 16zM13.5 6.5l4 4" />,
      run: () => useStore.setState({ renaming: game.id }),
    });
    list.push({
      id: "remove",
      label: "Remove",
      icon: <path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
      run: async () => {
        close();
        useStore.setState({ games: await api.removeCustomGame(game.id) });
        toast(`Removed ${game.name} from Mantel`);
      },
    });
  } else {
    list.push({
      id: "hide",
      label: "Hide",
      icon: <><path d="M3 3l18 18" /><path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c5 0 9 4.5 10 7a12 12 0 0 1-3 4.2M6.6 6.6C4.4 8 2.8 10.2 2 12c1 2.5 5 7 10 7 1.7 0 3.3-.5 4.6-1.3" /></>,
      run: () => {
        close();
        setHidden(game, true);
      },
    });
  }
  return list;
}

export function Details() {
  const detailsId = useStore((s) => s.detailsId);
  const games = useStore((s) => s.games);
  const running = useStore((s) => s.running);
  const renaming = useStore((s) => s.renaming);
  const game = detailsId ? games.find((g) => g.id === detailsId) ?? gameById(detailsId) : null;
  const open = !!game;

  const [info, setInfo] = useState<Info | null>(null);
  const [zone, setZone] = useState<"actions" | "shots">("actions");
  const [ai, setAi] = useState(0);
  const [si, setSi] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);
  const [achievements, setAchievements] = useState(false);
  const shots = useRef<HTMLDivElement>(null);
  useScrollFocus(shots, `${zone}${si}`, { axis: "x" });

  useEffect(() => {
    setInfo(null);
    setZone("actions");
    setAi(0);
    setSi(0);
    setViewer(null);
    setAchievements(false);
    if (!detailsId) return;
    let live = true;
    api.getDetails(detailsId).then((d) => live && setInfo(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, [detailsId]);

  const actions = game ? actionsFor(game, running?.id === game.id, () => setAchievements(true)) : [];
  const screenshots = info?.screenshots ?? [];
  const close = () => useStore.setState({ detailsId: null });

  useInput(
    (a) => {
      if (viewer !== null) {
        if (a === "left") return viewer > 0 ? setViewer(viewer - 1) : "edge";
        if (a === "right") return viewer < screenshots.length - 1 ? setViewer(viewer + 1) : "edge";
        if (a === "b" || a === "a") return setViewer(null);
        return "silent";
      }
      switch (a) {
        case "b":
          return close();
        case "left":
          if (zone === "actions") return ai > 0 ? setAi(ai - 1) : "edge";
          return si > 0 ? setSi(si - 1) : "edge";
        case "right":
          if (zone === "actions") return ai < actions.length - 1 ? setAi(ai + 1) : "edge";
          return si < screenshots.length - 1 ? setSi(si + 1) : "edge";
        case "down":
          if (zone === "actions" && screenshots.length) return setZone("shots");
          return "edge";
        case "up":
          if (zone === "shots") return setZone("actions");
          return "edge";
        case "a":
          if (zone === "shots") return setViewer(si);
          actions[ai]?.run();
          return actions[ai]?.id === "play" ? "silent" : undefined;
        case "x":
          if (game) toggleFavorite(game);
          return;
        case "lb":
        case "rb":
        case "lt":
        case "rt":
          return "silent";
        default:
          return false;
      }
    },
    Layer.page,
    open,
  );
  useHints(
    viewer !== null
      ? [["dpad", "Browse"], ["b", "Back"]]
      : zone === "shots"
        ? [["a", "View"], ["b", "Back"]]
        : [["a", "Select"], ["x", "Favorite"], ["b", "Back"]],
    Layer.page,
    open,
  );

  if (!game) return null;
  const t = game.playtimeMinutes;

  const enter = (delay: number) => ({
    initial: { opacity: 0, y: 22, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 0.6, delay, ease },
  });

  return (
    <div className="details" key={game.id}>
      <div className="details-body">
        <motion.div className="details-eyebrow" {...enter(0.05)}>
          <SourceIcon source={game.source} />
          <span>{sourceLabel(game)}</span>
          {info?.genres.slice(0, 3).map((g) => <span key={g}>{g}</span>)}
        </motion.div>
        <motion.div className="details-title" {...enter(0.1)}>
          <Img srcs={game.art.logo} className="details-logo" trim fallback={<h1 className="hero-name">{game.name}</h1>} />
        </motion.div>

        <motion.div className="hero-stats" {...enter(0.16)}>
          <Stat value={t ? hours(t) : "—"} unit={t ? (t >= 60 ? "h" : "min") : undefined} label="Played" />
          <Stat value={lastPlayed(game.lastPlayed)} label="Last played" />
          {game.achievements && <AchievementsStat a={game.achievements} />}
          {info?.metacritic ? <Stat value={String(info.metacritic)} label="Metacritic" /> : null}
          <Stat value={size(game.sizeBytes)} label="On disk" />
        </motion.div>

        <motion.div className="details-actions" {...enter(0.22)}>
          {actions.map((act, n) => (
            <button
              key={act.id}
              className={`btn ${act.primary ? "btn-play" : "btn-pill"} ${zone === "actions" && n === ai ? "is-focused" : ""}`}
              onClick={() => {
                setZone("actions");
                setAi(n);
                act.run();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                {act.icon}
              </svg>
              {act.label}
            </button>
          ))}
        </motion.div>

        {info?.description && (
          <motion.p className="details-desc" {...enter(0.28)}>
            {info.description}
          </motion.p>
        )}
        {(info?.developers?.length || info?.releaseDate) && (
          <motion.div className="details-credits" {...enter(0.32)}>
            {info?.developers?.[0] && <span>{info.developers[0]}</span>}
            {info?.releaseDate && <span>{info.releaseDate}</span>}
          </motion.div>
        )}
      </div>

      <motion.div
        className="details-card"
        initial={{ opacity: 0, x: 140, rotateY: -38, scale: 0.92 }}
        animate={{ opacity: 1, x: 0, rotateY: -14, scale: 1 }}
        transition={{ ...spring.soft, delay: 0.08 }}
      >
        <div className="details-card-frame">
          <Img srcs={game.art.cover} className="details-card-img" fallback={
              <div
                className="cover-placeholder"
                data-initial={game.name.trim()[0]?.toUpperCase()}
                style={{ "--h1": placeholderHue(game.name), "--h2": (placeholderHue(game.name) + 42) % 360 } as React.CSSProperties}
              >
                <span>{game.name}</span>
              </div>
            } />
          <div className="cover-gloss" />
        </div>
      </motion.div>

      {screenshots.length > 0 && (
        <motion.div className={`shots ${zone === "shots" ? "is-active" : ""}`} {...enter(0.36)}>
          <div className="eyebrow">Media</div>
          <div className="shots-rail" ref={shots}>
            {screenshots.map((s, n) => (
              <div
                key={s}
                className={`shot ${zone === "shots" && n === si ? "is-focused" : ""}`}
                onClick={() => {
                  setZone("shots");
                  setSi(n);
                  setViewer(n);
                }}
              >
                <img src={toSrc(s)} alt="" loading="lazy" draggable={false} />
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {renaming === game.id && (
        <TextPrompt
          title="Rename"
          hint="This name is used for search and for finding artwork."
          initial={game.name}
          onDone={async (name) => {
            useStore.setState({ renaming: null });
            if (!name || name === game.name) return;
            try {
              useStore.setState({ games: await api.renameCustomGame(game.id, name) });
              toast(`Renamed to ${name}`, "good");
              rescan(true);
            } catch (e) {
              toast(String(e), "warn");
            }
          }}
        />
      )}

      <AnimatePresence>{achievements && <AchievementList game={game} onClose={() => setAchievements(false)} />}</AnimatePresence>

      <AnimatePresence>
        {viewer !== null && screenshots[viewer] && (
          <motion.div className="viewer" onClick={() => setViewer(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.img
                key={viewer}
                src={toSrc(screenshots[viewer])}
                alt=""
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease }}
              />
            </AnimatePresence>
            <div className="viewer-count">
              {viewer + 1} / {screenshots.length}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
