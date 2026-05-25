// air-piano-gesture.js — Webcam, MediaPipe Tasks Vision, gesture detection, debug panel.
//
// Press detection: per-fingertip foreshortening only, per-finger sensitivity threshold.
//
// Range gesture (mini-piano region):
//   - thumb+index inside the highlighted region → zoom; index+middle → pan.
//   - 2 consecutive detection frames to arm; 6 frames out to disarm.
//   - Zoom: continuous, semitone-granular, range 1–4 octaves.
//   - Pan: white-key snapped across the full 88-key strip.
//   - While armed, key-press detection is suppressed.

(() => {
  const video      = document.getElementById("cam");
  const btn        = document.getElementById("camBtn");
  const label      = document.getElementById("camBtnLabel");
  const overlay    = document.getElementById("fingerOverlay");
  const statusEl   = document.getElementById("gestureStatus");
  const statusText = document.getElementById("gestureStatusText");
  const hudStatusEl  = document.getElementById("hudStatus");
  const fpsEl        = document.getElementById("fps");
  const octx       = overlay.getContext("2d");

  let stream = null;
  let errorEl = null;
  // handLandmarker persists across start/stop — eliminates re-download on every camera toggle.
  // Never call .close() — known browser-freeze bug in tasks-vision (#5718).
  let handLandmarker = null;
  let handLandmarkerReady = false;
  let handLandmarkerLoading = false;
  let processing = false;
  let rafId = null;
  let inferStartAt = 0;
  // lastVideoTime guard: skip detectForVideo when video frame hasn't advanced (rAF=60fps, cam=30fps).
  let lastVideoTime = -1;

  // FPS tracking (detection rate)
  let fpsFrameCount = 0;
  let fpsLastAt = performance.now();

  let _hudStatusLast = null, _statusTextLast = null, _statusShowLast = null;
  let _miniStatusLast = null, _miniStatusLiveLast = null;

  function setHudStatus(text) {
    if (hudStatusEl && text !== _hudStatusLast) { hudStatusEl.textContent = text; _hudStatusLast = text; }
  }
  function setMiniStatus(text, live = false) {
    const el = document.getElementById("miniStatus");
    if (!el) return;
    if (text !== _miniStatusLast) { el.textContent = text; _miniStatusLast = text; }
    if (live !== _miniStatusLiveLast) { el.classList.toggle("live", live); _miniStatusLiveLast = live; }
  }

  // MediaPipe Hands landmark indices
  const FINGERTIPS = [4, 8, 12, 16, 20];
  const MCPS       = [2, 5, 9, 13, 17];
  const FINGER_LBL = ["thumb","index","middle","ring","pinky"];
  const PNAMES     = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  const fingerState = new Map();
  const debugRows   = new Map();

  // ── Tuning ──
  const BASELINE_DECAY     = 0.92;
  const MIN_BASELINE_FS    = 0.18;
  // 30s last-resort timeout — presses can be held indefinitely now that ratcheting is fixed.
  const MAX_HOLD_MS        = 30000;
  const TRAIL_LEN          = 14;
  const FS_THR_AT_SENS_0   = 0.40;
  const FS_THR_AT_SENS_1   = 0.05;
  const RELEASE_FRAC       = 0.45;

  // ── Per-finger sensitivity (persisted) ──
  const SENS_KEY = "airPiano.sens.v3";
  const DEFAULT_SENS = {
    lh_thumb: 0.70, lh_index: 0.15, lh_middle: 0.20, lh_ring: 0.35, lh_pinky: 0.50,
    rh_thumb: 0.70, rh_index: 0.15, rh_middle: 0.20, rh_ring: 0.35, rh_pinky: 0.50,
  };
  let sensitivity = { ...DEFAULT_SENS };
  try {
    const saved = JSON.parse(localStorage.getItem(SENS_KEY) || "null");
    if (saved && typeof saved === "object") sensitivity = { ...DEFAULT_SENS, ...saved };
  } catch (_) {}
  function persistSens() {
    try { localStorage.setItem(SENS_KEY, JSON.stringify(sensitivity)); } catch (_) {}
  }
  function updateDetectionGlobal() {
    window.__airPianoDetection = {
      rows: [...debugRows.values()].map(r => ({
        hand: r.hand,
        fingerIdx: r.fingerIdx,
        fsDrop: r.fsDrop,
        triggerThr: r.triggerThr,
        pressed: r.pressed,
      })),
    };
  }
  window.__airPianoGetSens = () => ({ ...sensitivity });
  window.__airPianoSetSens = (finger, value) => {
    sensitivity[finger] = Math.max(0, Math.min(1, value));
    persistSens();
  };

  function thresholdFor(sensKey) {
    const s = Math.max(0, Math.min(1, sensitivity[sensKey] ?? 0.5));
    return FS_THR_AT_SENS_0 + (FS_THR_AT_SENS_1 - FS_THR_AT_SENS_0) * s;
  }

  // ── Accent color cache ──
  function readVarRGB(name, fallback) {
    const s = getComputedStyle(document.body).getPropertyValue(name).trim();
    const parts = s.split(",").map(p => parseFloat(p.trim()));
    return parts.length === 3 && parts.every(p => !isNaN(p)) ? parts : fallback;
  }
  let accentRGB = readVarRGB("--accent-rgb", [109, 241, 255]);
  let glowRGB   = readVarRGB("--glow-rgb",   [140, 225, 255]);
  function aRgba(a) { return `rgba(${accentRGB[0]},${accentRGB[1]},${accentRGB[2]},${a})`; }
  function gRgba(a) { return `rgba(${glowRGB[0]},${glowRGB[1]},${glowRGB[2]},${a})`; }
  window.addEventListener("airpiano:theme", () => {
    accentRGB = readVarRGB("--accent-rgb", [109, 241, 255]);
    glowRGB   = readVarRGB("--glow-rgb",   [140, 225, 255]);
  });

  // ── Range helpers (synced with React side via window.__airPianoMeta) ──
  function getMeta() { return window.__airPianoMeta || null; }
  function getRange() {
    return window.__airPianoGetRange ? window.__airPianoGetRange() : null;
  }
  function nameOf(m) {
    const pcv = ((m % 12) + 12) % 12;
    const oct = Math.floor(m / 12) - 1;
    return PNAMES[pcv] + oct;
  }
  function clampStartMidi(targetSm, span) {
    const meta = getMeta();
    if (!meta) return targetSm;
    const minStart = meta.pianoMinMidi;
    const maxStart = meta.pianoMaxMidi - span * 12;
    const allW = meta.allWhiteMidis;
    const clamped = Math.max(minStart, Math.min(targetSm, maxStart));
    let best = allW[0];
    for (const m of allW) {
      if (m > maxStart) break;
      if (m <= clamped) best = m;
      else break;
    }
    return best;
  }

  // Tracks previous handScale per hand index to detect glitch frames.
  const prevHandScale = new Map();

  // Cached DOM refs for gesture targets — stable after React mounts.
  let _cachedRegionEl = null, _cachedMiniEl = null;
  function getRegionEl() { return _cachedRegionEl || (_cachedRegionEl = document.querySelector(".mini-region")); }
  function getMiniEl()   { return _cachedMiniEl   || (_cachedMiniEl   = document.querySelector(".mini-piano")); }

  // ── Gesture state ──
  const gesture = {
    mode: "idle",           // 'idle' | 'armed'
    handIdx: -1,
    framesIn: 0,
    framesOut: 0,
    startMidX: 0,
    startSpread: 0,
    startWhiteIdx: 0,
    startSpan: 2,
    axis: null,             // null | 'pan' | 'zoom'
  };

  // ────────────────────── UI helpers ──────────────────────
  function showError(msg) {
    if (!errorEl) {
      errorEl = document.createElement("div");
      errorEl.className = "cam-error";
      document.body.appendChild(errorEl);
    }
    errorEl.textContent = msg;
    clearTimeout(showError._t);
    showError._t = setTimeout(() => {
      if (errorEl) { errorEl.remove(); errorEl = null; }
    }, 5000);
  }

  function setStatus(text, show = true) {
    if (text && text !== _statusTextLast) { statusText.textContent = text; _statusTextLast = text; }
    if (show !== _statusShowLast) { statusEl.classList.toggle("show", show); _statusShowLast = show; }
  }

  function resizeOverlay() {
    const dpr = window.devicePixelRatio || 1;
    overlay.width = window.innerWidth * dpr;
    overlay.height = window.innerHeight * dpr;
    overlay.style.width = window.innerWidth + "px";
    overlay.style.height = window.innerHeight + "px";
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeOverlay();
  window.addEventListener("resize", resizeOverlay);

  function releaseAllFingers() {
    for (const [, state] of fingerState) {
      if (state.midi != null && window.__airPianoRelease) window.__airPianoRelease(state.midi);
    }
    fingerState.clear();
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  async function initHands() {
    if (handLandmarkerReady || handLandmarkerLoading) return handLandmarkerReady;
    handLandmarkerLoading = true;
    setStatus("loading model…", true);
    setHudStatus("INITIALIZING");
    try {
      const { FilesetResolver, HandLandmarker } = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"
      );
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        numHands: 2,
        runningMode: "VIDEO",
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      handLandmarkerReady = true;
      setStatus("tracking · hands", true);
      setHudStatus("TRACKING ACTIVE");
    } catch (err) {
      handLandmarkerLoading = false;
      showError("Could not load hand tracker: " + (err.message || err));
      setStatus("", false);
      setHudStatus("MODEL ERROR");
      return false;
    }
    handLandmarkerLoading = false;
    return true;
  }

  // ────────────────────── Gesture detection ──────────────────────
  function fingerPtInRect(handLM, lmIdx, rect, W, H) {
    const p = handLM[lmIdx];
    const x = (1 - p.x) * W;
    const y = p.y * H;
    return (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      ? { x, y } : null;
  }

  function updateGesture(handsLM, W, H) {
    const regionEl = getRegionEl();
    const miniEl   = getMiniEl();
    if (!regionEl || !miniEl) {
      if (gesture.mode === "armed") endGesture();
      return false;
    }
    const regionRect = regionEl.getBoundingClientRect();
    const miniRect = miniEl.getBoundingClientRect();
    const miniPadded = {
      left:   miniRect.left - 8,
      right:  miniRect.right + 8,
      top:    miniRect.top - 24,
      bottom: miniRect.bottom + 24,
    };
    const meta = getMeta();
    const range = getRange();
    if (!meta || !range) return false;

    if (gesture.mode === "idle") {
      for (let hi = 0; hi < handsLM.length; hi++) {
        const lm = handsLM[hi];
        const thumbPt  = fingerPtInRect(lm, 4,  regionRect, W, H);
        const indexPt  = fingerPtInRect(lm, 8,  regionRect, W, H);
        const middlePt = fingerPtInRect(lm, 12, regionRect, W, H);

        let axis = null, ptA = null, ptB = null;
        if (thumbPt && indexPt)       { axis = "zoom"; ptA = thumbPt;  ptB = indexPt; }
        else if (indexPt && middlePt) { axis = "pan";  ptA = indexPt; ptB = middlePt; }

        if (axis) {
          gesture.framesIn++;
          if (gesture.framesIn >= 2) {
            gesture.mode      = "armed";
            gesture.axis      = axis;
            gesture.handIdx   = hi;
            gesture.startSpan = range.octaveSpan;
            gesture.startWhiteIdx = meta.allWhiteMidis.indexOf(range.startMidi);
            if (gesture.startWhiteIdx < 0) gesture.startWhiteIdx = 0;
            if (axis === "pan") {
              gesture.startMidX = (ptA.x + ptB.x) / 2;
            } else {
              gesture.startSpread = Math.max(8, Math.abs(ptB.x - ptA.x));
            }
            regionEl.classList.add("armed");
            miniEl.classList.add("armed");
            document.body.classList.add("gesture-active");
          }
          return gesture.mode === "armed";
        }
      }
      gesture.framesIn = 0;
      return false;
    }

    if (gesture.mode === "armed") {
      const handLM = handsLM[gesture.handIdx];
      if (!handLM) {
        gesture.framesOut++;
        if (gesture.framesOut > 6) endGesture();
        return true;
      }

      const thumbPt  = fingerPtInRect(handLM, 4,  miniPadded, W, H);
      const indexPt  = fingerPtInRect(handLM, 8,  miniPadded, W, H);
      const middlePt = fingerPtInRect(handLM, 12, miniPadded, W, H);
      const stillEngaged = gesture.axis === "zoom" ? (thumbPt && indexPt) : (indexPt && middlePt);

      if (!stillEngaged) {
        gesture.framesOut++;
        if (gesture.framesOut > 6) endGesture();
        return true;
      }
      gesture.framesOut = 0;

      const totalWhites = meta.allWhiteMidis.length;
      const whiteWMini  = miniRect.width / totalWhites;
      let newStartMidi  = range.startMidi;
      let targetSpan    = range.octaveSpan;

      if (gesture.axis === "pan") {
        const midX = (indexPt.x + middlePt.x) / 2;
        const dWhites = Math.round((midX - gesture.startMidX) / whiteWMini);
        const targetWhiteIdx = gesture.startWhiteIdx + dWhites;
        const maxWhiteIdx = (() => {
          for (let i = 0; i < meta.allWhiteMidis.length; i++) {
            if (meta.allWhiteMidis[i] + targetSpan * 12 > meta.pianoMaxMidi) return i - 1;
          }
          return meta.allWhiteMidis.length - 1;
        })();
        newStartMidi = meta.allWhiteMidis[Math.max(0, Math.min(maxWhiteIdx, targetWhiteIdx))];
      } else {
        const spread = Math.max(8, Math.abs(indexPt.x - thumbPt.x));
        const rawRatio = spread / gesture.startSpread;
        const ratio = 1 + (rawRatio - 1) * 0.4;
        targetSpan = Math.round(gesture.startSpan * 12 * ratio) / 12;
        targetSpan = Math.max(1, Math.min(4, targetSpan));
      }

      if (window.__airPianoSetRange) {
        const willChange = newStartMidi !== range.startMidi || targetSpan !== range.octaveSpan;
        if (willChange) {
          window.__airPianoSetRange({ startMidi: newStartMidi, octaveSpan: targetSpan });
        }
      }
      return true;
    }
    return false;
  }

  function endGesture() {
    if (gesture.mode === "idle") return;
    gesture.mode = "idle";
    gesture.handIdx = -1;
    gesture.framesIn = 0;
    gesture.framesOut = 0;
    gesture.axis = null;
    const regionEl = getRegionEl();
    const miniEl   = getMiniEl();
    if (regionEl) regionEl.classList.remove("armed");
    if (miniEl)   miniEl.classList.remove("armed");
    document.body.classList.remove("gesture-active");
    for (const [, state] of fingerState) {
      if (state.midi != null && window.__airPianoRelease) {
        window.__airPianoRelease(state.midi);
        state.midi = null;
        state.pressed = false;
      }
      state.baseline = 0;
    }
  }

  // ─────────────────────────── main results callback ───────────────────────────
  function onResults(results) {
    const W = window.innerWidth, H = window.innerHeight;
    octx.clearRect(0, 0, W, H);

    const seen = new Set();
    const handsLM = results.landmarks || [];

    // Live telemetry
    const latencyMs = Math.round(performance.now() - inferStartAt);
    const trackingEl = document.getElementById("trackingInfo");
    const signalEl   = document.getElementById("signalInfo");
    if (trackingEl) trackingEl.textContent = `tracking · hands · ${handsLM.length}`;
    if (signalEl)   signalEl.textContent   = `latency ${latencyMs}ms`;

    // FPS counter, updated once per second
    fpsFrameCount++;
    const nowFps = performance.now();
    if (nowFps - fpsLastAt >= 1000) {
      const fps = Math.round(fpsFrameCount * 1000 / (nowFps - fpsLastAt));
      fpsFrameCount = 0;
      fpsLastAt = nowFps;
      if (fpsEl) fpsEl.textContent = fps + " FPS";
    }

    const inGesture = updateGesture(handsLM, W, H);

    const engagedHandIdx = gesture.mode === "armed" ? gesture.handIdx : -1;
    let engagedFingerIds = new Set();
    if (engagedHandIdx >= 0) {
      const gestureLMs = gesture.axis === "zoom" ? [4, 8] : [8, 12];
      for (const lmIdx of gestureLMs) {
        engagedFingerIds.add(`${engagedHandIdx}_${lmIdx}`);
      }
    }

    handsLM.forEach((lm, hi) => {
      const wrist = lm[0];
      const midMcp = lm[9];
      const wx = (1 - wrist.x) * W, wy = wrist.y * H;
      const mx = (1 - midMcp.x) * W, my = midMcp.y * H;
      const handScale = Math.hypot(mx - wx, my - wy);
      // Logical hand index from wrist position (0 = left side = user's left hand, 1 = right)
      const logicalHand = wx < W / 2 ? 0 : 1;
      const prevHs = prevHandScale.get(hi);
      const scaleUnstable = prevHs != null && prevHs > 1 && Math.abs(handScale - prevHs) / prevHs > 0.30;
      prevHandScale.set(hi, handScale);

      // Draw skeleton
      octx.strokeStyle = aRgba(hi === engagedHandIdx ? 0.40 : 0.22);
      octx.lineWidth = hi === engagedHandIdx ? 1.4 : 1;
      const SKELETON = [
        [0,1,2,3,4], [0,5,6,7,8], [0,9,10,11,12],
        [0,13,14,15,16], [0,17,18,19,20], [5,9,13,17],
      ];
      for (const chain of SKELETON) {
        octx.beginPath();
        for (let i = 0; i < chain.length; i++) {
          const p = lm[chain[i]];
          const x = (1 - p.x) * W, y = p.y * H;
          if (i === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
        }
        octx.stroke();
      }

      // ── Pass 1: compute fs/fsDrop for all fingertips on this hand ──
      const fingerData = FINGERTIPS.map((idx, fi) => {
        const p = lm[idx];
        const mcp = lm[MCPS[fi]];
        const x = (1 - p.x) * W;
        const y = p.y * H;
        const mcpX = (1 - mcp.x) * W;
        const mcpY = mcp.y * H;
        const id = `${hi}_${idx}`;
        seen.add(id);

        const fs = handScale > 1 ? Math.hypot(x - mcpX, y - mcpY) / handScale : 0;

        let state = fingerState.get(id);
        if (!state) {
          // baseline=0: MIN_BASELINE_FS gate prevents presses for the first ~5 EMA frames
          // while baseline converges up from 0, fixing sticky-on-entry false triggers.
          state = { baseline: 0, pressed: false, midi: null, pressedAt: 0, trail: [] };
          fingerState.set(id, state);
        }
        state.trail.push({ x, y });
        if (state.trail.length > TRAIL_LEN) state.trail.shift();

        // Pure EMA (no Math.max floor) — eliminates the ratcheting bug where a momentary
        // spike would inflate baseline and freeze it, causing stuck notes.
        if (!state.pressed && !inGesture && !scaleUnstable) {
          state.baseline = state.baseline * BASELINE_DECAY + fs * (1 - BASELINE_DECAY);
        }

        const baseline = state.baseline;
        const fsDrop = baseline > MIN_BASELINE_FS ? (baseline - fs) / baseline : 0;
        const fingerName = FINGER_LBL[fi];
        const triggerThr = thresholdFor((logicalHand === 0 ? "lh_" : "rh_") + fingerName);

        const el = document.elementFromPoint(x, y);
        const keyEl = el && el.closest && el.closest("[data-midi]");
        const midi = keyEl ? parseInt(keyEl.getAttribute("data-midi"), 10) : null;

        return { idx, fi, x, y, id, fs, state, baseline, fsDrop, fingerName, triggerThr, midi };
      });

      // ── Sympathetic movement suppression ──
      const suppressed = new Set();
      const ADJACENT_PAIRS = [[0,1],[1,2],[2,3],[3,4]];
      for (const [a, b] of ADJACENT_PAIRS) {
        const fa = fingerData[a], fb = fingerData[b];
        const aTriggering = !fa.state.pressed && fa.fsDrop >= fa.triggerThr;
        const bTriggering = !fb.state.pressed && fb.fsDrop >= fb.triggerThr;
        if (aTriggering && bTriggering) {
          if (fa.fsDrop >= fb.fsDrop) {
            if (fb.fsDrop < fa.fsDrop * 0.70) suppressed.add(b);
          } else {
            if (fa.fsDrop < fb.fsDrop * 0.70) suppressed.add(a);
          }
        }
      }

      // ── Mass-trigger guard ──
      let wouldFire = 0;
      fingerData.forEach(({ state, fsDrop, triggerThr, midi, baseline }, di) => {
        if (!suppressed.has(di) && !state.pressed && midi != null && baseline > MIN_BASELINE_FS && fsDrop >= triggerThr) {
          wouldFire++;
        }
      });
      if (wouldFire >= 4) {
        fingerData.forEach(({ state, fsDrop, triggerThr }, di) => {
          if (!state.pressed && fsDrop >= triggerThr) suppressed.add(di);
        });
      }

      // ── Pass 2: state machine + draw ──
      fingerData.forEach(({ idx, fi, x, y, id, fs, state, baseline, fsDrop, fingerName, triggerThr, midi }, dataIdx) => {
        const releaseThr = triggerThr * RELEASE_FRAC;
        const depth = Math.max(0, Math.min(1, fsDrop / Math.max(0.01, triggerThr)));

        if (inGesture) {
          if (state.pressed) {
            if (window.__airPianoRelease && state.midi != null) window.__airPianoRelease(state.midi);
            state.pressed = false;
            state.midi = null;
          }
        } else if (!state.pressed) {
          if (!suppressed.has(dataIdx) && !scaleUnstable && midi != null && baseline > MIN_BASELINE_FS && fsDrop >= triggerThr) {
            state.pressed = true;
            state.midi = midi;
            state.pressedAt = performance.now();
            if (window.__airPianoPress) window.__airPianoPress(midi);
            window.dispatchEvent(new CustomEvent("airpiano:gesturepress", {
              detail: { midi, hand: logicalHand, fingerIdx: fi, fingerName },
            }));
          }
        } else {
          const recovered = fsDrop < releaseThr;
          const heldTooLong = performance.now() - state.pressedAt > MAX_HOLD_MS;
          if (recovered || heldTooLong) {
            if (window.__airPianoRelease) window.__airPianoRelease(state.midi);
            state.pressed = false;
            state.midi = null;
            if (heldTooLong) state.baseline = 0;
          }
        }

        debugRows.set(id, {
          hand: logicalHand, finger: fingerName, fingerIdx: fi, landmark: idx,
          fs, baseline, fsDrop, triggerThr,
          over: midi != null, midi, pressed: state.pressed,
          inGesture, engaged: engagedFingerIds.has(id),
        });

        // ───── draw fingertip ─────
        const pressing = state.pressed;
        const armed = !pressing && !inGesture && midi != null;
        const engaged = engagedFingerIds.has(id);
        const gestureMuted = inGesture && !engaged;

        if (state.trail.length > 2) {
          for (let ti = 1; ti < state.trail.length; ti++) {
            const a = state.trail[ti - 1], b = state.trail[ti];
            const k = ti / state.trail.length;
            const alpha = k * (pressing ? 0.55 : engaged ? 0.45 : gestureMuted ? 0.16 : 0.28);
            octx.strokeStyle = aRgba(alpha);
            octx.lineWidth = k * (pressing ? 4 : engaged ? 3.5 : 2.5);
            octx.lineCap = "round";
            octx.beginPath();
            octx.moveTo(a.x, a.y);
            octx.lineTo(b.x, b.y);
            octx.stroke();
          }
        }

        const baseRadius = (idx === 8 || idx === 12) ? 9 : 7;
        const radius = baseRadius + (pressing || armed ? depth * 5 : engaged ? 4 : 0);

        if (pressing) {
          const grad = octx.createRadialGradient(x, y, 0, x, y, 44);
          grad.addColorStop(0, gRgba(0.6));
          grad.addColorStop(1, gRgba(0));
          octx.fillStyle = grad;
          octx.beginPath();
          octx.arc(x, y, 44, 0, Math.PI * 2);
          octx.fill();
        } else if (engaged) {
          const grad = octx.createRadialGradient(x, y, 0, x, y, 38);
          grad.addColorStop(0, aRgba(0.55));
          grad.addColorStop(1, aRgba(0));
          octx.fillStyle = grad;
          octx.beginPath();
          octx.arc(x, y, 38, 0, Math.PI * 2);
          octx.fill();
        }

        octx.beginPath();
        octx.arc(x, y, radius, 0, Math.PI * 2);
        octx.fillStyle = pressing
          ? gRgba(0.95)
          : engaged
            ? aRgba(0.95)
            : armed
              ? aRgba(0.85)
              : gestureMuted
                ? aRgba(0.40)
                : "rgba(180,210,225,0.55)";
        octx.shadowColor = `rgb(${accentRGB[0]},${accentRGB[1]},${accentRGB[2]})`;
        octx.shadowBlur = pressing ? 26 : engaged ? 22 : armed ? 14 : gestureMuted ? 8 : 6;
        octx.fill();
        octx.shadowBlur = 0;

        octx.beginPath();
        octx.arc(x, y, radius + 4, 0, Math.PI * 2);
        octx.strokeStyle = pressing
          ? gRgba(0.7)
          : engaged
            ? aRgba(0.85)
            : armed
              ? aRgba(0.55)
              : gestureMuted
                ? aRgba(0.28)
                : "rgba(140,180,200,0.25)";
        octx.lineWidth = engaged ? 1.5 : 1;
        octx.stroke();
      });
    });

    // Connector line between engaged fingertips
    if (engagedHandIdx >= 0 && handsLM[engagedHandIdx]) {
      const lm = handsLM[engagedHandIdx];
      const engagedPts = [];
      for (let i = 0; i < FINGERTIPS.length; i++) {
        const id = `${engagedHandIdx}_${FINGERTIPS[i]}`;
        if (engagedFingerIds.has(id)) {
          const p = lm[FINGERTIPS[i]];
          engagedPts.push({ x: (1 - p.x) * W, y: p.y * H });
        }
      }
      if (engagedPts.length >= 2) {
        engagedPts.sort((a, b) => a.x - b.x);
        const a = engagedPts[0], b = engagedPts[engagedPts.length - 1];
        octx.save();
        octx.setLineDash([6, 5]);
        octx.strokeStyle = aRgba(0.85);
        octx.lineWidth = 2;
        octx.shadowColor = `rgb(${accentRGB[0]},${accentRGB[1]},${accentRGB[2]})`;
        octx.shadowBlur = 12;
        octx.beginPath();
        octx.moveTo(a.x, a.y);
        octx.lineTo(b.x, b.y);
        octx.stroke();
        octx.restore();
      }
    }

    // Release fingers that disappeared; clean up prevHandScale for absent hands.
    for (const [id, state] of fingerState) {
      if (!seen.has(id)) {
        if (state.midi != null && window.__airPianoRelease) window.__airPianoRelease(state.midi);
        fingerState.delete(id);
        debugRows.delete(id);
      }
    }
    prevHandScale.forEach((_, hi) => {
      if (hi >= handsLM.length) prevHandScale.delete(hi);
    });

    updateDetectionGlobal();

    if (handLandmarkerReady) {
      const n = handsLM.length;
      const gMsg = gesture.mode === "armed"
        ? "panning · zooming"
        : (n > 0 ? `tap to play · ${n} hand${n > 1 ? "s" : ""}` : "tap to play · no hands");
      setStatus(gMsg, true);
    }

    if (gesture.mode === "armed") {
      if (gesture.axis === "pan")  setMiniStatus("PANNING", true);
      else if (gesture.axis === "zoom") setMiniStatus("ZOOMING", true);
      else setMiniStatus("ACQUIRING", true);
    } else if (gesture.framesIn > 0) {
      setMiniStatus("ACQUIRING", true);
    } else {
      setMiniStatus("IDLE", false);
    }
  }

  // ────────────────────────── render loop ──────────────────────────
  function processLoop() {
    if (!processing) return;
    if (video.readyState >= 2 && handLandmarkerReady) {
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        inferStartAt = performance.now();
        try {
          const results = handLandmarker.detectForVideo(video, inferStartAt);
          onResults(results);
        } catch (_) {}
      }
    }
    if (processing) rafId = requestAnimationFrame(processLoop);
  }

  // ──────────────────────────── camera ────────────────────────────
  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("Camera API not available in this browser.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
      });
      video.srcObject = stream;
      video.classList.add("on");
      document.body.classList.add("cam-on");
      btn.classList.add("active");
      label.textContent = "Camera On";

      processing = true;
      await initHands();
      processLoop();
    } catch (err) {
      const name = err && err.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        showError("Camera permission denied.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        showError("No camera found.");
      } else {
        showError("Camera error: " + (err && err.message ? err.message : name || "unknown"));
      }
    }
  }

  function stop() {
    processing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    endGesture();
    releaseAllFingers();
    // handLandmarker intentionally NOT destroyed — persists for next start() call,
    // avoiding the 5-10s WASM re-download. Never call .close() (browser-freeze bug #5718).
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
    video.classList.remove("on");
    document.body.classList.remove("cam-on");
    btn.classList.remove("active");
    label.textContent = "Enable Camera";
    setStatus("", false);
    setHudStatus("SYSTEM ONLINE");
    if (fpsEl) fpsEl.textContent = "";
    const trackingEl = document.getElementById("trackingInfo");
    const signalEl   = document.getElementById("signalInfo");
    if (trackingEl) trackingEl.textContent = "";
    if (signalEl)   signalEl.textContent = "";
    setMiniStatus("IDLE", false);
  }

  btn.addEventListener("click", () => {
    if (stream) stop(); else start();
  });

  window.addEventListener("beforeunload", stop);

  // Auto-start camera on load so users immediately see it's a CV app
  start();
})();
