// UI sounds synthesised with WebAudio: no assets, nothing to load.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

/** Creating the context costs ~100 ms; do it up front instead of on the first key press. */
export function warmUpSound() {
  if (ctx) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
}

function audio(): [AudioContext, GainNode] | null {
  if (!enabled) return null;
  warmUpSound();
  const c = ctx!;
  if (c.state === "suspended") c.resume();
  return [c, master!];
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; to?: number; delay?: number } = {}) {
  const a = audio();
  if (!a) return;
  const [c, out] = a;
  const t = c.currentTime + (opts.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(opts.gain ?? 0.05, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function whoosh(dur: number, from: number, to: number, gain = 0.06) {
  const a = audio();
  if (!a) return;
  const [c, out] = a;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.4;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(out);
  src.start(t);
}

export const sound = {
  move: () => {
    tone(1320, 0.05, { gain: 0.028 });
    tone(2640, 0.03, { gain: 0.008 });
  },
  edge: () => tone(150, 0.08, { gain: 0.05, to: 110 }),
  select: () => {
    tone(740, 0.07, { type: "triangle", gain: 0.045 });
    tone(1110, 0.12, { type: "triangle", gain: 0.04, delay: 0.05 });
  },
  back: () => tone(620, 0.1, { type: "triangle", gain: 0.04, to: 380 }),
  tab: () => {
    tone(980, 0.05, { type: "triangle", gain: 0.03 });
    whoosh(0.12, 2400, 5200, 0.015);
  },
  open: () => whoosh(0.22, 600, 3000, 0.035),
  toggle: () => tone(1480, 0.06, { type: "square", gain: 0.012 }),
  launch: () => {
    whoosh(1.1, 180, 5200, 0.08);
    tone(110, 1.0, { type: "sine", gain: 0.09, to: 440 });
    tone(880, 0.6, { type: "triangle", gain: 0.03, delay: 0.55, to: 1760 });
    tone(1320, 0.8, { type: "sine", gain: 0.025, delay: 0.7 });
  },
};
