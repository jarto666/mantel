import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, toSrc } from "../api";
import { DOWNLOAD, SourceIcon } from "../components/Glyph";
import { useHints } from "../components/Hints";
import { Img } from "../components/Img";
import { AchievementsStat, InstallStat, Stat } from "../components/Stat";
import { AchievementList, TROPHY } from "../components/AchievementList";
import { ArtPicker } from "../components/ArtPicker";
import { PackagePicker } from "../components/PackagePicker";
import { useScrollFocus } from "../hooks";
import { errorText, t } from "../i18n";
import { Layer, useInput } from "../input";
import { ease, spring } from "../motion";
import { askCancel, checkAccess, gameById, isCatalog, isStoreItem, launch, rescan, setHidden, sourceLabel, startInstall, toast, toggleFavorite, uninstall, useStore } from "../store";
import { TextPrompt } from "../components/TextPrompt";
import { watchTrailer } from "../trailer";
import type { Achievement, BundleItem, Details as Info, Game, InstallProgress, Video } from "../types";
import { hours, installLabel, lastPlayed, placeholderHue, size } from "../util";

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
  /** Fills the button from the left, in percent. */
  progress?: number;
  /** Waiting for a second press. */
  armed?: boolean;
  /** Already at it: more presses do nothing. */
  busy?: boolean;
  run: () => void;
}

type Media = ({ kind: "video" } & Video) | { kind: "image"; url: string };

const TRASH = <path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />;

/** A trailer opened to watch: full size, with sound. */
function TrailerPlayer({ video, paused, onEnd }: { video: Video; paused: boolean; onEnd: () => void }) {
  const el = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!el.current) return;
    useStore.setState({ watching: true });
    const stream = new AbortController();
    watchTrailer(el.current, video.url, Math.round(innerHeight * devicePixelRatio), stream.signal).catch((e) => {
      if (stream.signal.aborted) return;
      api.log("warn", `trailer ${video.url}: ${e}`);
      toast(t("This video couldn't be played"), "warn");
      onEnd();
    });
    return () => {
      stream.abort();
      useStore.setState({ watching: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.url]);
  useEffect(() => {
    if (!el.current?.src) return;
    if (paused) el.current.pause();
    else el.current.play().catch(() => {});
  }, [paused]);
  return <video ref={el} playsInline poster={video.thumb ?? undefined} onEnded={onEnd} />;
}

function actionsFor(game: Game, running: boolean, install: InstallProgress | undefined, offAccount: boolean, beginInstall: (anyway?: boolean) => void, showAchievements: () => void, pickArt: () => void): Action[] {
  if (isStoreItem(game)) {
    return [{
      id: "store",
      label: game.source === "steam" ? t("View on Steam") : t("Open in Xbox app"),
      primary: true,
      icon: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
      run: () => void (game.source === "steam" ? api.openSteamStore(game.steamAppId!) : api.openXboxStore(game.id.replace("msstore:", ""))).catch((e) => toast(errorText(e), "warn")),
    }];
  }
  const close = () => useStore.setState({ detailsId: null });
  const list: Action[] = [
    {
      id: "play",
      label: !game.installed ? t("Install via {store}", { store: sourceLabel(game) }) : running ? t("Resume") : t("Play"),
      primary: true,
      icon: game.installed ? <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" /> : DOWNLOAD,
      run: () => {
        // A Steam download stays on this page, which follows it.
        if (game.installed || game.source !== "steam") close();
        launch(game);
      },
    },
    {
      id: "fav",
      label: game.favorite ? t("Favorited") : t("Favorite"),
      icon: <path d="M12 3.5l2.5 5.4 5.9.6-4.4 4 1.3 5.8L12 16.4l-5.3 2.9L8 13.5l-4.4-4 5.9-.6z" fill={game.favorite ? "currentColor" : "none"} />,
      run: () => toggleFavorite(game),
    },
  ];
  if (install) {
    const bar: Action = { id: "play", label: installLabel(install), primary: true, progress: install.percent, icon: DOWNLOAD, run: () => {} };
    if (install.state === "done" || (game.source === "steam" && install.state === "installing")) return [bar];
    const cancel: Action = { id: "cancel", label: t("Cancel"), busy: install.state === "canceling", icon: <path d="M6 6l12 12M18 6 6 18" />, run: () => askCancel(game) };
    if (game.source !== "steam" || install.state !== "paused") return [bar, cancel];
    return [bar, { id: "steam", label: t("Open Steam"), icon: DOWNLOAD, run: () => void api.openSteamDownloads().catch((e) => toast(errorText(e), "warn")) }, cancel];
  }
  // Not in the library: installing is all there is to do, right here through Windows' Store
  // installer, or in the Xbox app.
  if (isCatalog(game)) {
    const xbox: Action = {
      id: "xbox",
      label: t("Open in Xbox app"),
      icon: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
      run: () => launch(game),
    };
    // Off the account the Xbox app comes first, to subscribe or buy. The Store's answer isn't
    // the last word, so installing stays possible.
    if (game.tags?.includes("external")) return [{ ...xbox, primary: true }];
    if (offAccount) return [{ ...xbox, primary: true }, { ...list[0], primary: false, label: t("Install anyway"), run: () => beginInstall(true) }];
    return [{ ...list[0], label: t("Install"), run: () => beginInstall() }, xbox];
  }
  if (game.achievements) {
    list.push({ id: "achievements", label: t("Achievements"), icon: TROPHY, run: showAchievements });
  }
  list.push({
    id: "art",
    label: t("Artwork"),
    icon: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-9 9" /></>,
    run: pickArt,
  });
  if (game.installDir) {
    list.push({
      id: "folder",
      label: t("Folder"),
      icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
      run: () => api.openGameFolder(game.id).catch((e) => toast(errorText(e), "warn")),
    });
  }
  if (game.source === "custom") {
    list.push({
      id: "rename",
      label: t("Rename"),
      icon: <path d="M4 20h4l10-10-4-4L4 16zM13.5 6.5l4 4" />,
      run: () => useStore.setState({ renaming: game.id }),
    });
    list.push({
      id: "remove",
      label: t("Remove"),
      icon: TRASH,
      run: async () => {
        close();
        useStore.setState({ games: await api.removeCustomGame(game.id) });
        toast(t("Removed {name} from Mantel", { name: game.name }));
      },
    });
  } else {
    list.push({
      id: "hide",
      label: t("Hide"),
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
  const [achList, setAchList] = useState<Achievement[] | null>(null);
  const [achError, setAchError] = useState<string | null>(null);
  const [pickingArt, setPickingArt] = useState(false);
  const [armed, setArmed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [choosing, setChoosing] = useState<{ items: BundleItem[]; anyway: boolean } | null>(null);
  const uninstalling = useStore((s) => s.uninstalling !== null && s.uninstalling === detailsId);
  const offAccount = useStore((s) => detailsId !== null && s.access[detailsId] === false);
  const install = useStore((s) => (detailsId ? s.installs[detailsId] : undefined));
  const shots = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useScrollFocus(shots, `${zone}${si}`, { axis: "x" });
  // Whichever row has the focus is what's in view.
  useEffect(() => {
    const box = page.current;
    box?.scrollTo({ top: zone === "shots" ? box.scrollHeight : 0, behavior: "smooth" });
  }, [zone]);

  useEffect(() => {
    setInfo(null);
    setZone("actions");
    setAi(0);
    setSi(0);
    setViewer(null);
    setAchievements(false);
    setAchList(null);
    setAchError(null);
    setPickingArt(false);
    setArmed(false);
    setPaused(false);
    setChoosing(null);
    if (!detailsId) return;
    let live = true;
    api
      .getDetails(detailsId)
      .then((d) => {
        if (!live) return;
        setInfo(d);
        // A catalog game's logo is looked up on first view; everything showing the game gets it.
        const logo = d?.logo ?? [];
        if (logo.length && !gameById(detailsId)?.art.logo.length) {
          useStore.setState((s) => {
            const listed = s.storeGames[detailsId];
            return {
              catalog: s.catalog.map((g) => (g.id === detailsId ? { ...g, art: { ...g.art, logo } } : g)),
              storeGames: listed ? { ...s.storeGames, [detailsId]: { ...listed, art: { ...listed.art, logo } } } : s.storeGames,
            };
          });
        }
      })
      .catch(() => {});
    const opened = gameById(detailsId);
    if (opened && isCatalog(opened) && !opened.tags?.includes("external")) checkAccess(opened);
    // Loaded up front: the list opens at once, and Xbox titles whose count Xbox Live left
    // out get it before the player looks at the stat.
    if (gameById(detailsId)?.achievements) {
      api
        .getAchievements(detailsId)
        .then((list) => {
          if (!live) return;
          setAchList(list);
          const unlocked = list.filter((a) => a.unlocked).length;
          if (list.length)
            useStore.setState((s) => ({
              games: s.games.map((g) =>
                g.id === detailsId && g.achievements && !g.achievements.total
                  ? { ...g, achievements: { ...g.achievements, unlocked, total: list.length, percent: Math.round((100 * unlocked) / list.length) } }
                  : g,
              ),
            }));
        })
        .catch((e) => live && setAchError(errorText(e)));
    }
    return () => {
      live = false;
    };
  }, [detailsId]);

  // A bundle with parts to leave out asks first.
  const beginInstall = async (anyway = false) => {
    if (!game) return;
    const details = info ?? (await api.getDetails(game.id).catch(() => null));
    if (details?.items?.length) setChoosing({ items: details.items, anyway });
    else startInstall(game, anyway);
  };
  const actions = game ? actionsFor(game, running?.id === game.id, install, offAccount, beginInstall, () => setAchievements(true), () => setPickingArt(true)) : [];
  if (game?.installed && (game.source === "xbox" || game.source === "steam") && running?.id !== game.id) {
    actions.push({
      id: "uninstall",
      label: uninstalling ? t("Uninstalling…") : armed ? t("Press A again") : t("Uninstall"),
      icon: TRASH,
      armed,
      run: () => {
        if (uninstalling) return;
        // Steam's dialog asks for itself; everything else takes a second press.
        if (game.source !== "steam" && !armed) return setArmed(true);
        setArmed(false);
        uninstall(game);
      },
    });
  }
  const media: Media[] = [...(info?.videos ?? []).map((v) => ({ kind: "video" as const, ...v })), ...(info?.screenshots ?? []).map((url) => ({ kind: "image" as const, url }))];
  const viewing = viewer !== null ? media[viewer] : undefined;
  const view = (n: number) => {
    setPaused(false);
    setViewer(n);
  };
  const close = () => useStore.setState({ detailsId: null });

  useInput(
    (a) => {
      if (viewer !== null) {
        if (a === "left") return viewer > 0 ? view(viewer - 1) : "edge";
        if (a === "right") return viewer < media.length - 1 ? view(viewer + 1) : "edge";
        if (a === "a" && viewing?.kind === "video") return setPaused(!paused);
        if (a === "b" || a === "a") return setViewer(null);
        return "silent";
      }
      if (a !== "a") setArmed(false);
      switch (a) {
        case "b":
          return close();
        case "left":
          if (zone === "actions") return ai > 0 ? setAi(ai - 1) : "edge";
          return si > 0 ? setSi(si - 1) : "edge";
        case "right":
          if (zone === "actions") return ai < actions.length - 1 ? setAi(ai + 1) : "edge";
          return si < media.length - 1 ? setSi(si + 1) : "edge";
        case "down":
          if (zone === "actions" && media.length) return setZone("shots");
          return "edge";
        case "up":
          if (zone === "shots") return setZone("actions");
          return "edge";
        case "a":
          if (zone === "shots") return view(si);
          actions[ai]?.run();
          return actions[ai]?.id === "play" ? "silent" : undefined;
        case "x":
          if (game && !isCatalog(game) && !isStoreItem(game)) toggleFavorite(game);
          return;
        case "lt":
        case "rt":
          return "silent";
        default:
          // LB and RB among them: the tabs stay in reach, leaving the page.
          return false;
      }
    },
    Layer.page,
    open,
  );
  useHints(
    viewing?.kind === "video"
      ? [["dpad", "Browse"], ["a", paused ? "Resume" : "Pause"], ["b", "Back"]]
      : viewer !== null
      ? [["dpad", "Browse"], ["b", "Back"]]
      : zone === "shots"
        ? [["a", "View"], ["b", "Back"]]
        : armed
          ? [["a", "Confirm"], ["b", "Back"]]
          : game && (isCatalog(game) || isStoreItem(game))
          ? [["a", "Select"], ["b", "Back"]]
          : [["a", "Select"], ["x", game?.favorite ? "Unfavorite" : "Favorite"], ["b", "Back"]],
    Layer.page,
    open,
  );

  if (!game) return null;
  const played = game.playtimeMinutes;

  const enter = (delay: number) => ({
    initial: { opacity: 0, y: 22, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 0.6, delay, ease },
  });

  return (
    <div className="details" key={game.id}>
      <div className="details-page" ref={page}>
      <div className="details-body">
        <motion.div className="details-eyebrow" {...enter(0.05)}>
          <SourceIcon source={game.source} />
          <span>{isCatalog(game) ? "PC Game Pass" : sourceLabel(game)}</span>
          {game.tags?.includes("leaving") && <span className="details-leaving">{t("Leaving soon")}</span>}
          {game.tags?.includes("new") && <span>{t("New")}</span>}
          {info?.genres?.slice(0, 3).map((g) => <span key={g}>{g}</span>)}
        </motion.div>
        <motion.div className="details-title" {...enter(0.1)}>
          <Img srcs={game.art.logo} className="details-logo" trim fallback={<h1 className="hero-name">{game.name}</h1>} />
        </motion.div>

        {isStoreItem(game) && (game.price || info?.metacritic) && <motion.div className="hero-stats" {...enter(0.16)}>
          {game.price && <Stat value={t(game.price)} label={game.discount ? t("Price · {percent}% off", { percent: game.discount }) : t("Price")} />}
          {info?.metacritic ? <Stat value={String(info.metacritic)} label="Metacritic" /> : null}
        </motion.div>}
        {!isCatalog(game) && !isStoreItem(game) && !install && <motion.div className="hero-stats" {...enter(0.16)}>
          <Stat value={played ? hours(played) : "—"} unit={played ? (played >= 60 ? t("h") : t("min")) : undefined} label={t("Played")} />
          <Stat value={lastPlayed(game.lastPlayed, game.playtimeMinutes > 0)} label={t("Last played")} />
          {game.achievements && <AchievementsStat a={game.achievements} />}
          {info?.metacritic ? <Stat value={String(info.metacritic)} label="Metacritic" /> : null}
          <Stat value={size(game.sizeBytes)} label={t("On disk")} />
        </motion.div>}
        {(install || (isCatalog(game) && game.sizeBytes)) && <motion.div className="hero-stats" {...enter(0.16)}>
          {install ? <InstallStat install={install} total={game.sizeBytes} /> : <Stat value={size(game.sizeBytes)} label={t("Download size")} />}
        </motion.div>}

        <motion.div className={`details-actions ${actions.length > 3 ? "is-crowded" : ""}`} {...enter(0.22)}>
          {actions.map((act, n) => (
            <button
              key={act.id}
              className={`btn ${act.primary ? "btn-play" : "btn-pill"} ${zone === "actions" && n === ai ? "is-focused" : ""} ${act.progress != null ? "has-progress" : ""} ${act.armed ? "is-armed" : ""} ${act.busy ? "is-busy" : ""}`}
              style={act.progress != null ? ({ "--progress": act.progress / 100 } as React.CSSProperties) : undefined}
              onClick={() => {
                setZone("actions");
                setAi(n);
                if (act.id !== "uninstall") setArmed(false);
                act.run();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                {act.icon}
              </svg>
              <span className="btn-label"><span>{act.label}</span></span>
            </button>
          ))}
        </motion.div>

        {isCatalog(game) && game.tags?.includes("external") ? (
          <p className="details-note is-info">{t("This game installs through its publisher's launcher. The Xbox app can start the install.")}</p>
        ) : (
          isCatalog(game) && offAccount && !install && <p className="details-note">{t("This game isn't on your Microsoft account. Without an active Game Pass or a purchase it won't start after downloading.")}</p>
        )}
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
        {!!info?.features?.length && (
          <motion.div className="details-tags" {...enter(0.34)}>
            {info.features.map((f) => <span key={f}>{t(f)}</span>)}
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

      {media.length > 0 && (
        <motion.div className={`shots ${zone === "shots" ? "is-active" : ""}`} {...enter(0.36)}>
          <div className="eyebrow">{t("Media")}</div>
          <div className="shots-rail" ref={shots}>
            {media.map((item, n) => (
              <div
                key={item.url}
                className={`shot ${zone === "shots" && n === si ? "is-focused" : ""}`}
                onClick={() => {
                  setZone("shots");
                  setSi(n);
                  view(n);
                }}
              >
                <img src={toSrc(item.kind === "video" ? item.thumb ?? game.art.hero[0] ?? "" : item.url)} alt="" loading="lazy" draggable={false} />
                {item.kind === "video" && (
                  <span className="shot-play">
                    <svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z" /></svg>
                  </span>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      )}
      </div>

      {renaming === game.id && (
        <TextPrompt
          title={t("Rename")}
          hint={t("This name is used for search and for finding artwork.")}
          initial={game.name}
          onDone={async (name) => {
            useStore.setState({ renaming: null });
            if (!name || name === game.name) return;
            try {
              useStore.setState({ games: await api.renameCustomGame(game.id, name) });
              toast(t("Renamed to {name}", { name }), "good");
              rescan(true);
            } catch (e) {
              toast(errorText(e), "warn");
            }
          }}
        />
      )}

      {choosing && (
        <PackagePicker game={game} items={choosing.items} onClose={() => setChoosing(null)} onInstall={(chosen) => startInstall(game, choosing.anyway, chosen)} />
      )}

      <AnimatePresence>{pickingArt && <ArtPicker game={game} onClose={() => setPickingArt(false)} />}</AnimatePresence>

      <AnimatePresence>{achievements && <AchievementList game={game} list={achList} error={achError} onClose={() => setAchievements(false)} />}</AnimatePresence>

      <AnimatePresence>
        {viewer !== null && viewing && (
          <motion.div className="viewer" onClick={() => setViewer(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {viewing.kind === "video" ? (
              <>
                <TrailerPlayer key={viewing.url} video={viewing} paused={paused} onEnd={() => setViewer(null)} />
                {paused && (
                  <span className="viewer-paused">
                    <svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z" /></svg>
                  </span>
                )}
              </>
            ) : (
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.img
                  key={viewer}
                  src={toSrc(viewing.url)}
                  alt=""
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease }}
                />
              </AnimatePresence>
            )}
            <div className="viewer-count">
              {viewer + 1} / {media.length}
              {viewing.kind === "video" && viewing.title ? ` · ${viewing.title}` : ""}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
