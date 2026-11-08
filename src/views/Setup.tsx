import { AnimatePresence, motion, type Variants } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import logo from "../../src-tauri/icons/source.svg";
import { api } from "../api";
import { AccountFlow, steamCopy, xboxCopy } from "../components/AccountFlow";
import { Glyph, SourceIcon } from "../components/Glyph";
import { useHints, type Hint } from "../components/Hints";
import { homeAppCopy, useHomeApp } from "../components/HomeApp";
import { Img } from "../components/Img";
import { errorText, LANGUAGES, t, tIn, windowsLanguage } from "../i18n";
import { Layer, rumble, useInput } from "../input";
import { ease } from "../motion";
import { sound } from "../sound";
import { closeSetup, saveSettings, toast, useStore } from "../store";
import type { Game, Source } from "../types";

/** First-run setup, like a console's: each step is also in Settings, so all of it can be skipped. */
const STEPS = ["language", "games", "start", "done"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], string> = { language: "Language", games: "Games", start: "Start", done: "Play" };

/** English first, the rest by their own names. */
const LANGUAGE_ORDER = ["en", "de", "es", "fr", "ru"];
const nativeName = (id: string) => LANGUAGES.find((l) => l.id === id)?.label ?? id;

/** Every store Mantel reads, whether or not this PC has games from it. */
const STORES: { id: Source; name: string; tag?: string; account?: "steam" | "xbox" }[] = [
  { id: "steam", name: "Steam", account: "steam" },
  // Game Pass is half of why people use Xbox on a PC, and it installs right in Mantel.
  { id: "xbox", name: "Xbox", tag: "Game Pass", account: "xbox" },
  { id: "epic", name: "Epic Games" },
  { id: "gog", name: "GOG" },
  { id: "ubisoft", name: "Ubisoft Connect" },
];

interface Choice {
  id: string;
  run: () => void;
  /** Makes its own sound, so no click first. */
  quiet?: boolean;
}

/** Sparks rising behind the last step's title: spread, sizes and timings that don't repeat in step. */
const EMBERS = Array.from({ length: 18 }, (_, k) => ({
  x: `${(k * 37 + 11) % 100}%`,
  d: `${-((k * 1.7) % 11).toFixed(1)}s`,
  t: `${(9 + ((k * 1.3) % 6)).toFixed(1)}s`,
  s: `${(0.22 + (k % 4) * 0.09).toFixed(2)}rem`,
}));

/* The motion of Home's hero: the old step clears in a blink, the new one comes in piece by piece,
   so there's never an empty screen between steps. Steps share one layout and stay put. */
const LEAVE = 0.16;
const stepMotion: Variants = {
  enter: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } },
  exit: { opacity: 0, transition: { duration: LEAVE } },
};
const pieceMotion = (back: boolean): Variants => ({
  enter: { opacity: 0, x: back ? -28 : 28, filter: "blur(6px)" },
  show: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.55, ease } },
  exit: { opacity: 0, transition: { duration: 0.2 } },
});
const groupMotion: Variants = {
  enter: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.1 } },
};

/** A new language remounts the interface; setup then shouldn't fade in a second time. */
let shown = false;
/** The step to come in after that remount, as it would have without one. */
let enterAfterRemount = false;

export function Setup() {
  const step = useStore((s) => s.setupStep);
  useEffect(() => {
    if (step === null) shown = false;
  }, [step]);
  return <AnimatePresence>{step !== null && <SetupScreen key="setup" step={step} />}</AnimatePresence>;
}

const go = (step: number) => useStore.setState({ setupStep: step });
const hasCover = (g: Game) => g.art.cover.length > 0;
const byRecent = (a: Game, b: Game) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0);

/** The player's own covers, far back and dim: the first thing setup shows is their games. */
const Wall = memo(function Wall() {
  const games = useStore((s) => s.games);
  const covers = useMemo(() => games.filter((g) => !g.hidden && hasCover(g)).sort((a, b) => Number(b.installed) - Number(a.installed) || byRecent(a, b)), [games]);
  // Too few to fill a wall would look like a gap rather than a shelf: the site's poster title,
  // barely there, stands in.
  if (covers.length < 8) return <div className="setup-poster">Mantel</div>;
  return (
    <div className="setup-wall">
      <div className="setup-wall-grid">
        {Array.from({ length: 40 }, (_, k) => covers[k % covers.length]).map((g, k) => (
          <Img key={k} srcs={g.art.cover} className="setup-wall-img" />
        ))}
      </div>
    </div>
  );
});

type Focus = { className: string; onClick: () => void; onPointerMove: (e: React.PointerEvent) => void };

function SetupScreen({ step }: { step: number }) {
  const settings = useStore((s) => s.settings);
  const games = useStore((s) => s.games);
  const scanning = useStore((s) => s.scanning);
  const accounts = useStore((s) => s.accounts);
  const home = useHomeApp();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [flow, setFlow] = useState<"steam" | "xbox" | null>(null);
  /** The step is clearing before a new language remounts everything. */
  const [leaving, setLeaving] = useState(false);
  /** A was pressed on the last step: the launch plays, then Home. */
  const [launching, setLaunching] = useState(false);
  const id = STEPS[step];
  const windows = windowsLanguage();
  // What the interface is in now: the setting, or Windows' language when it follows Windows.
  const current = settings?.language || windows || "en";
  const [index, setIndex] = useState(id === "language" ? Math.max(0, LANGUAGE_ORDER.indexOf(current)) : 0);
  const [firstShow] = useState(!shown);
  // Read during render, reset after: StrictMode renders twice and both must see it.
  const enterNow = useRef(firstShow || enterAfterRemount).current;
  // Which way the steps slide, settled once per step: later renders must not flip it mid-slide.
  const dir = useRef({ step, back: false });
  if (dir.current.step !== step) dir.current = { step, back: step < dir.current.step };
  const piece = pieceMotion(dir.current.back);

  useEffect(() => {
    shown = true;
    enterAfterRemount = false;
    api.accountsStatus().then((accounts) => useStore.setState({ accounts }), () => {});
    api.getAutostart().then(setAutostart, () => setAutostart(false));
  }, []);
  useEffect(() => {
    setIndex(STEPS[step] === "language" ? Math.max(0, LANGUAGE_ORDER.indexOf(current)) : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const next = () => go(step + 1);
  const steam = accounts?.steam;
  const xboxTag = accounts?.xboxGamertag ?? null;
  const mode = home.mode;

  // ---- What can be chosen on this step, in reading order.
  let choices: Choice[] = [];
  if (id === "language") {
    choices = LANGUAGE_ORDER.map((lang) => ({
      id: lang,
      run: () => {
        // Windows' own language stays "follow Windows", as Settings' System does.
        const value = lang === windows ? "" : lang;
        if (!settings || settings.language === value) return next();
        // A new language remounts the whole interface: clear this step first, then the next one
        // comes in, already in that language.
        setLeaving(true);
        setTimeout(() => {
          enterAfterRemount = true;
          go(step + 1);
          void saveSettings({ language: value });
        }, LEAVE * 1000);
      },
    }));
  } else if (id === "games") {
    choices = [
      { id: "steam", run: () => setFlow("steam") },
      { id: "xbox", run: () => setFlow("xbox") },
      { id: "next", run: next },
    ];
  } else if (id === "start" && mode?.supported) {
    choices = mode.home
      ? [{ id: "next", run: next }]
      : [
          { id: "make", run: () => void home.make() },
          ...(home.error && !mode.developerMode ? [{ id: "developer", run: home.openDeveloperSettings }] : []),
          { id: "skip", run: next },
        ];
  } else if (id === "start") {
    choices = mode
      ? [
          {
            id: "autostart",
            run: () =>
              api.setAutostart(true).then(
                () => {
                  setAutostart(true);
                  next();
                },
                (e) => toast(errorText(e), "warn"),
              ),
          },
          { id: "skip", run: next },
        ]
      : [];
  } else {
    choices = [
      {
        id: "play",
        quiet: true,
        // The same send-off as starting a game: sound, rumble, a flash, then Home.
        run: () => {
          setLaunching(true);
          sound.launch();
          rumble(0.5, 0.9, 260);
          setTimeout(closeSetup, 750);
        },
      },
    ];
  }

  const i = Math.min(index, Math.max(0, choices.length - 1));
  const busy = home.busy || leaving || launching;
  const activate = (c: Choice | undefined) => {
    if (busy || !c) return;
    if (!c.quiet) sound.select();
    c.run();
  };
  /** What makes an element the choice with this id, for pad, keys, mouse and touch alike. */
  const focus = (choiceId: string): Focus => {
    const n = choices.findIndex((c) => c.id === choiceId);
    return {
      className: n === i ? "is-focused" : "",
      onClick: () => {
        setIndex(n);
        activate(choices[n]);
      },
      // Focus follows a moving mouse, as on a console with one plugged in.
      onPointerMove: (e) => e.pointerType === "mouse" && n !== i && !busy && setIndex(n),
    };
  };
  /** A text action with a line under it, like Mantel's tabs. The hint bar names the button once;
   *  an A here too would sit right above it. */
  const action = (choiceId: string, label: string, working = false) => {
    const f = focus(choiceId);
    return (
      <motion.button key={choiceId} variants={piece} className={`setup-action ${f.className}`} onClick={f.onClick} onPointerMove={f.onPointerMove}>
        {label}
        {working && <span className="spinner" />}
      </motion.button>
    );
  };

  // ---- The step itself.
  let content: ReactNode;
  if (id === "language") {
    const looking = LANGUAGE_ORDER[i] ?? current;
    content = (
      <>
        <motion.div className="setup-hello" variants={piece}>
          {/* In the language under focus, so the player reads it before choosing. */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={looking} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
              {tIn(looking, "Hello. Welcome to")}
            </motion.span>
          </AnimatePresence>
        </motion.div>
        <motion.h1 className="setup-mark" variants={piece}>
          Mantel
        </motion.h1>
        <motion.ul className="setup-langs" variants={piece}>
          {LANGUAGE_ORDER.map((lang) => {
            const f = focus(lang);
            return (
              <li key={lang}>
                <button className={`setup-lang ${f.className} ${lang === current ? "is-chosen" : ""}`} onClick={f.onClick} onPointerMove={f.onPointerMove}>
                  {nativeName(lang)}
                </button>
                {lang === windows && <small>Windows</small>}
              </li>
            );
          })}
        </motion.ul>
        <motion.p className="setup-later" variants={piece}>
          {tIn(looking, "Pick a language. Settings can change it any time.")}
        </motion.p>
      </>
    );
  } else if (id === "games") {
    const installed = games.filter((g) => g.installed && !g.hidden);
    const n = installed.length;
    content = (
      <>
        <motion.div className="setup-head" variants={piece}>
          {n > 0 ? (
            <div className="setup-count">
              <span className="setup-num">{n}</span>
              <span className="setup-what">{n === 1 ? t("game found on this PC") : t("games found on this PC", { n })}</span>
            </div>
          ) : (
            <h1 className="setup-title">{scanning ? t("Looking for your games…") : t("No games yet")}</h1>
          )}
        </motion.div>
        <motion.p className="setup-intro" variants={piece}>
          {n > 0 || scanning
            ? t("Mantel finds them in every store by itself. Connect Steam or Xbox to sync the games you own but haven't installed, and playtime from all your devices.")
            : t("Games you install with Steam, Xbox, Epic, GOG or Ubisoft Connect show up here by themselves. Connecting Steam or Xbox syncs the games you own right away.")}
        </motion.p>
        <motion.ul className="setup-stores" variants={groupMotion}>
          {/* Games added by hand count in the total above, so they get a line when there are any. */}
          {[...STORES, ...(installed.some((g) => g.source === "custom") ? [{ id: "custom" as const, name: t("Added by you") }] : [])].map((store) => {
            const own = installed.filter((g) => g.source === store.id);
            const covers = own.filter(hasCover).sort(byRecent).slice(0, 3);
            const signedIn = store.account === "steam" ? !!steam?.connected : store.account === "xbox" ? !!xboxTag : false;
            const f = store.account ? focus(store.account) : null;
            const note =
              store.account === "steam"
                ? signedIn
                  ? steam?.user
                    ? t("Signed in as {user}", { user: steam.user })
                    : t("Connected")
                  : t("Syncs games you own and playtime")
                : store.account === "xbox"
                  ? signedIn
                    ? t("Browse and install Game Pass · Signed in as {gamertag}", { gamertag: xboxTag ?? "" })
                    : t("Browse and install Game Pass · Syncs play history and minutes")
                  : store.id === "custom"
                    ? t("Games from outside the stores, added in Settings")
                    : // Installed games already show; what's missing is the account, as for Steam and Xbox.
                      t("Account sync is on the way");
            const state = store.account ? (
              signedIn ? (
                <span className="setup-state is-good">{t("Connected")}</span>
              ) : (
                <span className="setup-state is-do">{t("Connect")}</span>
              )
            ) : (
              <span className={`setup-state ${own.length ? "is-good" : ""}`}>{own.length ? t("On this PC") : t("Not found")}</span>
            );
            const body = (
              <>
                <SourceIcon source={store.id} />
                <b>
                  {store.name}
                  {store.tag && <span className="setup-tag">{store.tag}</span>}
                </b>
                <span className="setup-store-count">{own.length ? (own.length === 1 ? t("1 game") : t("{n} games", { n: own.length })) : t("No games")}</span>
                <span className="setup-minis">
                  {covers.map((g) => (
                    <Img key={g.id} srcs={g.art.cover} className="setup-mini" />
                  ))}
                </span>
                <span className="setup-note">{note}</span>
                {state}
              </>
            );
            return (
              <motion.li key={store.id} variants={piece}>
                {f ? (
                  <button className={`setup-store is-account ${f.className}`} onClick={f.onClick} onPointerMove={f.onPointerMove}>
                    {body}
                  </button>
                ) : (
                  <div className={`setup-store ${own.length ? "" : "is-empty"}`}>{body}</div>
                )}
              </motion.li>
            );
          })}
        </motion.ul>
        <motion.div className="setup-actions" variants={groupMotion}>
          {action("next", t("Continue"))}
        </motion.div>
      </>
    );
  } else if (id === "start" && mode?.supported) {
    const copy = homeAppCopy(mode);
    content = (
      <>
        <motion.div className="eyebrow" variants={piece}>
          {t("Xbox mode")}
        </motion.div>
        <motion.h1 className="setup-title" variants={piece}>
          {t("Start in Mantel")}
        </motion.h1>
        <motion.p className="setup-intro" variants={piece}>
          {copy.intro}
        </motion.p>
        {/* Once it's done, the how-to fades away; nothing above it moves. */}
        <AnimatePresence>
          {copy.steps.length > 0 && (
            <motion.ol key="howto" className="setup-howto" variants={piece} exit="exit">
              {copy.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </motion.ol>
          )}
        </AnimatePresence>
        <motion.div className={`setup-status ${mode.home ? "is-ok" : ""}`} variants={piece}>
          <motion.span key={copy.status} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.35 } }}>
            {copy.status}
          </motion.span>
        </motion.div>
        {!mode.home && (
          <motion.p className="setup-aside" variants={piece}>
            {copy.note}
          </motion.p>
        )}
        <AnimatePresence>
          {home.error && (
            <motion.div className="keyflow-error setup-error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {home.error}
            </motion.div>
          )}
        </AnimatePresence>
        {/* A new set of actions, such as after the home app is done, comes in like a step's. */}
        <motion.div key={choices.map((c) => c.id).join()} className="setup-actions" variants={groupMotion} initial="enter" animate="show">
          {mode.home ? (
            action("next", t("Continue"))
          ) : (
            <>
              {action("make", home.busy ? copy.busy : copy.action, home.busy)}
              {choices.some((c) => c.id === "developer") && action("developer", t("Open Developer settings"))}
              {action("skip", t("Not now"))}
            </>
          )}
        </motion.div>
      </>
    );
  } else if (id === "start") {
    // Without Xbox mode there's no home app to be: starting with Windows comes closest.
    content = (
      <>
        <motion.div className="eyebrow" variants={piece}>
          {t("Startup")}
        </motion.div>
        <motion.h1 className="setup-title" variants={piece}>
          {t("Boot into Mantel")}
        </motion.h1>
        <motion.p className="setup-intro" variants={piece}>
          {t("Mantel can open as soon as you sign in to Windows, so the handheld starts like a console.")}
        </motion.p>
        {autostart && (
          <motion.div className="setup-status is-ok" variants={piece}>
            {t("Mantel starts with Windows")}
          </motion.div>
        )}
        <motion.div className="setup-actions" variants={groupMotion}>
          {mode && (
            <>
              {action("autostart", t("Start with Windows"))}
              {action("skip", autostart ? t("Continue") : t("Not now"))}
            </>
          )}
        </motion.div>
      </>
    );
  } else {
    // A game's title screen: the art of what they played last, the name, and "press start".
    const featured = games
      .filter((g) => !g.hidden && g.art.hero.length > 0)
      .sort((a, b) => Number(b.installed) - Number(a.installed) || byRecent(a, b))[0];
    const f = focus("play");
    const [before, after] = t("Press {button} to start").split("{button}");
    content = (
      <>
        {featured && (
          // Comes in from far off and lights up; on A it rushes forward with the launch.
          <motion.div
            className="setup-hero"
            initial={{ opacity: 0, scale: 1.18, filter: "brightness(0.35)" }}
            // No filter left once lit: an idle one would still be applied every frame of the drift.
            animate={launching ? { opacity: 1, scale: 1.32, filter: "brightness(1.6)" } : { opacity: 1, scale: 1, filter: "brightness(1)", transitionEnd: { filter: "none" } }}
            transition={launching ? { duration: 0.8, ease: [0.55, 0, 0.8, 0.2] } : { duration: 2.6, ease }}
          >
            <Img srcs={featured.art.hero} className="setup-hero-img" />
          </motion.div>
        )}
        <div className="setup-glow" />
        <div className="setup-embers" aria-hidden>
          {EMBERS.map((e, k) => (
            <i key={k} style={{ "--x": e.x, "--d": e.d, "--t": e.t, "--s": e.s } as CSSProperties} />
          ))}
        </div>
        <motion.div className="setup-final" animate={launching ? { opacity: 0, scale: 1.14 } : { opacity: 1, scale: 1 }} transition={{ duration: 0.6, ease }}>
          <motion.div className="eyebrow" variants={piece}>
            {t("All set")}
          </motion.div>
          {/* Letter by letter, like the title on playmantel.com; a glint runs over them after. */}
          <h1 className="setup-mark is-title" aria-label="Mantel">
            {"Mantel".split("").map((ch, k) => (
              <motion.span
                key={k}
                className="setup-letter"
                style={{ "--k": k } as CSSProperties}
                initial={{ opacity: 0, y: "0.3em", scale: 1.3, filter: "blur(14px)" }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                transition={{ delay: 0.35 + k * 0.07, duration: 0.8, ease }}
              >
                {ch}
              </motion.span>
            ))}
          </h1>
          <motion.button
            className={`setup-press ${f.className}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.15, duration: 0.6, ease }}
            onClick={f.onClick}
            onPointerMove={f.onPointerMove}
          >
            {/* The pulse on its own element: a CSS animation would override the fade-in above. */}
            <span className="setup-press-pulse">
              {before}
              <Glyph b="a" size={1.4} />
              {after}
            </span>
          </motion.button>
        </motion.div>
        {launching && <div className="setup-flash" />}
      </>
    );
  }

  useInput(
    (a) => {
      if (busy) return "silent";
      // One list per step, in reading order: both axes walk it, whatever its shape on screen.
      if (a === "up" || a === "left") return i > 0 ? setIndex(i - 1) : "edge";
      if (a === "down" || a === "right") return i < choices.length - 1 ? setIndex(i + 1) : "edge";
      if (a === "a") {
        activate(choices[i]);
        return "silent";
      }
      if (a === "b") return step > 0 ? go(step - 1) : "edge";
      if (a === "y" && id !== "done") return closeSetup();
      // Nothing under setup takes input: no tabs, menu or search until it's done.
      return "silent";
    },
    Layer.setup,
    !flow,
  );
  // The last step says "press A" itself, so the bar keeps only the way back.
  const hints: Hint[] = busy ? [] : id === "done" ? [["b", "Back"]] : [["a", "Select"], ["dpad", "Move"], ...(step > 0 ? ([["b", "Back"]] as Hint[]) : []), ["y", "Skip setup"]];
  useHints(hints, Layer.setup, !flow);

  return (
    <motion.div className="setup" initial={firstShow ? { opacity: 0 } : false} animate={{ opacity: 1, transition: { duration: 0.4 } }} exit={{ opacity: 0, scale: 1.04, transition: { duration: 0.5, ease } }}>
      <div className="setup-bg" aria-hidden>
        <Wall />
        <div className="setup-light" />
        <div className="setup-shade" />
      </div>
      <header className="setup-top">
        <span className="setup-brand">
          <img src={logo} alt="" />
          Mantel
        </span>
        <ol className="setup-steps">
          {STEPS.map((s, n) => (
            <li key={s} className={n < step ? "is-done" : n === step ? "is-current" : ""}>
              {t(STEP_LABEL[s])}
            </li>
          ))}
        </ol>
      </header>
      <AnimatePresence initial={enterNow}>
        <motion.main key={id} className={`setup-step is-${id}`} variants={stepMotion} initial="enter" animate={leaving ? "exit" : "show"} exit="exit">
          {content}
        </motion.main>
      </AnimatePresence>
      {flow && <AccountFlow copy={(flow === "steam" ? steamCopy : xboxCopy)(accounts)} onChange={(a) => useStore.setState({ accounts: a })} onClose={() => setFlow(null)} />}
    </motion.div>
  );
}
