// Steam serves trailers only as DASH or HLS, and WebView2 plays neither by itself. This feeds
// the video track of the DASH version through Media Source Extensions: no player library, and
// the audio is never downloaded since trailers play muted.

interface Track {
  mime: string;
  init: string;
  chunk: (n: number) => string;
  first: number;
  count: number;
  /** Length of one chunk. */
  seconds: number;
}

/** Seconds buffered ahead of playback, and kept behind it. */
const AHEAD = 12;
const BEHIND = 8;
/** Skipped at the start of longer trailers: rating cards and fades from black. */
const SKIP = 6;

/** ISO 8601 durations as manifests write them: `PT2M32.8S`. */
function isoSeconds(iso: string | null): number {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** The smallest video stream at least `height` pixels tall, or the largest there is. */
async function readManifest(url: string, height: number, signal: AbortSignal): Promise<Track | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  const total = isoSeconds(doc.documentElement.getAttribute("mediaPresentationDuration"));
  const set = [...doc.getElementsByTagName("AdaptationSet")].find((a) => a.getAttribute("contentType") === "video");
  if (!set || !total) return null;
  const attr = (el: Element, name: string) => el.getAttribute(name) ?? set.getAttribute(name);
  const streams = [...set.getElementsByTagName("Representation")]
    .map((r) => ({ r, height: Number(r.getAttribute("height") ?? 0), mime: `${attr(r, "mimeType")}; codecs="${attr(r, "codecs")}"` }))
    .filter((s) => MediaSource.isTypeSupported(s.mime))
    .sort((a, b) => a.height - b.height);
  const pick = streams.find((s) => s.height >= height) ?? streams.at(-1);
  const tpl = pick && (pick.r.getElementsByTagName("SegmentTemplate")[0] ?? set.getElementsByTagName("SegmentTemplate")[0]);
  if (!pick || !tpl) return null;
  const id = pick.r.getAttribute("id") ?? "";
  const fill = (template: string, n = 0) =>
    new URL(
      template
        .replace(/\$RepresentationID\$/g, id)
        .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, width) => String(n).padStart(Number(width ?? 0), "0")),
      url,
    ).href;
  const seconds = Number(tpl.getAttribute("duration") ?? 0) / Number(tpl.getAttribute("timescale") ?? 1);
  if (!seconds) return null;
  return {
    mime: pick.mime,
    init: fill(tpl.getAttribute("initialization") ?? ""),
    chunk: (n) => fill(tpl.getAttribute("media") ?? "", n),
    first: Number(tpl.getAttribute("startNumber") ?? 1),
    count: Math.ceil(total / seconds - 0.001),
    seconds,
  };
}

function once(target: EventTarget, type: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => reject(signal.reason);
    target.addEventListener(type, () => (signal.removeEventListener("abort", abort), resolve()), { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => (clearTimeout(t), reject(signal.reason));
    const t = setTimeout(() => (signal.removeEventListener("abort", abort), resolve()), ms);
    signal.addEventListener("abort", abort, { once: true });
  });

/**
 * Streams the DASH trailer at `url` into `video`, looping, until `signal` aborts. Only a few
 * seconds around the playhead stay in memory. Playback starts with the first chunk unless
 * `held` says otherwise; pausing and resuming after that is the caller's. Throws when the
 * trailer can't be played.
 */
export async function streamTrailer(video: HTMLVideoElement, url: string, height: number, held: () => boolean, signal: AbortSignal) {
  const track = await readManifest(url, height, signal);
  if (!track) throw new Error("no stream this device can play");
  const source = new MediaSource();
  video.src = URL.createObjectURL(source);
  signal.addEventListener(
    "abort",
    () => {
      URL.revokeObjectURL(video.src);
      video.removeAttribute("src");
      video.load();
    },
    { once: true },
  );
  await once(source, "sourceopen", signal);
  const buffer = source.addSourceBuffer(track.mime);
  // Each chunk lands right after the previous one, so the start can follow the end.
  buffer.mode = "sequence";
  const append = async (data: ArrayBuffer) => {
    buffer.appendBuffer(data);
    await once(buffer, "updateend", signal);
  };
  const get = async (src: string) => {
    const res = await fetch(src, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  };

  await append(await get(track.init));
  const start = track.count * track.seconds > 30 ? Math.floor(SKIP / track.seconds) : 0;
  let n = start;
  let started = false;
  for (;;) {
    const ranges = buffer.buffered;
    if (ranges.length && ranges.end(ranges.length - 1) - video.currentTime > AHEAD) {
      if (ranges.start(0) < video.currentTime - BEHIND - 4) {
        buffer.remove(0, video.currentTime - BEHIND);
        await once(buffer, "updateend", signal);
      }
      await sleep(500, signal);
      continue;
    }
    await append(await get(track.chunk(track.first + n)));
    n = n + 1 < track.count ? n + 1 : start;
    if (!started && !held()) {
      started = true;
      video.play().catch(() => {});
    }
  }
}
