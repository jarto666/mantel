// playmantel.com: screen tabs, scroll spy, reveals, and a page you can drive with a gamepad.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;

  // ---------- Screens: LB / RB tabs over the screenshot, accent follows the art ----------

  const tabs = $$(".tab[data-screen]");
  const tabLine = $(".tab-line");
  const shine = $(".screen-shine");
  let current = 0;

  function placeLine(line, el) {
    if (!line || !el) return;
    line.style.width = `${el.offsetWidth}px`;
    line.style.transform = `translateX(${el.offsetLeft}px)`;
  }

  function setScreen(i, focus = false) {
    current = (i + tabs.length) % tabs.length;
    const tab = tabs[current];
    const name = tab.dataset.screen;
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
    });
    $$(".screen-frame img").forEach((img) => img.classList.toggle("is-active", img.dataset.screen === name));
    $$(".screen figcaption [data-screen]").forEach((s) => (s.hidden = s.dataset.screen !== name));
    $$(".stage-art").forEach((a) => a.classList.toggle("is-active", a.dataset.art === name));
    $("#screen").setAttribute("aria-labelledby", tab.id);
    root.style.setProperty("--accent", tab.dataset.accent);
    placeLine(tabLine, tab);
    shine.classList.remove("go");
    void shine.offsetWidth;
    shine.classList.add("go");
    if (focus) tab.focus();
  }

  tabs.forEach((t, i) => t.addEventListener("click", () => setScreen(i)));
  $$(".screens-tabs [data-step]").forEach((b) => b.addEventListener("click", () => setScreen(current + Number(b.dataset.step))));
  $(".screens-tabs").addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setScreen(current + (e.key === "ArrowRight" ? 1 : -1), true);
    }
  });

  // ---------- Top bar: glass once scrolled, tab line under the section in view ----------

  const topbar = $(".topbar");
  const navLinks = $$(".nav a");
  const navLine = $(".nav-line");
  const onScroll = () => topbar.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const sections = navLinks.map((a) => $(a.getAttribute("href"))).filter(Boolean);
  let activeLink = null;
  function spy() {
    const y = window.scrollY + window.innerHeight * 0.35;
    let found = null;
    for (const s of sections) if (s.offsetTop <= y) found = s;
    const link = found ? navLinks.find((a) => a.getAttribute("href") === `#${found.id}`) : null;
    if (link === activeLink) return;
    activeLink = link;
    navLinks.forEach((a) => a.classList.toggle("is-active", a === link));
    navLine.style.opacity = link ? 1 : 0;
    if (link) placeLine(navLine, link);
  }
  window.addEventListener("scroll", spy, { passive: true });

  window.addEventListener("resize", () => {
    placeLine(tabLine, tabs[current]);
    if (activeLink) placeLine(navLine, activeLink);
  });
  document.fonts?.ready.then(() => {
    placeLine(tabLine, tabs[current]);
    spy();
  });
  placeLine(tabLine, tabs[current]);
  spy();

  // ---------- Reveal on scroll ----------

  const reveals = $$(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }),
      { rootMargin: "0px 0px -8% 0px" },
    );
    reveals.forEach((el, i) => {
      el.style.transitionDelay = `${(i % 3) * 70}ms`;
      io.observe(el);
    });
  } else {
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  // ---------- Controls: keys and buttons light up their row ----------

  const lit = new Map();
  function light(li) {
    if (!li) return;
    li.classList.add("is-lit");
    clearTimeout(lit.get(li));
    lit.set(li, setTimeout(() => li.classList.remove("is-lit"), 450));
  }
  const keyRows = $$("[data-key]");
  const padRows = $$("[data-pad]");

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    light(keyRows.find((li) => li.dataset.key.split(" ").includes(key)));
    if (key === "q" || key === "e") setScreen(current + (key === "e" ? 1 : -1));
  });

  // ---------- Gamepad: d-pad / stick moves focus, A selects, B goes to top, LB / RB switch screens ----------

  const toast = $(".toast");
  let toastTimer;
  function say(text) {
    toast.textContent = text;
    toast.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-on"), 4200);
  }

  const focusables = () =>
    $$('a[href], button:not([tabindex="-1"]), summary, .tab[aria-selected="true"]').filter(
      (el) => el.offsetParent !== null && !el.closest(".hintbar"),
    );
  function moveFocus(dir) {
    root.classList.add("pad");
    const list = [...new Set(focusables())];
    const at = list.indexOf(document.activeElement);
    let next;
    if (at === -1) {
      // Start from whatever is on screen rather than the top of the page.
      next = list.find((el) => el.getBoundingClientRect().top >= 0) || list[0];
    } else {
      next = list[Math.min(list.length - 1, Math.max(0, at + dir))];
    }
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  const prev = [];
  const held = {};
  let polling = false;

  function poll(t) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    if (!pads.length) {
      polling = false;
      return;
    }
    const gp = pads[0];
    const pressed = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    const [ax = 0, ay = 0] = gp.axes;
    const dirs = {
      up: pressed[12] || ay < -0.55,
      down: pressed[13] || ay > 0.55,
      left: pressed[14] || ax < -0.55,
      right: pressed[15] || ax > 0.55,
    };

    pressed.forEach((on, i) => {
      if (!on || prev[i]) return;
      light(padRows.find((li) => li.dataset.pad.split(" ").includes(String(i))));
      if (i === 0) {
        root.classList.add("pad");
        document.activeElement?.click?.();
      } else if (i === 1) {
        const open = document.activeElement?.closest?.("details[open]");
        if (open) open.open = false;
        else {
          window.scrollTo({ top: 0, behavior: "smooth" });
          $(".brand").focus({ preventScroll: true });
        }
      } else if (i === 4 || i === 5) {
        setScreen(current + (i === 5 ? 1 : -1));
      } else if (i === 9) {
        $(".topbar .btn-primary").focus();
      }
    });
    pressed.forEach((on, i) => (prev[i] = on));

    // Directions repeat while held: a beat, then a steady tick, like the app.
    for (const [d, on] of Object.entries(dirs)) {
      if (!on) {
        held[d] = 0;
        continue;
      }
      if (!held[d]) {
        held[d] = t + 380;
        moveFocus(d === "up" || d === "left" ? -1 : 1);
      } else if (t >= held[d]) {
        held[d] = t + 130;
        moveFocus(d === "up" || d === "left" ? -1 : 1);
      }
    }
    requestAnimationFrame(poll);
  }

  function startPad() {
    root.classList.add("pad");
    if (!polling) {
      polling = true;
      requestAnimationFrame(poll);
    }
  }
  window.addEventListener("gamepadconnected", () => {
    say("Controller connected. D-pad to move, A to select, LB / RB to switch screens.");
    startPad();
  });
  window.addEventListener("gamepaddisconnected", () => {
    if (![...(navigator.getGamepads?.() || [])].some(Boolean)) root.classList.remove("pad");
  });
  document.addEventListener("pointerdown", () => root.classList.remove("pad"));
})();
