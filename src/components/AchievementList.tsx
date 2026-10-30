import { motion } from "motion/react";
import { useRef, useState } from "react";
import { useScrollFocus } from "../hooks";
import { Layer, useInput } from "../input";
import type { Achievement, Game } from "../types";
import { useHints } from "./Hints";

const PAGE = 6;

export const TROPHY = <path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4" />;

function Badge({ a }: { a: Achievement }) {
  if (a.icon && !a.secret) return <img className="ach-icon" src={a.icon} alt="" loading="lazy" draggable={false} />;
  return (
    <span className="ach-icon ach-icon-blank">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {a.secret ? <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></> : TROPHY}
      </svg>
    </span>
  );
}

/**
 * Every achievement of a game with the player's progress, over the game page. The page loads
 * the list as it opens, so it's usually here before this is.
 */
export function AchievementList({ game, list, error, onClose }: { game: Game; list: Achievement[] | null; error: string | null; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useScrollFocus(box, index);

  const count = list?.length ?? 0;
  useInput(
    (a) => {
      switch (a) {
        case "up":
          return index > 0 ? setIndex(index - 1) : "edge";
        case "down":
          return index < count - 1 ? setIndex(index + 1) : "edge";
        case "lb":
        case "lt":
          return index > 0 ? setIndex(Math.max(0, index - PAGE)) : "edge";
        case "rb":
        case "rt":
          return index < count - 1 ? setIndex(Math.min(count - 1, index + PAGE)) : "edge";
        case "b":
        case "y":
          return onClose();
        default:
          return "silent";
      }
    },
    Layer.overlay,
  );
  useHints([["dpad", "Browse"], ["b", "Back"]], Layer.overlay);

  const unlocked = list?.filter((a) => a.unlocked) ?? [];
  const percent = count ? Math.round((100 * unlocked.length) / count) : (game.achievements?.percent ?? 0);
  const score = (items: Achievement[]) => items.reduce((sum, a) => sum + (a.gamerscore ?? 0), 0);
  const gamerscore = list?.some((a) => a.gamerscore) ? `${score(unlocked)} / ${score(list)} G` : null;

  return (
    <motion.div className="ach" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="ach-head">
        <div className="eyebrow">Achievements</div>
        <h2 className="ach-title">{game.name}</h2>
        <div className="ach-summary">
          {list ? <span>{unlocked.length} of {count} unlocked</span> : <span>&nbsp;</span>}
          <span>{percent}%</span>
          {gamerscore && <span>{gamerscore}</span>}
        </div>
        <div className="ach-meter">
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="ach-list" ref={box}>
        {error ? (
          <div className="ach-note">{error}</div>
        ) : !list ? (
          <div className="ach-note"><span className="spinner" />Loading achievements…</div>
        ) : !count ? (
          <div className="ach-note">This game has no achievements.</div>
        ) : (
          list.map((a, n) => (
            <div key={`${n}${a.name}`} className={`ach-row ${n === index ? "is-focused" : ""} ${a.unlocked ? "" : "is-locked"}`} onClick={() => setIndex(n)}>
              <Badge a={a} />
              <div className="ach-text">
                <div className="ach-name">{a.secret ? "Secret achievement" : a.name}</div>
                <div className="ach-desc">{a.secret ? "Unlock it to see what it is." : a.description}</div>
              </div>
              <div className="ach-meta">
                {a.gamerscore ? <span className="ach-score">{a.gamerscore} G</span> : null}
                {a.rarity != null && <span>{a.rarity < 10 ? a.rarity.toFixed(1) : Math.round(a.rarity)}% of players</span>}
                {a.unlockedAt ? (
                  <span>{new Date(a.unlockedAt * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}</span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}
