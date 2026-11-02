import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useScrollFocus } from "../hooks";
import { errorText, t } from "../i18n";
import { Layer, useInput } from "../input";
import { ease } from "../motion";
import { toast, useStore } from "../store";
import type { ArtChoices, ArtKind, Game, Listing, PickEntry } from "../types";
import { Glyph } from "./Glyph";
import { useHints, type Hint } from "./Hints";
import { Img } from "./Img";

const KINDS: { id: ArtKind; label: string; cols: number }[] = [
  { id: "cover", label: "Cover", cols: 6 },
  { id: "hero", label: "Background", cols: 3 },
  { id: "logo", label: "Logo", cols: 4 },
];

const ICON = {
  file: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-9 9" /></>,
  dir: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  drive: <><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M5 13l2.5-7h9L19 13M17 16.5h.01" /></>,
};
const OPENS = new Set<PickEntry["kind"]>(["dir", "place", "drive"]);

interface Tile {
  key: string;
  label?: string;
  srcs?: string[];
  /** The source to save; undefined for the tile that opens the file browser. */
  src?: string | null;
}

/**
 * A game's cover, background or logo, picked with a gamepad: community art from SteamGridDB,
 * an image file from this PC, or the store's own art again.
 */
export function ArtPicker({ game, onClose }: { game: Game; onClose: () => void }) {
  const [kind, setKind] = useState<ArtKind>("cover");
  const [found, setFound] = useState<Partial<Record<ArtKind, ArtChoices | string>>>({});
  const [index, setIndex] = useState(0);
  /** Set while browsing for an image file. */
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (found[kind] !== undefined) return;
    let live = true;
    api
      .artChoices(game.id, kind)
      .then((c) => live && setFound((f) => ({ ...f, [kind]: c })))
      .catch((e) => live && setFound((f) => ({ ...f, [kind]: errorText(e) })));
    return () => {
      live = false;
    };
  }, [game.id, kind, found]);

  const meta = KINDS.find((k) => k.id === kind)!;
  const choices = typeof found[kind] === "object" ? (found[kind] as ArtChoices) : null;
  const error = typeof found[kind] === "string" ? (found[kind] as string) : null;
  const picked = choices?.picked ?? null;
  const tiles: Tile[] = [
    { key: "file", label: t("Image file") },
    { key: "store", label: t("Store art"), srcs: game.art[kind].filter((s) => s !== picked), src: null },
    ...(picked && !/^https:/.test(picked) ? [{ key: picked, label: t("Your image"), srcs: [picked], src: picked }] : []),
    ...(choices?.options ?? []).map((o) => ({ key: o.url, srcs: [o.thumb], src: o.url })),
  ];
  const current = picked ?? "store";
  const i = Math.min(index, tiles.length - 1);
  const entries = listing?.entries ?? [];
  const e = Math.min(index, Math.max(0, entries.length - 1));
  useScrollFocus(grid, `${kind}:${i}`);
  useScrollFocus(list, `${listing?.path}:${e}`);

  async function pick(src: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const games = await api.setArt(game.id, kind, src);
      useStore.setState({ games });
      const now = src === null ? null : games.find((g) => g.id === game.id)?.art[kind][0] ?? src;
      setFound((f) => ({ ...f, [kind]: { ...(choices ?? { options: [], connected: false }), picked: now } }));
      toast(src === null ? t("{kind}: back to the store's art", { kind: t(meta.label) }) : t("{kind} changed", { kind: t(meta.label) }), "good");
    } catch (err) {
      toast(String(err), "warn");
    } finally {
      setBusy(false);
    }
  }

  async function browse(path: string | null, back = false) {
    try {
      const next = await api.listDir(path, true);
      const from = back ? listing?.path : null;
      setListing(next);
      setIndex(from ? Math.max(0, next.entries.findIndex((x) => x.path === from)) : 0);
    } catch (err) {
      toast(String(err), "warn");
    }
  }

  function activate(tile: Tile) {
    if (tile.src === undefined) return void browse(null);
    if (tile.key !== current) void pick(tile.src);
  }

  function choose(entry: PickEntry) {
    if (OPENS.has(entry.kind)) return void browse(entry.path);
    setListing(null);
    // Onto the "Your image" tile, right after the store's.
    setIndex(2);
    void pick(entry.path);
  }

  const switchKind = (to: ArtKind) => {
    if (to === kind) return "edge" as const;
    setKind(to);
    setIndex(0);
  };
  const k = KINDS.findIndex((x) => x.id === kind);

  useInput(
    (a) => {
      if (busy) return "silent";
      if (listing) {
        switch (a) {
          case "up":
            return e > 0 ? setIndex(e - 1) : "edge";
          case "down":
            return e < entries.length - 1 ? setIndex(e + 1) : "edge";
          case "a":
            if (entries[e]) choose(entries[e]);
            return;
          case "b":
            if (listing.path) return void browse(listing.parent, true);
            setListing(null);
            setIndex(0);
            return;
          case "y":
            if (listing.path) void browse(null, true);
            return;
          default:
            return "silent";
        }
      }
      const cols = meta.cols;
      switch (a) {
        case "left":
          return i % cols > 0 ? setIndex(i - 1) : "edge";
        case "right":
          return i % cols < cols - 1 && i < tiles.length - 1 ? setIndex(i + 1) : "edge";
        case "up":
          return i >= cols ? setIndex(i - cols) : "edge";
        case "down":
          if (i + cols < tiles.length) return setIndex(i + cols);
          // A short last row: land on its last tile.
          return Math.floor(i / cols) < Math.floor((tiles.length - 1) / cols) ? setIndex(tiles.length - 1) : "edge";
        case "lb":
          return k > 0 ? switchKind(KINDS[k - 1].id) : "edge";
        case "rb":
          return k < KINDS.length - 1 ? switchKind(KINDS[k + 1].id) : "edge";
        case "a":
          if (tiles[i]) activate(tiles[i]);
          return;
        case "b":
          return onClose();
        default:
          return "silent";
      }
    },
    Layer.modal,
  );
  const hints: Hint[] = listing
    ? [
        ["a", entries[e] && OPENS.has(entries[e].kind) ? "Open" : "Use"],
        ["b", listing.path ? "Up" : "Back"],
        ...(listing.path ? [["y", "Top"] as Hint] : []),
      ]
    : [
        ["a", "Use"],
        ["lb", "Kind"],
        ["b", "Close"],
      ];
  useHints(hints, Layer.modal);

  const note = listing
    ? listing.path ?? t("Pick a place to start. Folders and pictures only")
    : error
      ? error
      : choices && !choices.connected
        ? t("Connect SteamGridDB in Settings to pick from thousands of covers, backgrounds and logos")
        : choices
          ? choices.options.length
            ? t("From SteamGridDB, best rated first: {n}", { n: choices.options.length })
            : t("SteamGridDB has none for this game yet. Use an image file instead")
          : null;

  return (
    <motion.div className="keyflow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="keyflow-card addgame artpick"
        data-kind={kind}
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease }}
      >
        <h2 className="keyflow-title">{listing ? t("Pick an image") : t("Artwork for {name}", { name: game.name })}</h2>
        {!listing && (
          <div className="addgame-tabs">
            <Glyph b="lb" />
            {KINDS.map((x) => (
              <button key={x.id} className={`addgame-tab ${x.id === kind ? "is-active" : ""}`} onClick={() => switchKind(x.id)}>
                {t(x.label)}
              </button>
            ))}
            <Glyph b="rb" />
          </div>
        )}
        <div className="addgame-where">
          {note ?? (
            <>
              <span className="spinner" /> {t("Looking on SteamGridDB…")}
            </>
          )}
        </div>

        {listing ? (
          <div className="addgame-list" ref={list}>
            {entries.length === 0 && <div className="addgame-empty">{t("No folders or pictures here.")}</div>}
            {entries.map((x, n) => (
              <button
                key={x.path}
                className={`addgame-row ${n === e ? "is-focused" : ""}`}
                onClick={() => {
                  setIndex(n);
                  choose(x);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  {x.kind === "image" ? ICON.file : x.kind === "drive" ? ICON.drive : ICON.dir}
                </svg>
                <span className="addgame-text">
                  <span className="addgame-name">{x.name}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="artpick-grid" ref={grid} style={{ "--cols": meta.cols } as React.CSSProperties}>
            {tiles.map((tile, n) => (
              <button
                key={tile.key}
                className={`artpick-tile ${n === i ? "is-focused" : ""} ${tile.key === current ? "is-current" : ""}`}
                onClick={() => {
                  setIndex(n);
                  activate(tile);
                }}
              >
                {tile.srcs ? (
                  <Img srcs={tile.srcs} className="artpick-img" lazy fallback={<span className="artpick-empty">{tile.key === "store" ? t("None") : ""}</span>} />
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    {ICON.file}
                  </svg>
                )}
                {tile.label && <span className={tile.srcs ? "artpick-label" : undefined}>{tile.label}</span>}
                {tile.key === current && (
                  <span className="artpick-check">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
