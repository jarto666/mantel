import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import logo from "../../src-tauri/icons/source.svg";
import { t } from "../i18n";
import { Layer, useInput } from "../input";
import { ease } from "../motion";
import { sound } from "../sound";
import { dismissUpdateOffer, gamesRunning, installUpdate, useStore, type Updating } from "../store";
import { size } from "../util";
import { useHints } from "./Hints";

/** A newer release, offered once as soon as setup, a game and its launch are out of the way. */
export function UpdateOffer() {
  const offer = useStore((s) => s.updateOffer);
  const blocked = useStore((s) => s.setupStep !== null || gamesRunning(s).length > 0 || s.launching !== null || s.updating !== null);
  return <AnimatePresence>{offer && !blocked && <Offer key={offer} version={offer} />}</AnimatePresence>;
}

function Offer({ version }: { version: string }) {
  const [index, setIndex] = useState(0);
  const actions = [
    { label: t("Update now"), run: () => void installUpdate() },
    { label: t("Later"), run: dismissUpdateOffer },
  ];
  const activate = (n: number) => {
    sound.select();
    actions[n].run();
  };

  // It asks for an answer: Home waits underneath until A or B.
  useInput(
    (a) => {
      if (a === "left" || a === "up") return index > 0 ? setIndex(index - 1) : "edge";
      if (a === "right" || a === "down") return index < actions.length - 1 ? setIndex(index + 1) : "edge";
      if (a === "a") {
        activate(index);
        return "silent";
      }
      if (a === "b") return dismissUpdateOffer();
      return "silent";
    },
    Layer.modal,
  );
  useHints([["a", "Select"], ["dpad", "Move"], ["b", "Later"]], Layer.modal);

  return (
    // Leaves by fading where it is: moving it up as well read as a jump just before it went.
    <motion.div className="update-offer" initial={{ opacity: 0, y: -24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.2 } }} transition={{ duration: 0.45, ease }}>
      <img src={logo} alt="" className="update-offer-logo" />
      <div className="update-offer-text">
        <div className="eyebrow">{t("New version")}</div>
        <b>{t("Mantel {version} is out", { version })}</b>
        <span>{t("Takes under a minute. Mantel restarts by itself.")}</span>
      </div>
      <div className="update-offer-actions">
        {actions.map((a, n) => (
          <button
            key={a.label}
            className={`setup-action ${n === index ? "is-focused" : ""}`}
            onClick={() => {
              setIndex(n);
              activate(n);
            }}
            onPointerMove={(e) => e.pointerType === "mouse" && n !== index && setIndex(n)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

/** The update itself, full screen: the download as it goes, then the installer takes over. */
export function UpdateScreen() {
  const updating = useStore((s) => s.updating);
  return <AnimatePresence>{updating && <Progress key="update" {...updating} />}</AnimatePresence>;
}

function Progress({ version, downloaded, total, restartIn }: Updating) {
  // Nothing to press while it runs: the download can't be paused, and the install closes Mantel.
  useInput(() => "silent", Layer.update);
  useHints([], Layer.update);
  const downloadedAll = restartIn !== null || (total !== null && downloaded >= total);
  const installing = restartIn === 0;
  const share = total ? Math.min(1, downloaded / total) : 0;

  return (
    <motion.div className="update-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
      <div className="setup-light" />
      <div className="update-center">
        <div className="eyebrow">{installing ? t("Installing") : t("Updating")}</div>
        <div className="update-version">
          <span className="setup-num">{version}</span>
        </div>
        <div className={`update-bar ${total ? "" : "is-unknown"}`}>
          <span style={total ? { transform: `scaleX(${downloadedAll ? 1 : share})` } : undefined} />
        </div>
        <p className={restartIn ? "is-countdown" : ""}>
          {installing
            ? t("Mantel restarts in a moment")
            : restartIn
              ? t("Restarting in {n}", { n: restartIn })
              : total && downloaded > 0
                ? t("{done} of {total}", { done: size(downloaded), total: size(total) })
                : t("Downloading…")}
        </p>
      </div>
    </motion.div>
  );
}
