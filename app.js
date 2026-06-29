// VIDEOSQUEEZE — local video compressor / converter (MP4 · GIF)
// FFmpeg compiled to WebAssembly runs entirely in the browser. No upload.

// Vendored locally (in ./vendor) so the library's internal worker is same-origin —
// cross-origin workers are blocked under the COOP/COEP isolation we need for the
// fast multithreaded core. See README.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { fetchFile, toBlobURL } from "./vendor/util/index.js";

// ─────────────────────────── state ───────────────────────────
const S = {
  ffmpeg: null,
  ready: false,
  file: null,
  meta: null,          // { width, height, duration }  — from <video> or ffmpeg probe
  format: "mp4",       // mp4 | gif
  mode: "quality",     // quality | target   (mp4 only)
  audio: "keep",       // keep | mute        (mp4 only)
  lastOutURL: null,
  trim: { start: 0, end: null }, // seconds; end null = to the end
  trimDur: null,       // duration backing the trim timeline (seconds)
};

// ─────────────────────────── dom ─────────────────────────────
const $ = (id) => document.getElementById(id);
const drop = $("drop"), fileInput = $("fileInput");
const sourceCard = $("sourceCard"), srcVideo = $("srcVideo");
const srcRes = $("srcRes"), srcDur = $("srcDur"), srcSize = $("srcSize"), srcName = $("srcName");
const engine = $("engine"), engineText = $("engineText");
const convertBtn = $("convertBtn"), goSub = $("goSub");
const progress = $("progress"), pfill = $("pfill"), pPct = $("pPct"), pLabel = $("pLabel");
const logEl = $("log"), logToggle = $("logToggle");
const resultPanel = $("resultPanel"), resultFrame = $("resultFrame");
const outSize = $("outSize"), outDelta = $("outDelta"), downloadBtn = $("downloadBtn"), reuseBtn = $("reuseBtn");
const scaleSel = $("scaleSel"), scaleCustom = $("scaleCustom"), fpsSel = $("fpsSel");
const speedSel = $("speedSel"), speedCustom = $("speedCustom"), speedHint = $("speedHint");
const crf = $("crf"), crfVal = $("crfVal"), preset = $("preset");
const targetMB = $("targetMB"), targetBitrate = $("targetBitrate");
const modeField = $("modeField"), qualityBox = $("qualityBox"), targetBox = $("targetBox"), audioField = $("audioField");
const toast = $("toast");
const trimEmpty = $("trimEmpty"), trimWrap = $("trimWrap"), trimStrip = $("trimStrip");
const maskL = $("maskL"), maskR = $("maskR"), trimBand = $("trimBand"), playhead = $("playhead");
const trimReadout = $("trimReadout"), trimStartLbl = $("trimStartLbl"), trimEndLbl = $("trimEndLbl"), trimSelLbl = $("trimSelLbl");

// ─────────────────────── helpers ─────────────────────────────
const fmtBytes = (b) => {
  if (b == null) return "—";
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB"]; let i = -1, n = b;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 2 : 1) + " " + u[i];
};
const fmtDur = (s) => {
  if (!isFinite(s)) return "—";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};
const parseTime = (str) => {
  if (!str) return null;
  str = str.trim();
  if (!str) return null;
  if (str.includes(":")) {
    const p = str.split(":").map(Number);
    if (p.some(isNaN)) return null;
    return p.reduce((a, v) => a * 60 + v, 0);
  }
  const n = Number(str);
  return isNaN(n) ? null : n;
};
const evenDown = (n) => Math.max(2, Math.floor(n / 2) * 2);
const finiteDur = () => (S.meta && isFinite(S.meta.duration) && S.meta.duration > 0) ? S.meta.duration : null;
const showToast = (msg, ms = 3800) => {
  toast.textContent = msg; toast.classList.add("show");
  clearTimeout(showToast._t); showToast._t = setTimeout(() => toast.classList.remove("show"), ms);
};
const log = (line, isErr = false) => {
  const span = document.createElement("span");
  if (isErr) span.className = "err";
  span.textContent = line + "\n";
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
};

// ─────────────────────── ffmpeg boot ─────────────────────────
async function boot() {
  // Single-threaded core: rock-solid and works even if the tab is backgrounded.
  // (The multithreaded core is faster but stalls in background tabs and crashes
  //  with "function signature mismatch" on some inputs, so we don't use it.)
  engineText.textContent = "engine · loading";
  try {
    const base = "./vendor/core";
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => log(message));
    ff.on("progress", ({ progress: p }) => updateProgress(p));
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
    });
    S.ffmpeg = ff;
  } catch (e) {
    engine.className = "engine error";
    engineText.textContent = "engine · failed";
    log("ffmpeg failed to load: " + e, true);
    showToast("Engine failed to load. Open this page through serve.py (not as a file).");
    return;
  }
  S.ready = true;
  S.mt = false;
  engine.className = "engine ready";
  engineText.textContent = "engine · ready";
  refreshButton();
}

// ─────────────────────── file loading ────────────────────────
function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/") && !/\.(mov|mp4|webm|mkv|avi|m4v|m4p)$/i.test(file.name)) {
    showToast("That doesn't look like a video file."); return;
  }
  S.file = file;
  S.meta = null;
  const url = URL.createObjectURL(file);
  srcVideo.src = url;
  srcName.textContent = file.name;
  srcSize.textContent = fmtBytes(file.size);
  srcRes.textContent = "…"; srcDur.textContent = "…";
  // <video> metadata is a fast path; ffmpeg probe is the reliable fallback.
  srcVideo.onloadedmetadata = () => {
    if (srcVideo.videoWidth) {
      S.meta = { width: srcVideo.videoWidth, height: srcVideo.videoHeight, duration: srcVideo.duration };
      srcRes.textContent = `${srcVideo.videoWidth}×${srcVideo.videoHeight}`;
      srcDur.textContent = fmtDur(srcVideo.duration);
      updateTargetBitrate();
    }
  };
  $("srcIdx").textContent = `loaded · 01`;
  drop.style.display = "none";
  sourceCard.classList.add("show");
  resultPanel.style.display = "none";
  refreshButton();
  buildTrimmer(file); // async — fills the scrub timeline when frames are decoded
}

drop.addEventListener("click", () => fileInput.click());
$("changeFile").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => loadFile(e.target.files[0]));
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); if (e.target.closest("#controlPanel")) return; if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

// ─────────────────────── control wiring ──────────────────────
$("fmtSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.format = b.dataset.fmt;
  [...e.currentTarget.children].forEach(x => x.classList.toggle("on", x === b));
  applyFormatUI();
});
$("modeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.mode = b.dataset.mode;
  [...e.currentTarget.children].forEach(x => x.classList.toggle("on", x === b));
  qualityBox.classList.toggle("hidden", S.mode !== "quality");
  targetBox.classList.toggle("hidden", S.mode !== "target");
  refreshButton();
});
$("audioSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.audio = b.dataset.audio;
  [...e.currentTarget.children].forEach(x => x.classList.toggle("on", x === b));
  updateTargetBitrate();
});
crf.addEventListener("input", () => crfVal.textContent = "CRF " + crf.value);
scaleSel.addEventListener("change", () => {
  scaleCustom.classList.toggle("hidden", scaleSel.value !== "custom");
});
[targetMB, fpsSel, scaleSel, scaleCustom].forEach(el => el.addEventListener("input", updateTargetBitrate));
speedSel.addEventListener("change", () => {
  speedCustom.classList.toggle("hidden", speedSel.value !== "custom");
  onSpeedChange();
});
speedCustom.addEventListener("input", onSpeedChange);

// playback speed multiplier (1 = normal). Clamped to a sane range.
function getSpeed() {
  let v = speedSel.value === "custom" ? Number(speedCustom.value) : Number(speedSel.value);
  if (!v || v <= 0 || !isFinite(v)) return 1;
  return Math.min(100, Math.max(0.05, v));
}
// ffmpeg atempo only accepts 0.5–2.0 per stage; chain stages for anything outside that.
function atempoChain(speed) {
  let s = speed; const parts = [];
  while (s > 2.0) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push("atempo=" + s.toFixed(6));
  return parts.join(",");
}
function onSpeedChange() {
  const sp = getSpeed();
  try { srcVideo.playbackRate = Math.min(16, Math.max(0.0625, sp)); } catch (_) {}
  const len = selectionLength();
  speedHint.textContent = (sp !== 1 && len) ? `→ ${fmtClock(len / sp)} output` : (sp !== 1 ? `${sp}×` : "playback rate");
  updateTargetBitrate();
}

function applyFormatUI() {
  const gif = S.format === "gif";
  modeField.classList.toggle("hidden", gif);
  audioField.classList.toggle("hidden", gif);
  if (gif) {
    qualityBox.classList.add("hidden");
    targetBox.classList.add("hidden");
    if (scaleSel.value === "source") { scaleSel.value = "480"; scaleCustom.classList.add("hidden"); }
    if (fpsSel.value === "source") fpsSel.value = "12";
  } else {
    qualityBox.classList.toggle("hidden", S.mode !== "quality");
    targetBox.classList.toggle("hidden", S.mode !== "target");
  }
  refreshButton();
  updateTargetBitrate();
}

// length of the (possibly trimmed) selection, seconds — or null if duration unknown
function selectionLength() {
  const D = finiteDur(); if (!D) return null;
  const start = (S.trim && S.trim.start > 0) ? S.trim.start : 0;
  const end = (S.trim && S.trim.end > 0) ? Math.min(S.trim.end, D) : D;
  return Math.max(0.1, end - start);
}

function updateTargetBitrate() {
  const len = selectionLength();
  if (S.format !== "mp4" || S.mode !== "target") { targetBitrate.textContent = "—"; return; }
  const mb = Number(targetMB.value);
  if (!mb || !len) { targetBitrate.textContent = len ? "—" : "needs duration"; return; }
  const outDur = len / getSpeed(); // speed changes the final running time → changes bitrate
  const totalBits = mb * 8 * 1024 * 1024 * 0.97;
  const audioBits = (S.audio === "mute" ? 0 : 128000) * outDur;
  let vK = Math.max(50, Math.floor((totalBits - audioBits) / outDur / 1000));
  targetBitrate.textContent = "≈ " + vK + "k video";
}

// target width (never upscales), even. null = keep source
function targetWidth() {
  let w;
  if (scaleSel.value === "custom") w = Number(scaleCustom.value);
  else if (scaleSel.value === "source") return null;
  else w = Number(scaleSel.value);
  if (!w || w <= 0) return null;
  if (S.meta && S.meta.width && w >= S.meta.width) return null; // don't upscale
  return evenDown(w);
}

function refreshButton() {
  const can = S.ready && !!S.file;
  convertBtn.disabled = !can;
  if (!S.ready) goSub.textContent = "engine still loading…";
  else if (!S.file) goSub.textContent = "load a video first";
  else goSub.textContent = S.format === "gif" ? "→ animated GIF" : (S.mode === "target" ? "→ MP4 at target size" : "→ compressed MP4");
}

// ─────────────────────── progress ────────────────────────────
function updateProgress(p) {
  const pct = Math.max(0, Math.min(100, Math.round((p || 0) * 100)));
  pfill.style.width = pct + "%";
  pPct.textContent = pct + "%";
  S._lastPts = performance.now();
}

// read width/height/duration/fps from ffmpeg itself (reliable; independent of browser decode)
// fps = the *average* frame rate. We must capture it because screen recordings are often
// variable-frame-rate with an inflated r_frame_rate tag (e.g. 120) that, left unconstrained,
// makes the encoder emit a 120fps file that plays as slow-motion on 60Hz players.
async function probeMeta(ff, inName) {
  if (S.meta && S.meta.width && isFinite(S.meta.duration) && S.meta.fps) return;
  const before = logEl.textContent.length;
  try { await ff.exec(["-hide_banner", "-i", inName]); } catch (_) {} // -i with no output exits non-zero by design
  const txt = logEl.textContent.slice(before);
  const dm = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const rm = txt.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  const fm = txt.match(/,\s*([\d.]+)\s*fps\b/); // average fps from the Video: stream line
  let width = S.meta?.width, height = S.meta?.height, duration = S.meta?.duration, fps = S.meta?.fps;
  if (rm) { width = +rm[1]; height = +rm[2]; }
  if (dm) duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
  if (fm && parseFloat(fm[1]) > 0) fps = parseFloat(fm[1]);
  if (width || (duration && isFinite(duration)) || fps) {
    S.meta = { width: width || 0, height: height || 0, duration: (duration && isFinite(duration)) ? duration : 0, fps: fps || 0 };
    if (width) srcRes.textContent = `${width}×${height || "?"}`;
    if (duration && isFinite(duration)) srcDur.textContent = fmtDur(duration);
  }
}

// ─────────────────────── visual trimmer ──────────────────────
// Grab `count` thumbnails by seeking an offscreen <video> and drawing each frame.
function grabThumbs(file, count) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto"; v.muted = true; v.playsInline = true;
    v.src = URL.createObjectURL(file);
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e || new Error("decode failed")); } };
    v.onerror = () => fail(v.error || new Error("video error"));
    v.onloadedmetadata = async () => {
      try {
        const dur = v.duration;
        if (!isFinite(dur) || dur <= 0) return fail(new Error("no duration"));
        const cw = 168, ch = Math.max(2, Math.round(cw * (v.videoHeight / v.videoWidth || 0.56)));
        const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
        const ctx = cv.getContext("2d");
        const seek = (t) => new Promise((res, rej) => {
          const to = setTimeout(() => rej(new Error("seek timeout")), 8000);
          v.onseeked = () => { clearTimeout(to); res(); };
          try { v.currentTime = t; } catch (e) { clearTimeout(to); rej(e); }
        });
        const thumbs = [];
        for (let i = 0; i < count; i++) {
          await seek(Math.min(dur - 0.04, dur * (i + 0.5) / count));
          ctx.drawImage(v, 0, 0, cw, ch);
          thumbs.push(cv.toDataURL("image/jpeg", 0.6));
        }
        done = true;
        resolve({ thumbs, dur });
      } catch (e) { fail(e); }
    };
  });
}

async function buildTrimmer(file) {
  S.trim = { start: 0, end: null }; S.trimDur = null;
  trimEmpty.hidden = false; trimEmpty.textContent = "building timeline…";
  trimWrap.hidden = true; trimReadout.hidden = true; playhead.hidden = true;
  let info;
  try { info = await grabThumbs(file, 14); }
  catch (e) {
    log("timeline thumbnails unavailable: " + e, true);
    trimEmpty.hidden = false;
    trimEmpty.textContent = "scrub preview unavailable — the whole clip will be used";
    return;
  }
  S.trimDur = info.dur;
  S.trim = { start: 0, end: null };
  trimStrip.innerHTML = "";
  info.thumbs.forEach(d => { const img = new Image(); img.src = d; img.draggable = false; trimStrip.appendChild(img); });
  trimEmpty.hidden = true; trimWrap.hidden = false; trimReadout.hidden = false;
  layoutTrim();
}

function layoutTrim() {
  const dur = S.trimDur; if (!dur) return;
  const a = Math.max(0, (S.trim.start || 0) / dur);
  const b = Math.min(1, (S.trim.end != null ? S.trim.end : dur) / dur);
  maskL.style.width = (a * 100) + "%";
  maskR.style.width = ((1 - b) * 100) + "%";
  trimBand.style.left = (a * 100) + "%";
  trimBand.style.right = ((1 - b) * 100) + "%";
  trimStartLbl.textContent = fmtClock(S.trim.start || 0);
  trimEndLbl.textContent = fmtClock(S.trim.end != null ? S.trim.end : dur);
  const full = (S.trim.start || 0) < 0.05 && S.trim.end == null;
  trimSelLbl.textContent = full ? "full clip" : (fmtClock(selectionLength()) + " selected");
}

const fmtClock = (s) => {
  if (!isFinite(s)) return "—";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), d = Math.floor((s % 1) * 10);
  return `${m}:${String(sec).padStart(2, "0")}.${d}`;
};

function seekPreview(t) {
  try { srcVideo.pause(); srcVideo.currentTime = Math.max(0, t || 0); } catch (_) {}
  setPlayhead((t || 0) / (S.trimDur || 1));
}
function setPlayhead(frac) {
  if (!S.trimDur) return;
  playhead.hidden = false;
  playhead.style.left = (Math.max(0, Math.min(1, frac)) * 100) + "%";
}

function initTrimUI() {
  let drag = null;
  const fracOf = (clientX, rect) => Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));

  trimWrap.addEventListener("pointerdown", (e) => {
    if (!S.trimDur) return;
    const rect = trimWrap.getBoundingClientRect();
    const handle = e.target.closest(".tl-handle");
    const f = fracOf(e.clientX, rect);
    if (handle) {
      drag = { type: handle.dataset.h, rect };
    } else {
      const a = (S.trim.start || 0) / S.trimDur, b = (S.trim.end != null ? S.trim.end : S.trimDur) / S.trimDur;
      if (f > a && f < b) drag = { type: "band", rect, grab: f, a, b };
      else { seekPreview(f * S.trimDur); return; } // click outside band = scrub
    }
    trimWrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  trimWrap.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dur = S.trimDur, gap = Math.max(0.15, dur * 0.008);
    const f = fracOf(e.clientX, drag.rect);
    if (drag.type === "l") {
      const endS = S.trim.end != null ? S.trim.end : dur;
      S.trim.start = Math.max(0, Math.min(f * dur, endS - gap));
      seekPreview(S.trim.start);
    } else if (drag.type === "r") {
      let endS = Math.min(dur, Math.max(f * dur, (S.trim.start || 0) + gap));
      S.trim.end = endS >= dur - 0.04 ? null : endS;
      seekPreview(endS);
    } else if (drag.type === "band") {
      const len = drag.b - drag.a;
      let na = Math.max(0, Math.min(1 - len, drag.a + (f - drag.grab)));
      S.trim.start = na * dur;
      const nb = na + len;
      S.trim.end = nb >= 1 - 0.0006 ? null : nb * dur;
    }
    layoutTrim();
    updateTargetBitrate();
  });

  const stop = (e) => { if (drag) { drag = null; try { trimWrap.releasePointerCapture(e.pointerId); } catch (_) {} } };
  trimWrap.addEventListener("pointerup", stop);
  trimWrap.addEventListener("pointercancel", stop);

  $("trimReset").addEventListener("click", () => {
    if (!S.trimDur) return;
    S.trim = { start: 0, end: null };
    layoutTrim(); updateTargetBitrate();
  });

  // playhead follows the preview while it plays
  srcVideo.addEventListener("timeupdate", () => {
    if (S.trimDur && !srcVideo.paused) setPlayhead(srcVideo.currentTime / S.trimDur);
  });
}

// ─────────────────────── convert ─────────────────────────────
convertBtn.addEventListener("click", convert);

async function convert() {
  if (!S.ready || !S.file) return;
  convertBtn.disabled = true;
  progress.classList.add("show");
  updateProgress(0);
  pLabel.textContent = "reading…";
  logEl.textContent = "";
  resultPanel.style.display = "none";

  const ff = S.ffmpeg;
  const ext = (S.file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "mov").toLowerCase();
  const inName = "input." + ext;
  const t0 = performance.now();

  // watchdog: reassure (rather than look frozen) if a big encode runs quietly for a while.
  S._lastPts = t0;
  let warned = false;
  const watchdog = setInterval(() => {
    if (!warned && performance.now() - (S._lastPts || t0) > 22000) {
      warned = true;
      showToast("Still working — long / high-res videos take a while. The bar moves as frames encode.", 9000);
    }
  }, 4000);

  try {
    await ff.writeFile(inName, await fetchFile(S.file));
    await probeMeta(ff, inName);

    const D = finiteDur(); // seconds or null

    // trim (input seeking) — driven by the visual timeline handles
    const start = (S.trim && S.trim.start > 0) ? S.trim.start : 0;
    let end = (S.trim && S.trim.end > 0) ? S.trim.end : null;
    if (end != null && D && end > D) end = D;
    if (end != null && D && end >= D - 0.04) end = null; // at the very end = full
    let lenForBitrate = null;
    if (end != null) lenForBitrate = Math.max(0.1, end - start);
    else if (D) lenForBitrate = Math.max(0.1, D - start);
    const pre = start > 0 ? ["-ss", String(start)] : [];
    const post = (end != null) ? ["-t", String(Math.max(0.1, end - start))]
      : (start > 0 && D ? ["-t", String(Math.max(0.1, D - start))] : []);

    const w = targetWidth();
    const fpsExplicit = fpsSel.value === "source" ? null : Number(fpsSel.value);
    // Force a constant output frame rate. For "keep original" we use the source's
    // AVERAGE fps (capped at 60) — never the raw r_frame_rate tag, which for VFR
    // screen recordings is often 120 and yields a slow-motion / bloated result.
    const mp4Fps = fpsExplicit || (S.meta && S.meta.fps ? Math.min(60, Math.round(S.meta.fps)) : 30);

    // speed: setpts retimes video (PTS *= 1/speed), atempo retimes audio (pitch-preserved)
    const speed = getSpeed();
    const speedVF = speed !== 1 ? `setpts=${(1 / speed).toFixed(6)}*PTS` : null;

    let outName, mime;
    if (S.format === "gif") {
      outName = "output.gif"; mime = "image/gif";
      const gw = w || (S.meta && S.meta.width ? evenDown(S.meta.width) : 480);
      const gfps = fpsExplicit || 12;
      const vf = `${speedVF ? speedVF + "," : ""}fps=${gfps},scale=${gw}:-1:flags=lanczos`;
      pLabel.textContent = "building palette…";
      await ff.exec([...pre, "-i", inName, ...post, "-vf", `${vf},palettegen=stats_mode=diff`, "-y", "palette.png"]);
      pLabel.textContent = "rendering GIF…";
      updateProgress(0);
      await ff.exec([...pre, "-i", inName, ...post, "-i", "palette.png",
        "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        "-y", outName]);
      try { await ff.deleteFile("palette.png"); } catch (_) {}
    } else {
      outName = "output.mp4"; mime = "video/mp4";
      const filters = [];
      if (speedVF) filters.push(speedVF);
      if (mp4Fps) filters.push(`fps=${mp4Fps}`);
      if (w) filters.push(`scale=${w}:-2`);
      const args = [...pre, "-i", inName, ...post];
      if (filters.length) args.push("-vf", filters.join(","));
      args.push("-c:v", "libx264", "-preset", preset.value, "-pix_fmt", "yuv420p");
      if (S.mode === "target") {
        // speed changes the final running time, which is what determines size at a given bitrate
        const outDur = (lenForBitrate && isFinite(lenForBitrate)) ? lenForBitrate / speed : null;
        if (outDur) {
          const mb = Number(targetMB.value) || 8;
          const totalBits = mb * 8 * 1024 * 1024 * 0.97;
          const audioBits = (S.audio === "mute" ? 0 : 128000) * outDur;
          let vK = Math.max(50, Math.floor((totalBits - audioBits) / outDur / 1000));
          args.push("-b:v", vK + "k", "-maxrate", vK + "k", "-bufsize", (vK * 2) + "k");
        } else {
          args.push("-crf", "26");
          showToast("Couldn't read duration — encoded at quality CRF 26 instead of a target size.");
        }
      } else {
        args.push("-crf", crf.value);
      }
      if (S.audio === "mute") args.push("-an");
      else {
        args.push("-c:a", "aac", "-b:a", "128k");
        if (speed !== 1) args.push("-af", atempoChain(speed)); // keep audio in sync, pitch preserved
      }
      args.push("-movflags", "+faststart", "-y", outName);
      pLabel.textContent = "encoding H.264…";
      await ff.exec(args);
    }

    const data = await ff.readFile(outName);
    if (!data || !data.length) throw new Error("empty output — see log");
    const blob = new Blob([data.buffer], { type: mime });
    showResult(blob, mime, performance.now() - t0);

    try { await ff.deleteFile(inName); } catch (_) {}
    try { await ff.deleteFile(outName); } catch (_) {}
  } catch (e) {
    log("conversion error: " + e, true);
    logEl.classList.add("show"); logToggle.textContent = "▾ ffmpeg log";
    showToast("Conversion failed — open the ffmpeg log for details.");
  } finally {
    clearInterval(watchdog);
    progress.classList.remove("show");
    convertBtn.disabled = false;
    refreshButton();
  }
}

function showResult(blob, mime, ms) {
  if (S.lastOutURL) URL.revokeObjectURL(S.lastOutURL);
  const url = URL.createObjectURL(blob);
  S.lastOutURL = url;

  resultFrame.innerHTML = "";
  if (mime === "image/gif") {
    const img = document.createElement("img"); img.src = url; resultFrame.appendChild(img);
  } else {
    const v = document.createElement("video");
    v.src = url; v.controls = true; v.muted = true; v.loop = true; v.playsInline = true;
    resultFrame.appendChild(v);
  }
  resultFrame.insertAdjacentHTML("beforeend",
    '<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>');

  outSize.textContent = fmtBytes(blob.size);
  const pct = Math.round((1 - blob.size / S.file.size) * 100);
  if (pct > 0) { outDelta.textContent = "−" + pct + "%"; outDelta.className = "v good"; }
  else { outDelta.textContent = "+" + Math.abs(pct) + "%"; outDelta.className = "v neutral"; }

  const base = S.file.name.replace(/\.[^.]+$/, "");
  downloadBtn.href = url;
  downloadBtn.download = base + (S.format === "gif" ? ".gif" : "-squeezed.mp4");

  resultPanel.style.display = "";
  resultPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  showToast(`Done in ${(ms / 1000).toFixed(1)}s · ${fmtBytes(blob.size)}${pct > 0 ? " (" + pct + "% smaller)" : ""}`);
}

reuseBtn.addEventListener("click", () => {
  if (!S.lastOutURL) return;
  fetch(S.lastOutURL).then(r => r.blob()).then(b => {
    loadFile(new File([b], downloadBtn.download || "result", { type: b.type }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

logToggle.addEventListener("click", () => {
  const open = logEl.classList.toggle("show");
  logToggle.textContent = (open ? "▾" : "▸") + " ffmpeg log";
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !convertBtn.disabled && e.target.tagName !== "TEXTAREA") {
    if (document.activeElement.tagName !== "INPUT" || e.metaKey || e.ctrlKey) convert();
  }
});

// ─────────────────────── go ───────────────────────────────────
// expose for diagnostics / scripted verification
window.__VS = S;
initTrimUI();
applyFormatUI();
boot();
