// playmantel.com: the page behaves like the app. Screens and covers take focus, a
// controller drives everything, and a few trophies drop for the curious.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = document.documentElement;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

  function placeLine(line, el) {
    if (!line || !el) return;
    line.style.width = `${el.offsetWidth}px`;
    line.style.transform = `translateX(${el.offsetLeft}px)`;
  }
  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------- Hero screens: LT / RT over the screenshot, accent follows the art ----------

  const tabs = $$(".tab[data-screen]");
  const tabLine = $(".tab-line");
  let screen = 0;

  function setScreen(i, focus = false) {
    screen = (i + tabs.length) % tabs.length;
    const tab = tabs[screen];
    const name = tab.dataset.screen;
    tabs.forEach((t) => {
      t.setAttribute("aria-selected", t === tab);
      t.tabIndex = t === tab ? 0 : -1;
    });
    $$(".screen-frame img").forEach((img) => img.classList.toggle("is-active", img.dataset.screen === name));
    $$(".screen-caption [data-screen]").forEach((s) => (s.hidden = s.dataset.screen !== name));
    $$(".stage-art").forEach((a) => a.classList.toggle("is-active", a.dataset.art === name));
    $("#screen").setAttribute("aria-labelledby", tab.id);
    root.style.setProperty("--accent", tab.dataset.accent);
    placeLine(tabLine, tab);
    replay($(".screen-frame .shine"), "go");
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => t.addEventListener("click", () => setScreen(i)));
  $$(".screens-tabs [data-step]").forEach((b) => b.addEventListener("click", () => setScreen(screen + Number(b.dataset.step))));
  $(".screens-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    setScreen(screen + (e.key === "ArrowRight" ? 1 : -1), true);
  });

  // ---------- Features: a shelf of covers; focus one and the stage above shows it ----------

  const shelfSection = $(".shelf-section");
  const covers = $$(".cover");
  const features = $$(".feature");
  const seen = new Set([0]);
  let feature = 0;

  function setFeature(i, { focus = false, scroll = false } = {}) {
    i = Math.max(0, Math.min(covers.length - 1, i));
    if (i !== feature) {
      feature = i;
      covers.forEach((c, k) => {
        c.classList.toggle("is-active", k === i);
        c.setAttribute("aria-selected", k === i);
        c.tabIndex = k === i ? 0 : -1;
      });
      features.forEach((f, k) => (f.hidden = k !== i));
      shelfSection.style.setProperty("--tint", covers[i].style.getPropertyValue("--tint"));
      seen.add(i);
      if (seen.size === covers.length) trophy("shopper", "Window shopper", "silver");
    }
    if (scroll) covers[i].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    if (focus) covers[i].focus({ preventScroll: true });
  }
  covers.forEach((c, i) => {
    c.addEventListener("click", () => setFeature(i));
    c.addEventListener("focus", () => setFeature(i, { scroll: true }));
    if (finePointer) c.addEventListener("mouseenter", () => setFeature(i));
  });
  $(".shelf").addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -99, End: 99 }[e.key];
    if (!step) return;
    e.preventDefault();
    setFeature(feature + step, { focus: true, scroll: true });
  });

  // ---------- Stores: a game menu, the card on the right follows the selection ----------

  const storeTabs = $$(".menu [role=tab]");
  const bigIcon = $(".store-card .big use");
  let store = 0;

  function setStore(i, focus = false) {
    store = (i + storeTabs.length) % storeTabs.length;
    storeTabs.forEach((t, k) => {
      t.setAttribute("aria-selected", k === store);
      t.tabIndex = k === store ? 0 : -1;
      $(`#${t.getAttribute("aria-controls")}`).hidden = k !== store;
    });
    bigIcon.setAttribute("href", `#${storeTabs[store].dataset.icon}`);
    if (focus) storeTabs[store].focus();
  }
  storeTabs.forEach((t, i) => {
    t.addEventListener("click", () => setStore(i));
    t.addEventListener("focus", () => store !== i && setStore(i));
    if (finePointer) t.addEventListener("mouseenter", () => setStore(i));
  });
  $(".menu").addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    setStore(store + step, true);
  });

  // ---------- Top bar: glass once scrolled, tab line under the section in view, clock ----------

  const topbar = $(".topbar");
  const navLinks = $$(".nav a");
  const navLine = $(".nav-line");
  const sections = navLinks.map((a) => $(a.getAttribute("href")));
  let activeLink = null;

  function onScroll() {
    topbar.classList.toggle("is-scrolled", window.scrollY > 8);
    const y = window.scrollY + window.innerHeight * 0.35;
    let found = -1;
    sections.forEach((s, i) => s.offsetTop <= y && (found = i));
    const link = navLinks[found] || null;
    if (link === activeLink) return;
    activeLink = link;
    navLinks.forEach((a) => a.classList.toggle("is-active", a === link));
    navLine.style.opacity = link ? 1 : 0;
    if (link) placeLine(navLine, link);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => {
    placeLine(tabLine, tabs[screen]);
    if (activeLink) placeLine(navLine, activeLink);
  });
  document.fonts?.ready.then(() => {
    placeLine(tabLine, tabs[screen]);
    if (activeLink) placeLine(navLine, activeLink);
  });
  placeLine(tabLine, tabs[screen]);
  onScroll();

  // LB / RB and Q / E jump between sections, like the app's tabs.
  function jump(dir) {
    const y = window.scrollY + 2;
    const tops = sections.map((s) => s.offsetTop - parseFloat(getComputedStyle(root).scrollPaddingTop || 0));
    let target = dir > 0 ? tops.find((t) => t > y + 4) : [...tops].reverse().find((t) => t < y - 4);
    if (target === undefined) target = dir > 0 ? tops.at(-1) : 0;
    window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  const clock = $(".clock");
  const tick = () => (clock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  tick();
  setInterval(tick, 15000);

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
    reveals.forEach((el) => io.observe(el));
    const end = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) trophy("completionist", "Completionist", "gold");
    }, { threshold: 0.5 });
    end.observe($(".finale"));
  } else {
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  // ---------- Toasts and trophies ----------

  const toasts = $(".toasts");
  function toast(html) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = html;
    toasts.append(t);
    setTimeout(() => {
      t.classList.add("out");
      t.addEventListener("animationend", () => t.remove(), { once: true });
    }, 4200);
  }
  const earned = new Set();
  try {
    JSON.parse(localStorage.getItem("mantel-trophies") || "[]").forEach((id) => earned.add(id));
  } catch {}
  function trophy(id, name, tier) {
    if (earned.has(id)) return;
    earned.add(id);
    try {
      localStorage.setItem("mantel-trophies", JSON.stringify([...earned]));
    } catch {}
    toast(`<span class="cup ${tier}"><svg><use href="#i-cup"/></svg></span><span><small>Trophy unlocked</small><b>${name}</b></span>`);
  }

  let opened = new Set();
  $$(".faq details").forEach((d, i) => d.addEventListener("toggle", () => {
    if (!d.open) return;
    opened.add(i);
    if (opened.size >= 3) trophy("manual", "Read the manual", "silver");
  }));

  // ---------- Controls: buttons and keys light up the pad and their row ----------

  const padParts = $$(".pad-art g[data-pad]");
  const padRows = $$(".binds [data-pad]");
  const keyRows = $$(".kbd-row [data-key]");
  const timers = new Map();
  let presses = 0;

  function flash(el, ms = 420) {
    el.classList.add("is-lit");
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => el.classList.remove("is-lit"), ms));
  }
  function lightPad(index) {
    const has = (el) => el.dataset.pad.split(" ").includes(String(index));
    const hit = [...padParts.filter(has), ...padRows.filter(has)];
    hit.forEach((el) => flash(el));
    if (hit.length) countPress();
  }
  function countPress() {
    const r = $("#controls").getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0 && ++presses >= 12) trophy("masher", "Button masher", "bronze");
  }
  padRows.forEach((row) => {
    const parts = () => padParts.filter((g) => g.dataset.pad.split(" ").some((n) => row.dataset.pad.split(" ").includes(n)));
    row.addEventListener("mouseenter", () => parts().forEach((g) => g.classList.add("is-lit")));
    row.addEventListener("mouseleave", () => parts().forEach((g) => g.classList.remove("is-lit")));
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const row = keyRows.find((li) => li.dataset.key.split(" ").includes(key));
    if (row) {
      flash(row);
      countPress();
    }
    if (key === "q" || key === "e") jump(key === "e" ? 1 : -1);
  });

  // ---------- Gamepad: spatial focus like the app, A selects, B backs out ----------

  const FOCUSABLE = 'a[href], button:not([data-step]), summary';
  const focusables = () => $$(FOCUSABLE).filter((el) => el.offsetParent !== null && !el.closest(".hintbar, .skip") && !el.classList.contains("skip"));

  function moveFocus(dir) {
    root.classList.add("pad");
    const list = focusables();
    const cur = document.activeElement;
    let next;
    if (!list.includes(cur)) {
      next = list.find((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }) || list[0];
    } else {
      const a = cur.getBoundingClientRect();
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      const [vx, vy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
      let best = Infinity;
      for (const el of list) {
        if (el === cur) continue;
        const b = el.getBoundingClientRect();
        const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
        const along = dx * vx + dy * vy;
        if (along <= 4) continue;
        const across = Math.abs(dx * vy) + Math.abs(dy * vx);
        const score = along + across * 2.2;
        if (score < best) (best = score), (next = el);
      }
    }
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
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
      lightPad(i);
      const active = document.activeElement;
      if (i === 0) {
        root.classList.add("pad");
        if (active && active !== document.body) active.click();
        else if (window.scrollY < window.innerHeight * 0.5) $("#download").click();
      } else if (i === 1) {
        const open = active?.closest?.("details[open]");
        if (open) open.open = false;
        else {
          window.scrollTo({ top: 0, behavior: "smooth" });
          $(".brand").focus({ preventScroll: true });
        }
      } else if (i === 4 || i === 5) {
        jump(i === 5 ? 1 : -1);
      } else if (i === 6 || i === 7) {
        setScreen(screen + (i === 7 ? 1 : -1));
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
        moveFocus(d);
      } else if (t >= held[d]) {
        held[d] = t + 140;
        moveFocus(d);
      }
    }
    requestAnimationFrame(poll);
  }

  window.addEventListener("gamepadconnected", () => {
    root.classList.add("pad");
    toast(`<span class="dot"></span><span>Controller connected. D-pad to move, <b>A</b> to select, <b>LB / RB</b> to switch sections.</span>`);
    setTimeout(() => trophy("pad", "Plugged in", "bronze"), 900);
    if (!polling) {
      polling = true;
      requestAnimationFrame(poll);
    }
  });
  window.addEventListener("gamepaddisconnected", () => {
    if (![...(navigator.getGamepads?.() || [])].some(Boolean)) root.classList.remove("pad");
  });
  document.addEventListener("pointerdown", () => root.classList.remove("pad"));
})();
