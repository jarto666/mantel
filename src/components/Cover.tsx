import { memo } from "react";
import { onGamePass, useStore } from "../store";
import { t } from "../i18n";
import type { Game } from "../types";
import { placeholderHue } from "../util";
import { DOWNLOAD, SourceIcon } from "./Glyph";
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
  installMark = true,
  storeMark = true,
  className = "",
}: {
  game: Game;
  focused: boolean;
  running?: boolean;
  lazy?: boolean;
  /** Keep it stable: covers come by the hundred, and a new function renders each one again. */
  onClick?: (game: Game) => void;
  showName?: boolean;
  /** The download mark on games that aren't installed; off where everything is to install. */
  installMark?: boolean;
  /** Which store it's from and whether it's on Game Pass; off where that goes without saying. */
  storeMark?: boolean;
  className?: string;
}) {
  const install = useStore((s) => s.installs[game.id]);
  const onPass = useStore(() => storeMark && onGamePass(game));
  // "New" and "Leaving soon" only ever mean Game Pass, and "Playing" is short-lived: any of them
  // takes the corner the Game Pass mark would sit in.
  const badge = running || game.tags?.includes("leaving") || game.tags?.includes("new");
  return (
    <div className={`cover ${focused ? "is-focused" : ""} ${game.installed ? "" : "is-uninstalled"} ${className}`} onClick={onClick && (() => onClick(game))} data-id={game.id}>
      <div className="cover-frame">
        <Img srcs={game.art.cover} className="cover-img" lazy={lazy} fallback={<Placeholder game={game} />} />
        <div className="cover-gloss" />
        <div className="cover-shine" />
        {install ? (
          <span className="cover-progress">
            <span style={{ width: `${install.percent}%` }} />
          </span>
        ) : running ? (
          <span className="cover-badge">{t("Playing")}</span>
        ) : game.tags?.includes("leaving") ? (
          <span className="cover-badge is-leaving">{t("Leaving soon")}</span>
        ) : game.tags?.includes("new") ? (
          <span className="cover-badge is-new">{t("New")}</span>
        ) : game.discount ? (
          <span className="cover-badge is-deal">-{game.discount}%</span>
        ) : null}
        {!game.installed && installMark && !install && (
          <span className="cover-install" aria-label={t("Not installed")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{DOWNLOAD}</svg>
          </span>
        )}
        {storeMark && !install && (
          <span className="cover-marks">
            {onPass && !badge && <span className="cover-pass">Game Pass</span>}
            {game.source !== "custom" && <span className="cover-store"><SourceIcon source={game.source} /></span>}
          </span>
        )}
        {game.favorite && (
          <span className="cover-fav" aria-label={t("Favorited")}>
            <svg viewBox="0 0 24 24"><path d="M12 3.5l2.5 5.4 5.9.6-4.4 4 1.3 5.8L12 16.4l-5.3 2.9L8 13.5l-4.4-4 5.9-.6z" /></svg>
          </span>
        )}
      </div>
      {showName && <div className="cover-name">{game.name}</div>}
    </div>
  );
});
