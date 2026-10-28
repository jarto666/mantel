import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useScrollFocus } from "../hooks";
import { Layer, useInput } from "../input";
import { ease } from "../motion";
import { rescan, toast, useStore } from "../store";
import type { Listing, PickEntry, Suggestion } from "../types";
import { size } from "../util";
import { Glyph } from "./Glyph";
import { useHints, type Hint } from "./Hints";

type Tab = "suggested" | "browse";

const KIND_ICON: Record<PickEntry["kind"] | "app", React.ReactNode> = {
  drive: <><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M5 13l2.5-7h9L19 13M17 16.5h.01" /></>,
  place: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  dir: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  exe: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 8.5h18M7 13l2.5 2L7 17M12 17h4" /></>,
  lnk: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  url: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.7 2.5 14.3 0 17M12 3.5c-2.5 2.7-2.5 14.3 0 17" /></>,
  bat: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9l3 3-3 3M12 15h5" /></>,
  app: <><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></>,
};

const PICKABLE = new Set(["exe", "lnk", "url", "bat"]);

/**
 * Adding a game by hand without a mouse: shortcuts Mantel found on its own, or a file
 * browser that only shows folders and things that can be launched.
 */
export function AddGame({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("suggested");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [index, setIndex] = useState(0);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.appSuggestions().then(setSuggestions).catch(() => setSuggestions([]));
    api.listDir(null).then(setListing).catch(() => {});
  }, []);

  const rows: { key: string; name: string; sub?: string; kind: PickEntry["kind"] | "app"; pick: () => void }[] =
    tab === "suggested"
      ? (suggestions ?? []).map((s) => ({ key: s.path, name: s.name, sub: s.target, kind: "app", pick: () => add(s.path, s.name, s.target) }))
      : (listing?.entries ?? []).map((e) => ({
          key: e.path,
          name: e.name,
          sub: e.size ? size(e.size) : undefined,
          kind: e.kind,
          pick: () => (PICKABLE.has(e.kind) ? add(e.path) : open(e.path)),
        }));
  const i = Math.min(index, Math.max(0, rows.length - 1));
  useScrollFocus(list, `${tab}:${listing?.path}:${i}`);

  async function open(path: string | null, back = false) {
    try {
      const next = await api.listDir(path);
      setListing(next);
      // Going up returns the cursor to the folder we came out of.
      const from = back ? listing?.path : null;
      setIndex(from ? Math.max(0, next.entries.findIndex((e) => e.path === from)) : 0);
    } catch (e) {
      toast(String(e), "warn");
    }
  }

  async function add(path: string, name?: string, target?: string) {
    if (busy || added.has(path)) return;
    setBusy(true);
    try {
      const games = await api.addCustomGame(path, name, target);
      useStore.setState({ games });
      setAdded((s) => new Set(s).add(path));
      const game = games.find((g) => g.source === "custom" && g.installDir && (target ?? path).startsWith(g.installDir));
      toast(`Added ${game?.name ?? name ?? "the game"}`, "good");
      rescan(true);
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  }

  const switchTab = (t: Tab) => {
    if (t === tab) return "edge" as const;
    setTab(t);
    setIndex(0);
  };

  useInput(
    (a) => {
      if (busy) return "silent";
      switch (a) {
        case "up":
          return i > 0 ? setIndex(i - 1) : "edge";
        case "down":
          return i < rows.length - 1 ? setIndex(i + 1) : "edge";
        case "lb":
          return switchTab("suggested");
        case "rb":
          return switchTab("browse");
        case "a":
          rows[i]?.pick();
          return;
        case "b":
          if (tab === "browse" && listing?.path) {
            void open(listing.parent, true);
            return;
          }
          return onClose();
        case "y":
          if (tab === "browse" && listing?.path) void open(null, true);
          return;
        default:
          return "silent";
      }
    },
    Layer.modal,
  );
  const focused = rows[i];
  const inFolder = tab === "browse" && !!listing?.path;
  const hints: Hint[] = [
    ["a", focused && (focused.kind === "dir" || focused.kind === "drive" || focused.kind === "place") ? "Open" : "Add"],
    ["lb", "Tabs"],
    ["b", inFolder ? "Up" : "Close"],
  ];
  if (inFolder) hints.push(["y", "Top"]);
  useHints(hints, Layer.modal);

  return (
    <motion.div className="keyflow" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <motion.div className="keyflow-card addgame" initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease }}>
        <h2 className="keyflow-title">Add a game</h2>
        <div className="addgame-tabs">
          <Glyph b="lb" />
          <button className={`addgame-tab ${tab === "suggested" ? "is-active" : ""}`} onClick={() => switchTab("suggested")}>
            Suggested
          </button>
          <button className={`addgame-tab ${tab === "browse" ? "is-active" : ""}`} onClick={() => switchTab("browse")}>
            Browse files
          </button>
          <Glyph b="rb" />
        </div>
        <div className="addgame-where">
          {tab === "suggested"
            ? "Games in your Start menu and on your desktop that aren't in Mantel yet"
            : listing?.path ?? "Pick a place to start. Folders and launchable files only"}
        </div>
        <div className="addgame-list" ref={list}>
          {tab === "suggested" && suggestions === null && (
            <div className="addgame-empty">
              <span className="spinner" /> Looking for games…
            </div>
          )}
          {rows.length === 0 && (suggestions !== null || tab === "browse") && (
            <div className="addgame-empty">{tab === "suggested" ? "Nothing new found. Try Browse files." : "No folders or launchable files here."}</div>
          )}
          {rows.map((r, n) => (
            <button
              key={r.key}
              className={`addgame-row ${n === i ? "is-focused" : ""} ${added.has(r.key) ? "is-added" : ""}`}
              onClick={() => {
                setIndex(n);
                r.pick();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                {KIND_ICON[r.kind]}
              </svg>
              <span className="addgame-text">
                <span className="addgame-name">{r.name}</span>
                {r.sub && <span className="addgame-sub">{r.sub}</span>}
              </span>
              {added.has(r.key) && <span className="addgame-badge">Added</span>}
            </button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
