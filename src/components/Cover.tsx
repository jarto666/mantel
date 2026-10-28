import { memo } from "react";
import type { Game } from "../types";
import { placeholderHue } from "../util";
import { Img } from "./Img";

function Placeholder({ game }: { game: Game }) {
  const hue = placeholderHue(game.name);
  return (
    <div className="cover-placeholder" data-initial={game.name.trim()[0]?.toUpperCase()} style={{ "--h1": hue, "--h2": (hue + 42) % 360 } as React.CSSProperties}>
      <span>{game.name}</span>
    </div>
  );
}

/**
 * Portrait key art. Focus visuals (lift, ring, tilt, glare) live in CSS so they cost
 * nothing per frame; positioning is up to the parent.
 */
export const Cover = memo(function Cover({
  game,
  focused,
  running,
  lazy,
  onClick,
  showName,
  className = "",
}: {
  game: Game;
  focused: boolean;
  running?: boolean;
  lazy?: boolean;
  onClick?: () => void;
  showName?: boolean;
  className?: string;
}) {
  return (
    <div className={`cover ${focused ? "is-focused" : ""} ${game.installed ? "" : "is-uninstalled"} ${className}`} onClick={onClick} data-id={game.id}>
      <div className="cover-frame">
        <Img srcs={game.art.cover} className="cover-img" lazy={lazy} fallback={<Placeholder game={game} />} />
        <div className="cover-gloss" />
        <div className="cover-shine" />
        {running && <span className="cover-badge">Playing</span>}
        {!game.installed && (
          <span className="cover-install" aria-label="Not installed">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          </span>
        )}
        {game.favorite && (
          <span className="cover-fav" aria-label="Favorite">
            <svg viewBox="0 0 24 24"><path d="M12 3.5l2.5 5.4 5.9.6-4.4 4 1.3 5.8L12 16.4l-5.3 2.9L8 13.5l-4.4-4 5.9-.6z" /></svg>
          </span>
        )}
      </div>
      {showName && <div className="cover-name">{game.name}</div>}
    </div>
  );
});
