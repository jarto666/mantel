import { useEffect, useMemo, useRef, useState } from "react";
import { useScrollFocus } from "../hooks";
import { Layer, useInput } from "../input";
import { launch, setFocus, useStore } from "../store";
import { matches } from "../util";
import { Cover } from "./Cover";
import { useHints } from "./Hints";
import { useKeyboard } from "./Keyboard";

export function Search() {
  const open = useStore((s) => s.overlay === "search");
  const games = useStore((s) => s.games);
  const running = useStore((s) => s.running);
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState<"keys" | "results">("keys");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const rail = useRef<HTMLDivElement>(null);

  const results = useMemo(
    () => (query.trim() ? games.filter((g) => !g.hidden && matches(g, query)).slice(0, 24) : []),
    [games, query],
  );
  const i = Math.min(index, Math.max(0, results.length - 1));
  useScrollFocus(rail, `${zone}${i}`, { axis: "x", align: "center" });

  useEffect(() => {
    if (open) {
      setQuery("");
      setZone("keys");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (zone === "results" && results[i]) setFocus(results[i]);
  }, [zone, i, results]);

  const close = () => useStore.setState({ overlay: null });
  const kb = useKeyboard({
    onType: (ch) => setQuery((q) => (q + ch).slice(0, 40)),
    onBackspace: () => setQuery((q) => q.slice(0, -1)),
    onDone: () => results.length && setZone("results"),
    onExitUp: () => {
      if (!results.length) return false;
      setZone("results");
      return true;
    },
  });

  useInput(
    (a) => {
      if (a === "b" || a === "view") return close();
      if (zone === "keys") {
        const r = kb.handle(a);
        return r === false ? "silent" : r;
      }
      const g = results[i];
      switch (a) {
        case "left":
          if (i === 0) return "edge";
          return setIndex(i - 1);
        case "right":
          if (i >= results.length - 1) return "edge";
          return setIndex(i + 1);
        case "down":
          return setZone("keys");
        case "up":
          return "edge";
        case "a":
          if (g) {
            close();
            launch(g);
          }
          return "silent";
        case "y":
          if (g) useStore.setState({ overlay: null, detailsId: g.id });
          return;
        default:
          return "silent";
      }
    },
    Layer.overlay,
    open,
  );
  useHints(
    zone === "keys"
      ? [["a", "Type"], ["x", "Delete"], ["y", "Space"], ["b", "Close"]]
      : [["a", "Play"], ["y", "Details"], ["b", "Close"]],
    Layer.overlay,
    open,
  );

  if (!open) return null;
  return (
    <div className="search">
      <div className="search-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search games"
          spellCheck={false}
        />
        <span className="search-count">{query ? `${results.length}` : ""}</span>
      </div>
      <div className={`search-results ${zone === "results" ? "is-active" : ""}`}>
        {results.length === 0 ? (
          <div className="search-empty">{query ? "No matches" : "Start typing a title — initials work too, like “rdr”"}</div>
        ) : (
          <div className="search-rail" ref={rail}>
            {results.map((g, n) => (
              <Cover
                key={g.id}
                game={g}
                focused={zone === "results" && n === i}
                running={running?.id === g.id}
                showName={zone === "results" && n === i}
                onClick={() => {
                  close();
                  launch(g);
                }}
              />
            ))}
          </div>
        )}
      </div>
      {kb.view(zone === "keys")}
    </div>
  );
}
