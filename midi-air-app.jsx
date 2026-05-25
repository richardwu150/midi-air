// air-piano-app.jsx — React keyboard with dynamic range + mini 88-key range picker.
// Exposes:
//   window.__airPianoPress(midi), __airPianoRelease(midi)        — for gesture layer
//   window.__airPianoSetRange({startMidi, octaveSpan})            — pan/zoom updates
//   window.__airPianoGetRange()                                   — current state
//   window.__airPianoMeta = {                                     — published per render
//      whitesPerOctave: 7, allWhiteMidis: [...], miniMidiMin, miniMidiMax,
//   }

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─────────────────────────── Note math ───────────────────────────
const PITCH_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const WHITE_PCS = [0,2,4,5,7,9,11];
const BLACK_PCS = [1,3,6,8,10];
const isWhitePc = (pc) => WHITE_PCS.includes(pc);

function pc(m) { return ((m % 12) + 12) % 12; }
function octaveOf(m) { return Math.floor(m / 12) - 1; }
function nameOf(m) { return PITCH_NAMES[pc(m)] + octaveOf(m); }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// 88-key piano: A0 (MIDI 21) … C8 (MIDI 108)
const PIANO_MIN_MIDI = 21;
const PIANO_MAX_MIDI = 108;

// Precompute all 88-key whites and blacks
const ALL_WHITES_88 = []; // {midi, indexAll}
const ALL_BLACKS_88 = []; // {midi, leftWhiteIndex88}
{
  let wi = 0;
  for (let m = PIANO_MIN_MIDI; m <= PIANO_MAX_MIDI; m++) {
    const p = pc(m);
    if (BLACK_PCS.includes(p)) {
      ALL_BLACKS_88.push({ midi: m, leftWhiteIndex88: wi - 1 });
    } else {
      ALL_WHITES_88.push({ midi: m, indexAll: ALL_WHITES_88.length });
      wi = ALL_WHITES_88.length;
    }
  }
}
const ALL_WHITE_MIDIS = ALL_WHITES_88.map(w => w.midi);
function whiteIdxOf(midi) {
  // Index of `midi` in ALL_WHITES_88 if `midi` is white, else -1
  return ALL_WHITE_MIDIS.indexOf(midi);
}

function buildPlayableKeyboard(midiStart, midiEnd) {
  const whites = [];
  const blacks = [];
  let whiteIndex = 0;
  for (let m = midiStart; m <= midiEnd; m++) {
    const p = pc(m);
    if (BLACK_PCS.includes(p)) {
      blacks.push({ midi: m, name: PITCH_NAMES[p] + octaveOf(m), pc: p, octave: octaveOf(m), leftWhiteIndex: whiteIndex - 1 });
    } else {
      whites.push({ midi: m, name: PITCH_NAMES[p] + octaveOf(m), pc: p, octave: octaveOf(m), indexAll: whites.length });
      whiteIndex = whites.length;
    }
  }
  return { whites, blacks };
}

// ─────────────────────────── Voice definitions ───────────────────────────
const VOICE_DEFS = {
  epno: {
    label: "EPNO",
    params: { tine: { default: 0.65, min: 0, max: 1, label: "TINE" },
               reverb: { default: 0.25, min: 0, max: 1, label: "REVERB" } },
  },
  pad: {
    label: "PAD",
    params: { cutoff: { default: 0.50, min: 0, max: 1, label: "CUTOFF" },
               detune: { default: 0.35, min: 0, max: 1, label: "DETUNE" } },
  },
  lead: {
    label: "LEAD",
    params: { spread: { default: 0.50, min: 0, max: 1, label: "SPREAD" },
               edge:   { default: 0.40, min: 0, max: 1, label: "EDGE" } },
  },
  organ: {
    label: "ORG",
    params: { draw: { default: 0.70, min: 0, max: 1, label: "DRAW" },
               rate: { default: 1.50, min: 0.5, max: 8, label: "RATE" } },
  },
  bell: {
    label: "BELL",
    params: { shimmer: { default: 0.70, min: 0, max: 1, label: "SHIMMER" },
               decay:   { default: 0.50, min: 0, max: 1, label: "DECAY" } },
  },
  bass: {
    label: "BASS",
    params: { sub:   { default: 0.60, min: 0, max: 1, label: "SUB" },
               punch: { default: 0.40, min: 0, max: 1, label: "PUNCH" } },
  },
  pluk: {
    label: "PLUK",
    params: { decay: { default: 0.40, min: 0, max: 1, label: "DECAY" },
               tone:  { default: 0.50, min: 0, max: 1, label: "TONE" } },
  },
};

function defaultParams(voiceName) {
  const p = {};
  Object.entries(VOICE_DEFS[voiceName].params).forEach(([k, v]) => { p[k] = v.default; });
  return p;
}

// ─────────────────────────── Synth ───────────────────────────
function useSynth() {
  const ctxRef      = useRef(null);
  const masterRef   = useRef(null);
  const delayRef    = useRef(null);
  const wetRef      = useRef(null);
  const analyserRef = useRef(null);
  const activeRef   = useRef({});
  const voiceRef    = useRef("pad");
  const paramsRef   = useRef(defaultParams("pad"));

  const ensure = useCallback(() => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.18;
      const delay = ctx.createDelay();
      delay.delayTime.value = 0.22;
      const fb = ctx.createGain();
      fb.gain.value = 0.28;
      const wet = ctx.createGain();
      wet.gain.value = 0.20;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      delay.connect(fb).connect(delay);
      master.connect(delay).connect(wet).connect(ctx.destination);
      master.connect(analyser).connect(ctx.destination);
      ctxRef.current    = ctx;
      masterRef.current = master;
      delayRef.current  = delay;
      wetRef.current    = wet;
      analyserRef.current = analyser;
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
  }, []);

  function synthNote(ctx, dest, voice, midi, p) {
    const freq = midiToFreq(midi);
    const ac   = ctx.currentTime;

    if (voice === "epno") {
      const osc1 = ctx.createOscillator();
      osc1.type = "sine"; osc1.frequency.value = freq;
      const osc2 = ctx.createOscillator();
      osc2.type = "sine"; osc2.frequency.value = freq * 2;
      const tineG = ctx.createGain();
      tineG.gain.setValueAtTime(p.tine * 0.9, ac);
      tineG.gain.exponentialRampToValueAtTime(0.001, ac + 0.35);
      const envG = ctx.createGain();
      envG.gain.setValueAtTime(0, ac);
      envG.gain.linearRampToValueAtTime(0.85, ac + 0.008);
      envG.gain.exponentialRampToValueAtTime(0.50, ac + 0.20);
      osc1.connect(envG);
      osc2.connect(tineG).connect(envG);
      const revG = ctx.createGain(); revG.gain.value = p.reverb * 0.5;
      envG.connect(dest);
      envG.connect(revG).connect(wetRef.current);
      osc1.start(); osc2.start();
      return { oscs: [osc1, osc2], gain: envG };
    }

    if (voice === "pad") {
      const f1 = freq * (1 + p.detune * 0.008);
      const f2 = freq * (1 - p.detune * 0.008);
      const osc1 = ctx.createOscillator(); osc1.type = "sawtooth"; osc1.frequency.value = f1;
      const osc2 = ctx.createOscillator(); osc2.type = "sawtooth"; osc2.frequency.value = f2;
      const sub  = ctx.createOscillator(); sub.type  = "sine";     sub.frequency.value  = freq / 2;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 400 + p.cutoff * 3600;
      filt.Q.value = 1.8;
      const subG = ctx.createGain(); subG.gain.value = 0.28;
      const envG = ctx.createGain();
      envG.gain.setValueAtTime(0, ac);
      envG.gain.linearRampToValueAtTime(0.55, ac + 0.09 + p.cutoff * 0.08);
      envG.gain.exponentialRampToValueAtTime(0.38, ac + 0.55);
      osc1.connect(filt); osc2.connect(filt);
      filt.connect(envG);
      sub.connect(subG).connect(envG);
      envG.connect(dest);
      [osc1, osc2, sub].forEach(o => o.start());
      return { oscs: [osc1, osc2, sub], gain: envG };
    }

    if (voice === "lead") {
      const sp = p.spread * 0.007;
      const oscs = [-1, 0, 1].map(i => {
        const o = ctx.createOscillator();
        o.type = "sawtooth"; o.frequency.value = freq * (1 + i * sp);
        return o;
      });
      const ws = ctx.createWaveShaper();
      const n = 256, curve = new Float32Array(n);
      const drive = 1 + p.edge * 9;
      for (let i = 0; i < n; i++) {
        const x = (i * 2 / n) - 1;
        curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
      }
      ws.curve = curve;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass"; filt.frequency.value = 3200 - p.edge * 1800; filt.Q.value = 1.2;
      const envG = ctx.createGain();
      envG.gain.setValueAtTime(0, ac);
      envG.gain.linearRampToValueAtTime(0.52, ac + 0.010);
      envG.gain.exponentialRampToValueAtTime(0.36, ac + 0.22);
      oscs.forEach(o => o.connect(ws));
      ws.connect(filt).connect(envG).connect(dest);
      oscs.forEach(o => o.start());
      return { oscs, gain: envG };
    }

    if (voice === "organ") {
      const mults  = [1, 2, 3, 4, 6];
      const levels = [0.50, 0.35, p.draw * 0.35, p.draw * 0.22, p.draw * 0.10];
      const mixG = ctx.createGain(); mixG.gain.value = 0.55;
      const oscs = mults.map((m, i) => {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq * m;
        const g = ctx.createGain(); g.gain.value = levels[i];
        o.connect(g).connect(mixG); o.start(); return o;
      });
      const lfo = ctx.createOscillator(); lfo.frequency.value = p.rate;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.042;
      lfo.connect(lfoG).connect(mixG.gain); lfo.start();
      const envG = ctx.createGain(); envG.gain.value = 1;
      mixG.connect(envG).connect(dest);
      return { oscs: [...oscs, lfo], gain: envG };
    }

    if (voice === "bell") {
      const carrier = ctx.createOscillator(); carrier.type = "sine"; carrier.frequency.value = freq;
      const mod     = ctx.createOscillator(); mod.type = "sine";     mod.frequency.value = freq * 3.5;
      const modG = ctx.createGain();
      modG.gain.setValueAtTime(freq * p.shimmer * 7, ac);
      modG.gain.exponentialRampToValueAtTime(0.001, ac + 0.25 + p.decay * 1.8);
      mod.connect(modG).connect(carrier.frequency);
      const envG = ctx.createGain();
      envG.gain.setValueAtTime(0, ac);
      envG.gain.linearRampToValueAtTime(0.85, ac + 0.004);
      envG.gain.exponentialRampToValueAtTime(0.001, ac + 1.6 + p.decay * 3.5);
      carrier.connect(envG).connect(dest);
      mod.start(); carrier.start();
      return { oscs: [carrier, mod], gain: envG };
    }

    if (voice === "bass") {
      const sub = ctx.createOscillator(); sub.type = "sine";     sub.frequency.value = freq;
      const saw = ctx.createOscillator(); saw.type = "sawtooth"; saw.frequency.value = freq * 2;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass"; filt.frequency.value = 260 + p.punch * 380; filt.Q.value = 2.2;
      const subG = ctx.createGain(); subG.gain.value = p.sub;
      const sawG = ctx.createGain(); sawG.gain.value = (1 - p.sub) * 0.45;
      const envG = ctx.createGain();
      envG.gain.setValueAtTime(0, ac);
      envG.gain.linearRampToValueAtTime(0.92, ac + 0.003 + (1 - p.punch) * 0.025);
      sub.connect(subG).connect(filt);
      saw.connect(sawG).connect(filt);
      filt.connect(envG).connect(dest);
      sub.start(); saw.start();
      return { oscs: [sub, saw], gain: envG };
    }

    if (voice === "pluk") {
      const osc = ctx.createOscillator(); osc.type = "triangle"; osc.frequency.value = freq;
      const filt = ctx.createBiquadFilter();
      filt.type = "highpass"; filt.frequency.value = 60 + p.tone * 700;
      const intG = ctx.createGain();
      const decayT = 0.08 + (1 - p.decay) * 1.6;
      intG.gain.setValueAtTime(0.92, ac);
      intG.gain.exponentialRampToValueAtTime(0.001, ac + decayT);
      const envG = ctx.createGain(); envG.gain.value = 1;
      osc.connect(filt).connect(intG).connect(envG).connect(dest);
      osc.start();
      return { oscs: [osc], gain: envG };
    }

    return { oscs: [], gain: ctx.createGain() };
  }

  function releaseNote(ctx, entry) {
    const { oscs, gain, voice } = entry;
    const t = ctx.currentTime;
    if (voice === "organ" || voice === "bell" || voice === "pluk") {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      oscs.forEach(o => { try { o.stop(t + 0.08); } catch (_) {} });
    } else {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      const relTime = voice === "bass" ? 0.08 : voice === "lead" ? 0.28 : 0.38;
      gain.gain.exponentialRampToValueAtTime(0.0001, t + relTime);
      oscs.forEach(o => { try { o.stop(t + relTime + 0.05); } catch (_) {} });
    }
  }

  const noteOn = useCallback((midi) => {
    ensure();
    const ctx = ctxRef.current;
    if (activeRef.current[midi]) return;
    const result = synthNote(ctx, masterRef.current, voiceRef.current, midi, paramsRef.current);
    activeRef.current[midi] = { ...result, voice: voiceRef.current };
  }, [ensure]);

  const noteOff = useCallback((midi) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const entry = activeRef.current[midi];
    if (!entry) return;
    releaseNote(ctx, entry);
    delete activeRef.current[midi];
  }, []);

  const setVoice = useCallback((name) => {
    if (!VOICE_DEFS[name]) return;
    voiceRef.current = name;
    paramsRef.current = defaultParams(name);
  }, []);

  const setParam = useCallback((name, value) => {
    paramsRef.current[name] = value;
  }, []);

  return { noteOn, noteOff, setVoice, setParam, voiceRef, paramsRef, analyserRef };
}

// ─────────────────────────── SpectrumVisualizer ───────────────────────────
function SpectrumVisualizer({ analyserRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;

    const setSize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width  = rect.width  * dpr;
      canvas.height = rect.height * dpr;
    };
    setSize();
    window.addEventListener("resize", setSize);

    const ctx2d = canvas.getContext("2d");
    let raf;

    // Log-frequency band layout — 56 bars from 20Hz to 8kHz (centers musical pitch around mid-width)
    const F_MIN = 20, F_MAX = 8000;
    const N_BARS = 56;
    const peaks = new Float32Array(N_BARS); // 0..1
    const peakAge = new Float32Array(N_BARS);

    function readTheme() {
      // CSS variables live on body.theme-*, so read from body, not html
      const cs = getComputedStyle(document.body);
      const accent = cs.getPropertyValue("--accent-rgb").trim() || "109,241,255";
      const glow   = cs.getPropertyValue("--glow-rgb").trim()   || accent;
      return { accent, glow };
    }

    const draw = () => {
      raf = requestAnimationFrame(draw);
      try {
        const analyser = analyserRef.current;
        const W = canvas.width;
        const H = canvas.height;
        ctx2d.clearRect(0, 0, W, H);

        const { accent, glow } = readTheme();
        const sampleRate = analyser ? analyser.context.sampleRate : 44100;
        const fftSize = analyser ? analyser.fftSize : 2048;
        const binHz = sampleRate / fftSize;

        // Background hairlines: 25/50/75 horizontal grid
        ctx2d.fillStyle = `rgba(${accent}, 0.10)`;
        [0.25, 0.5, 0.75].forEach(p => ctx2d.fillRect(0, Math.round(H * (1 - p)) - 0.5, W, 1));
        // Baseline (always visible)
        ctx2d.fillStyle = `rgba(${accent}, 0.45)`;
        ctx2d.fillRect(0, H - 1, W, 1);

        // Frequency tick marks across log axis
        const fToX = (f) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
        ctx2d.fillStyle = `rgba(${accent}, 0.22)`;
        [50, 100, 250, 500, 1000, 2500, 5000].forEach(f => {
          const x = fToX(f);
          ctx2d.fillRect(x, H - 5, 1, 4);
        });

        // Idle scanning glint — slow sweep when no audio data
        const t = performance.now() / 1000;
        const idleX = (Math.sin(t * 0.6) * 0.5 + 0.5) * W;
        const idleW = Math.max(20, W * 0.12);
        const g = ctx2d.createLinearGradient(idleX - idleW, 0, idleX + idleW, 0);
        g.addColorStop(0, `rgba(${accent}, 0)`);
        g.addColorStop(0.5, `rgba(${accent}, 0.08)`);
        g.addColorStop(1, `rgba(${accent}, 0)`);
        ctx2d.fillStyle = g;
        ctx2d.fillRect(0, H - 2, W, 2);

        if (!analyser) return;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);

        const barW = W / N_BARS;
        const padW = Math.max(1, dpr); // 1-px gap between bars

        for (let i = 0; i < N_BARS; i++) {
          // Frequency range for this bar — log spaced
          const fLo = F_MIN * Math.pow(F_MAX / F_MIN, i / N_BARS);
          const fHi = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / N_BARS);
          const binLo = Math.max(0, Math.floor(fLo / binHz));
          const binHi = Math.min(data.length - 1, Math.ceil(fHi / binHz));
          // Average the bins covering this band (max if only one)
          let v = 0;
          for (let b = binLo; b <= binHi; b++) v = Math.max(v, data[b] / 255);
          // Mild boost in mid-range to keep musical content prominent
          const xPct = i / N_BARS;
          const tilt = 0.7 + 0.5 * Math.sin(Math.PI * xPct); // hump centered, max 1.2
          v = Math.min(1, v * tilt);

          // Peak hold
          if (v > peaks[i]) {
            peaks[i] = v;
            peakAge[i] = 0;
          } else {
            peakAge[i] += 1;
            if (peakAge[i] > 18) peaks[i] = Math.max(0, peaks[i] - 0.012);
          }

          const x0 = Math.floor(i * barW);
          const bw = Math.max(1, Math.floor(barW - padW));
          const bH = v * H * 0.95;
          const top = H - bH;

          // Segmented LED chunks — stacked rects with gaps
          const SEG_H = Math.max(2, Math.round(H * 0.10));
          const SEG_GAP = Math.max(1, Math.round(H * 0.04));
          let y = H - SEG_H;
          while (y > top - SEG_H && y > -SEG_H) {
            const segCenter = (H - y - SEG_H / 2) / H; // 0 at bottom, 1 at top
            const tt = Math.min(1, segCenter * 1.4);
            const col = tt > 0.55
              ? `rgba(${glow}, ${0.40 + v * 0.55})`
              : `rgba(${accent}, ${0.40 + v * 0.55})`;
            ctx2d.fillStyle = col;
            const segY = Math.max(top, y);
            ctx2d.fillRect(x0, segY, bw, SEG_H);
            y -= (SEG_H + SEG_GAP);
          }

          // Peak hold dash (2px)
          if (peaks[i] > 0.04) {
            const py = Math.max(0, H - peaks[i] * H * 0.95 - 1);
            ctx2d.fillStyle = `rgba(${glow}, 0.95)`;
            ctx2d.fillRect(x0, py, bw, 2);
          }

          // Bottom reflection — 30% height, subtle
          const refH = bH * 0.30;
          const grad = ctx2d.createLinearGradient(0, H, 0, H + refH);
          grad.addColorStop(0, `rgba(${accent}, ${0.18 * v})`);
          grad.addColorStop(1, `rgba(${accent}, 0)`);
          ctx2d.fillStyle = grad;
          ctx2d.fillRect(x0, H, bw, refH);
        }
      } catch (e) {
        // Swallow errors so the RAF loop keeps running
      }
    };

    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", setSize);
    };
  }, []);

  return (
    <div className="spectrum-thin">
      <canvas ref={canvasRef} />
    </div>
  );
}

// Pitch-class → hue shift, retained for future opt-in. Disabled by default —
// hue rotation drags the accent toward green (in red HUD) or pink (in cyan CMD),
// breaking palette discipline. Returns 0 so all played keys glow in the theme's color.
function hueShiftFor(midi) { return 0; }

// ─────────────────────────── MainKeyboard ───────────────────────────
function MainKeyboard({ WHITES, BLACKS, startMidi, isGlow, hovered, setHovered, pressed, press, release, mouseDown, extraStyle }) {
  const wn = WHITES.length;
  const blackWidthFrac = (1 / wn) * 0.60;
  // Scale height to maintain per-key aspect ratio: 22 whites (3 oct) is the reference at 28vh
  const heightVh = (28 * 22 / wn).toFixed(1);
  const keyboardStyle = { height: `clamp(180px, ${heightVh}vh, 420px)`, ...extraStyle };
  return (
    <div className="keyboard" style={keyboardStyle}>
      <span className="frame-bracket tl"></span>
      <span className="frame-bracket tr"></span>
      <span className="frame-bracket bl"></span>
      <span className="frame-bracket br"></span>
      <span className="tracking" id="trackingInfo"></span>
      <span className="signal" id="signalInfo"></span>

      <div className="whites">
        {WHITES.map((w, i) => {
          const glow = isGlow(w.midi);
          const hov = hovered[w.midi];
          const hue = glow ? hueShiftFor(w.midi) : 0;
          return (
            <div
              key={"w-" + i}
              data-midi={w.midi}
              className={"white" + (hov && !glow ? " hover" : "") + (glow ? " glow" : "")}
              style={glow ? { filter: `hue-rotate(${hue}deg)` } : undefined}
              onMouseEnter={() => {
                setHovered(h => ({ ...h, [w.midi]: true }));
                if (mouseDown.current) press(w.midi);
              }}
              onMouseLeave={() => {
                setHovered(h => { const n = { ...h }; delete n[w.midi]; return n; });
                if (pressed[w.midi]) release(w.midi);
              }}
              onMouseDown={(e) => { e.preventDefault(); press(w.midi); }}
              onMouseUp={() => { if (pressed[w.midi]) release(w.midi); }}
              onTouchStart={(e) => { e.preventDefault(); press(w.midi); }}
              onTouchEnd={(e) => { e.preventDefault(); release(w.midi); }}
            >
              <div className="label">{w.name}</div>
            </div>
          );
        })}
      </div>

      <div className="blacks">
        {BLACKS.map((b, i) => {
          const glow = isGlow(b.midi);
          const hov = hovered[b.midi];
          const total = wn;
          const center = ((b.leftWhiteIndex + 1) / total) * 100;
          const widthPct = blackWidthFrac * 100;
          const hue = glow ? hueShiftFor(b.midi) : 0;
          return (
            <div
              key={"b-" + i}
              data-midi={b.midi}
              className={"black" + (hov && !glow ? " hover" : "") + (glow ? " glow" : "")}
              style={{
                left: `calc(${center}% - ${widthPct / 2}%)`,
                width: `${widthPct}%`,
                ...(glow ? { filter: `hue-rotate(${hue}deg)` } : {}),
              }}
              onMouseEnter={() => {
                setHovered(h => ({ ...h, [b.midi]: true }));
                if (mouseDown.current) press(b.midi);
              }}
              onMouseLeave={() => {
                setHovered(h => { const n = { ...h }; delete n[b.midi]; return n; });
                if (pressed[b.midi]) release(b.midi);
              }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); press(b.midi); }}
              onMouseUp={(e) => { e.stopPropagation(); if (pressed[b.midi]) release(b.midi); }}
              onTouchStart={(e) => { e.preventDefault(); press(b.midi); }}
              onTouchEnd={(e) => { e.preventDefault(); release(b.midi); }}
            >
              <div className="blabel">{b.name}</div>
            </div>
          );
        })}
      </div>

      {/* Octave label markers under each C in the visible range */}
      {WHITES.filter(w => w.pc === 0).map((w) => {
        const center = ((w.indexAll + 0.5) / WHITES.length) * 100;
        return (
          <div key={"oct-" + w.midi}
               className={"octave-mark" + (w.midi === startMidi ? " bright" : "")}
               style={{ left: center + "%" }}>
            {w.name}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────── MiniPiano ───────────────────────────
// Full 88-key piano strip with a highlighted region for the current playable range.
// The region's <div> has class "mini-region" — the gesture layer queries its bounds.
function MiniPiano({ startMidi, octaveSpan, pressed, decay }) {
  const totalWhites = ALL_WHITES_88.length; // 52
  const startWi = whiteIdxOf(startMidi);
  const endMidi = startMidi + Math.round(octaveSpan * 12);
  // endMidi may land on a black note — find nearest white at or below for region right edge
  let endMidiWh = endMidi;
  while (endMidiWh > PIANO_MIN_MIDI && !isWhitePc(pc(endMidiWh))) endMidiWh--;
  const endWi = whiteIdxOf(endMidiWh);
  // Region covers whites [startWi .. endWi] inclusive
  const regionLeftPct = (startWi / totalWhites) * 100;
  const regionRightPct = ((endWi + 1) / totalWhites) * 100;
  const regionWidthPct = regionRightPct - regionLeftPct;

  // Map MIDI → glow state for the mini display (mirror currently-pressed keys as subtle bloom)
  const isGlow = (m) => pressed[m] || decay[m];

  // ── Mouse drag for pan/zoom ──
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  // Capture current range in a ref so mousemove handler always has fresh values
  const rangeRef = useRef({ startMidi, octaveSpan });
  rangeRef.current = { startMidi, octaveSpan };

  const EDGE_FRAC = 0.10;

  const onMouseDown = useCallback((e) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const { startMidi: sm, octaveSpan: os } = rangeRef.current;

    const swi = whiteIdxOf(sm);
    const em = sm + Math.round(os * 12);
    let emWh = em;
    while (emWh > PIANO_MIN_MIDI && !isWhitePc(pc(emWh))) emWh--;
    const ewi = whiteIdxOf(emWh);

    const regionL = swi / totalWhites;
    const regionR = (ewi + 1) / totalWhites;
    const regionW = regionR - regionL;

    let type;
    if (pct < regionL || pct > regionR) {
      type = "pan";
    } else {
      const rel = (pct - regionL) / regionW;
      if (rel < EDGE_FRAC) type = "zoom-left";
      else if (rel > 1 - EDGE_FRAC) type = "zoom-right";
      else type = "pan";
    }

    dragRef.current = { type, startX: e.clientX, startMidi: sm, startSpan: os, startWi: swi, endMidi: em };
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      const el = containerRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const dx = e.clientX - drag.startX;
      const dFrac = dx / rect.width;
      const OCT_SCALE = totalWhites / 7; // white keys per octave ≈ 7.43

      if (drag.type === "pan") {
        const dWi = Math.round(dFrac * totalWhites);
        const newWi = Math.max(0, Math.min(totalWhites - 1, drag.startWi + dWi));
        const newStart = ALL_WHITES_88[newWi].midi;
        window.__airPianoSetRange && window.__airPianoSetRange({ startMidi: newStart, octaveSpan: drag.startSpan });

      } else if (drag.type === "zoom-right") {
        const dOct = dFrac * OCT_SCALE;
        const newSpan = Math.max(1, Math.min(4, drag.startSpan + dOct));
        window.__airPianoSetRange && window.__airPianoSetRange({ startMidi: drag.startMidi, octaveSpan: newSpan });

      } else if (drag.type === "zoom-left") {
        // Left edge drags: shift startMidi left/right, keep right (endMidi) fixed
        const dWi = Math.round(dFrac * totalWhites);
        const newStartWi = Math.max(0, Math.min(totalWhites - 1, drag.startWi + dWi));
        const newStart = ALL_WHITES_88[newStartWi].midi;
        const newSpan = Math.max(1, Math.min(4, (drag.endMidi - newStart) / 12));
        window.__airPianoSetRange && window.__airPianoSetRange({ startMidi: newStart, octaveSpan: newSpan });
      }
    };

    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="mini-piano" data-mini-piano ref={containerRef} onMouseDown={onMouseDown}>
      <div className="mini-whites">
        {ALL_WHITES_88.map((w) => {
          const isC = pc(w.midi) === 0;
          const glow = isGlow(w.midi);
          return (
            <div
              key={"miniw-" + w.midi}
              className={"mini-white" + (isC ? " c-marker" : "") + (glow ? " glow" : "")}
              data-mini-midi={w.midi}
              style={glow ? {
                background: "linear-gradient(180deg, rgba(var(--glow-rgb),0.55), rgba(var(--accent-rgb),0.30))",
              } : undefined}
            ></div>
          );
        })}
      </div>
      <div className="mini-blacks">
        {ALL_BLACKS_88.map((b) => {
          // Center of black key sits at boundary between leftWhiteIndex88 and +1
          const center = ((b.leftWhiteIndex88 + 1) / totalWhites) * 100;
          const widthPct = (1 / totalWhites) * 100 * 0.58;
          const glow = isGlow(b.midi);
          return (
            <div
              key={"minib-" + b.midi}
              className={"mini-black" + (glow ? " glow" : "")}
              data-mini-midi={b.midi}
              style={{
                left: `calc(${center}% - ${widthPct / 2}%)`,
                width: `${widthPct}%`,
                ...(glow ? { background: "linear-gradient(180deg, rgba(var(--glow-rgb),0.70), rgba(var(--accent-rgb),0.45))", borderColor: "rgba(var(--glow-rgb), 0.95)" } : {}),
              }}
            ></div>
          );
        })}
      </div>
      <div
        className="mini-region"
        style={{ left: `${regionLeftPct}%`, width: `${regionWidthPct}%` }}
      ></div>
      {/* Hairline tick at each C; C labels on each octave, brightest on C4 */}
      {ALL_WHITES_88.filter(w => pc(w.midi) === 0).map((w) => {
        const left = ((w.indexAll + 0.5) / totalWhites) * 100;
        const isC4 = w.midi === 60;
        const oct  = octaveOf(w.midi);
        return (
          <div key={"tick-" + w.midi}
               className={"mini-octave-tick cN" + (isC4 ? " c4" : "")}
               data-label={"C" + oct}
               style={{ left: `${left}%` }}></div>
        );
      })}
    </div>
  );
}

const SENS_DEFAULTS = {
  lh_thumb: 0.70, lh_index: 0.15, lh_middle: 0.20, lh_ring: 0.35, lh_pinky: 0.50,
  rh_thumb: 0.70, rh_index: 0.15, rh_middle: 0.20, rh_ring: 0.35, rh_pinky: 0.50,
};
const FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"];

// ─────────────────────────── DetectionFlank ───────────────────────────
function DetectionFlank({ hand, sens, onSensChange, barsRef, peaksRef, sensOpen, onSensToggle }) {
  const prefix  = hand === 0 ? "lh" : "rh";
  // Logical thumb-out → pinky-out ordering, mirrored for right hand
  const fingers = hand === 0
    ? [{fi:4,lbl:"P"},{fi:3,lbl:"R"},{fi:2,lbl:"M"},{fi:1,lbl:"I"},{fi:0,lbl:"T"}]
    : [{fi:0,lbl:"T"},{fi:1,lbl:"I"},{fi:2,lbl:"M"},{fi:3,lbl:"R"},{fi:4,lbl:"P"}];

  return (
    <div className={"flank-wrap " + (hand === 0 ? "lh" : "rh")}>
      {/* Single shared header — left-aligned, regime invariant */}
      <div className="flank-head">
        <span>{hand === 0 ? "DETECTION · LH" : "DETECTION · RH"}</span>
        <span className="rule" />
      </div>

      <div className="flank-bars">
        {fingers.map(({ fi, lbl }) => {
          const barKey  = `${hand}_${fi}`;
          return (
            <div className="flank-col" key={barKey}>
              <div className="flank-bar" ref={el => { if (el) barsRef.current[barKey + "_bar"] = el; }} data-detbar={barKey}>
                <div className="fill" ref={el => { if (el) barsRef.current[barKey] = el; }} />
                <div className="thr" style={{ bottom: "calc(100% - 2px)" }} />
                <div className="peak" ref={el => { if (el) peaksRef.current[barKey] = el; }} />
              </div>
              <span className="flank-label">{lbl}</span>
            </div>
          );
        })}
      </div>

      {/* Sensitivity — collapsible. Default visible; chevron toggles. */}
      <div className="flank-head flank-head--toggle" onClick={onSensToggle} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSensToggle(); } }}
        aria-expanded={sensOpen} aria-label="Toggle sensitivity panel">
        <span className={"chev " + (sensOpen ? "open" : "closed")} aria-hidden="true"></span>
        <span>SENSITIVITY</span>
        <span className="rule" />
      </div>
      <div className={"flank-sliders " + (sensOpen ? "" : "collapsed")}>
        {fingers.map(({ fi, lbl }) => {
          const sensKey = `${prefix}_${FINGER_NAMES[fi]}`;
          const val = sens[sensKey] ?? 0.5;
          const pct = Math.max(0, Math.min(1, val)) * 100;
          return (
            <div className="flank-col" key={sensKey}>
              <div className="vslider">
                <div className="vslider-bg"></div>
                <div className="vslider-fill" style={{ height: pct + "%" }}></div>
                <div className="vslider-thumb" style={{ bottom: pct + "%" }}></div>
                <input type="range" min="0" max="1" step="0.01"
                  className="vslider-input"
                  value={val}
                  onChange={e => onSensChange(sensKey, parseFloat(e.target.value))}
                  tabIndex={sensOpen ? 0 : -1}
                  aria-label={`${prefix} ${FINGER_NAMES[fi]} sensitivity`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────── NowDisplay ───────────────────────────
function NowDisplay({ nowNote, noteActive, noteHistory }) {
  const TICK_WIDTHS = [22, 18, 14, 10, 7, 4];
  const OPACITIES   = [0.95, 0.65, 0.42, 0.26, 0.15, 0.08];
  return (
    <div className="now-wrap">
      <span className="now-label">NOW</span>
      <div className={"now-now" + (noteActive ? " active" : "")}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "32px", letterSpacing: "0.04em",
          minWidth: "62px", textAlign: "center",
          color: noteActive ? "#fff" : "var(--accent-soft)",
          textShadow: noteActive ? "0 0 22px rgba(var(--glow-rgb),0.95), 0 0 8px rgba(var(--glow-rgb),0.7)" : "none",
          transition: "color 80ms ease, text-shadow 80ms ease",
          fontVariantNumeric: "tabular-nums",
        }}>{nowNote}</span>
        <div className="corners">
          <span className="tl"></span>
          <span className="tr"></span>
          <span className="bl"></span>
          <span className="br"></span>
        </div>
      </div>
      <div style={{ width: "1px", height: "20px", background: "rgba(var(--accent-rgb),0.20)", flexShrink: 0 }} />
      <span className="now-label">RECENT</span>
      <div className="now-history">
        {noteHistory.map((n, i) => (
          <div className="now-history-item" key={i + "-" + n} style={{ opacity: OPACITIES[i] || 0.05 }}>
            <span>{n}</span>
            <div className="now-history-tick" style={{ width: (TICK_WIDTHS[i] || 3) + "px", opacity: OPACITIES[i] || 0.05 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── VoiceHUD ───────────────────────────
function VoiceHUD({ currentVoice, paramVals, onVoiceChange, onParamChange }) {
  const voiceDef = VOICE_DEFS[currentVoice];
  return (
    <div className="voice-strip">
      <div className="voice-pills">
        {Object.entries(VOICE_DEFS).map(([name, def]) => (
          <button key={name}
            className={"voice-pill" + (currentVoice === name ? " active" : "")}
            onClick={() => onVoiceChange(name)}>
            {def.label}
          </button>
        ))}
      </div>
      <span className="voice-sep" />
      {Object.entries(voiceDef.params).map(([pkey, def]) => {
        const val = paramVals[pkey] ?? def.default;
        const pct = (val - def.min) / (def.max - def.min);
        return (
          <div key={pkey} className="voice-param">
            <label>{def.label}</label>
            <input type="range" min={def.min} max={def.max} step={(def.max - def.min) / 100}
              value={val}
              onChange={e => onParamChange(pkey, parseFloat(e.target.value))}
              className="slider-h"
              style={{ width: "70px" }}
            />
            <span className="val">{pct.toFixed(2)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────── Component ───────────────────────────
function loadSavedRange() {
  try { return JSON.parse(localStorage.getItem("airPiano.range.v1") || "null"); } catch (_) { return null; }
}

function AirPiano() {
  const [startMidi, setStartMidi] = useState(() => {
    const saved = loadSavedRange();
    if (saved && Number.isInteger(saved.startMidi) && isWhitePc(pc(saved.startMidi))) return saved.startMidi;
    return 48; // C3
  });
  const [octaveSpan, setOctaveSpan] = useState(() => {
    const saved = loadSavedRange();
    if (saved && typeof saved.octaveSpan === "number" && saved.octaveSpan >= 1 && saved.octaveSpan <= 4) return saved.octaveSpan;
    return 2;
  });

  useEffect(() => {
    try {
      localStorage.setItem("airPiano.range.v1", JSON.stringify({ startMidi, octaveSpan }));
    } catch (_) {}
  }, [startMidi, octaveSpan]);

  const endMidi = startMidi + Math.round(octaveSpan * 12);
  const { whites: WHITES, blacks: BLACKS } = useMemo(
    () => buildPlayableKeyboard(startMidi, endMidi),
    [startMidi, endMidi]
  );

  const [hovered, setHovered] = useState({});
  const [pressed, setPressed] = useState({});
  const [decay, setDecay]     = useState({});
  const decayTimers = useRef({});
  const { noteOn, noteOff, setVoice, setParam, voiceRef, paramsRef, analyserRef } = useSynth();


  const press = useCallback((midi) => {
    setPressed(p => p[midi] ? p : { ...p, [midi]: true });
    if (decayTimers.current[midi]) {
      clearTimeout(decayTimers.current[midi]);
      delete decayTimers.current[midi];
      setDecay(d => { const n = { ...d }; delete n[midi]; return n; });
    }
    noteOn(midi);
    window.dispatchEvent(new CustomEvent("airpiano:noteon", { detail: { midi, note: nameOf(midi) } }));
  }, [noteOn]);

  const release = useCallback((midi) => {
    setPressed(p => {
      if (!p[midi]) return p;
      const n = { ...p }; delete n[midi]; return n;
    });
    setDecay(d => ({ ...d, [midi]: true }));
    decayTimers.current[midi] = setTimeout(() => {
      setDecay(d => { const n = { ...d }; delete n[midi]; return n; });
      delete decayTimers.current[midi];
    }, 320);
    noteOff(midi);
    window.dispatchEvent(new CustomEvent("airpiano:noteoff", { detail: { midi } }));
  }, [noteOff]);

  // Expose global hooks for the gesture layer
  useEffect(() => {
    window.__airPianoPress = (m) => press(m);
    window.__airPianoRelease = (m) => release(m);
    return () => {
      delete window.__airPianoPress;
      delete window.__airPianoRelease;
    };
  }, [press, release]);

  useEffect(() => {
    window.__airPianoSetRange = ({ startMidi: sm, octaveSpan: os }) => {
      const newSpan = (typeof os === "number" && os >= 1 && os <= 4) ? os : octaveSpan;
      if (Number.isInteger(sm) && isWhitePc(pc(sm))) {
        const maxStart = PIANO_MAX_MIDI - Math.round(newSpan * 12);
        const clampedSm = Math.max(PIANO_MIN_MIDI, Math.min(sm, maxStart));
        if (isWhitePc(pc(clampedSm))) setStartMidi(clampedSm);
      }
      if (typeof os === "number" && os >= 1 && os <= 4 && os !== octaveSpan) setOctaveSpan(os);
    };
    window.__airPianoGetRange = () => ({
      startMidi, octaveSpan, endMidi: startMidi + Math.round(octaveSpan * 12),
    });
    window.__airPianoMeta = {
      pianoMinMidi: PIANO_MIN_MIDI,
      pianoMaxMidi: PIANO_MAX_MIDI,
      allWhiteMidis: ALL_WHITE_MIDIS,
    };
    return () => {
      delete window.__airPianoSetRange;
      delete window.__airPianoGetRange;
      delete window.__airPianoMeta;
    };
  }, [startMidi, octaveSpan]);

  useEffect(() => {
    window.__airPianoSetVoice = (name) => setVoice(name);
    window.__airPianoSetParam = (name, value) => setParam(name, value);
    return () => {
      delete window.__airPianoSetVoice;
      delete window.__airPianoSetParam;
    };
  }, [setVoice, setParam]);


  // Release notes that fall outside the new range when range changes
  const prevRangeRef = useRef({ startMidi, endMidi });
  useEffect(() => {
    const prev = prevRangeRef.current;
    if (prev.startMidi !== startMidi || prev.endMidi !== endMidi) {
      Object.keys(pressed).forEach(m => {
        const mi = parseInt(m, 10);
        if (mi < startMidi || mi > endMidi) release(mi);
      });
      prevRangeRef.current = { startMidi, endMidi };
    }
  }, [startMidi, endMidi, pressed, release]);

  useEffect(() => () => {
    Object.values(decayTimers.current).forEach(clearTimeout);
  }, []);

  const isGlow = (m) => pressed[m] || decay[m];

  const mouseDown = useRef(false);
  useEffect(() => {
    const md = () => { mouseDown.current = true; };
    const mu = () => { mouseDown.current = false; };
    window.addEventListener("mousedown", md);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("mousedown", md);
      window.removeEventListener("mouseup", mu);
    };
  }, []);

  // ── Voice / params state ──
  const [currentVoice, setCurrentVoice] = useState("pad");
  const [paramVals, setParamVals] = useState(() => defaultParams("pad"));

  const handleVoice = useCallback((name) => {
    setCurrentVoice(name);
    setParamVals(defaultParams(name));
    setVoice(name);
  }, [setVoice]);

  const handleParam = useCallback((name, value) => {
    setParamVals(v => ({ ...v, [name]: value }));
    setParam(name, value);
  }, [setParam]);

  // ── Per-hand-per-finger sensitivity ──
  const [sens, setSens] = useState(() =>
    window.__airPianoGetSens ? window.__airPianoGetSens() : { ...SENS_DEFAULTS }
  );

  const handleSens = useCallback((key, value) => {
    setSens(s => ({ ...s, [key]: value }));
    if (window.__airPianoSetSens) window.__airPianoSetSens(key, value);
  }, []);

  // ── Sensitivity panel collapse state — persists across reload ──
  const [sensOpen, setSensOpen] = useState(() => {
    try {
      const raw = localStorage.getItem("airpiano:sensOpen");
      return raw === null ? true : raw === "1";
    } catch (_) { return true; }
  });
  const toggleSens = useCallback(() => {
    setSensOpen(open => {
      const next = !open;
      try { localStorage.setItem("airpiano:sensOpen", next ? "1" : "0"); } catch (_) {}
      return next;
    });
  }, []);

  // ── Detection bars RAF ──
  const barsRef    = useRef({});
  const peaksRef   = useRef({});
  const barState   = useRef({});  // { key: { value, peak, peakUpdate, seen } }  // value & peak in %
  const barsRafRef = useRef(null);
  useEffect(() => {
    // Enumerate every possible bar key once so idle-decay reaches every column.
    const ALL_KEYS = [];
    for (let h = 0; h < 2; h++) for (let f = 0; f < 5; f++) ALL_KEYS.push(`${h}_${f}`);
    ALL_KEYS.forEach(k => { barState.current[k] = { value: 0, peak: 0, peakUpdate: 0 }; });

    const tick = () => {
      const det = window.__airPianoDetection;
      const now = performance.now();

      // Mark all bars as unseen this frame
      ALL_KEYS.forEach(k => { barState.current[k].seen = false; });

      // Drive any bars with current detection rows
      if (det && det.rows) {
        for (const r of det.rows) {
          const key = `${r.hand}_${r.fingerIdx}`;
          const bs  = barState.current[key];
          if (!bs) continue;
          const ratio = Math.min(1.4, r.fsDrop / Math.max(0.01, r.triggerThr));
          const target = Math.min(100, ratio * 100);
          // Light smoothing on the way up so it feels alive but responsive
          bs.value = target;
          bs.seen = true;

          const bar = barsRef.current[key + "_bar"];
          if (bar) {
            const past = ratio >= 1;
            bar.classList.toggle("armed", past);
            if (past) {
              const overshoot = Math.min(0.95, (ratio - 1) * 1.5);
              bar.style.setProperty("--notch", (overshoot * 100) + "%");
            } else {
              bar.style.setProperty("--notch", "0%");
            }
          }

          // Peak hold tracking
          if (target > bs.peak || now - bs.peakUpdate > 600) {
            bs.peak = target;
            bs.peakUpdate = now;
          }
        }
      }

      // Decay everything (un-seen this frame) toward 0 + clear armed state
      const DECAY = 6; // % per frame
      ALL_KEYS.forEach(key => {
        const bs = barState.current[key];
        if (!bs.seen) {
          // Smooth decay to 0
          bs.value = Math.max(0, bs.value - DECAY);
          const bar = barsRef.current[key + "_bar"];
          if (bar) {
            bar.classList.remove("armed");
            bar.style.setProperty("--notch", "0%");
          }
          // Peak hold decays slower, only after a hold period
          if (now - bs.peakUpdate > 600) bs.peak = Math.max(0, bs.peak - 0.8);
        }

        // Paint
        const fill = barsRef.current[key];
        const peak = peaksRef.current[key];
        if (fill) fill.style.height = bs.value + "%";
        if (peak) {
          peak.style.bottom = bs.peak + "%";
          peak.style.opacity = bs.peak > 6 ? "1" : "0";
        }
      });

      barsRafRef.current = requestAnimationFrame(tick);
    };
    barsRafRef.current = requestAnimationFrame(tick);
    return () => { if (barsRafRef.current) cancelAnimationFrame(barsRafRef.current); };
  }, []);

  // ── Note display state ──
  const [nowNote, setNowNote]         = useState("—");
  const [noteActive, setNoteActive]   = useState(false);
  const [noteHistory, setNoteHistory] = useState([]);
  const clearTimerRef = useRef(null);

  useEffect(() => {
    const onOn = (e) => {
      const note = e.detail.note;
      setNowNote(note);
      setNoteActive(true);
      setNoteHistory(h => (h[0] === note ? h : [note, ...h].slice(0, 6)));
      clearTimeout(clearTimerRef.current);
    };
    const onOff = () => {
      clearTimerRef.current = setTimeout(() => setNoteActive(false), 320);
    };
    window.addEventListener("airpiano:noteon",  onOn);
    window.addEventListener("airpiano:noteoff", onOff);
    return () => {
      window.removeEventListener("airpiano:noteon",  onOn);
      window.removeEventListener("airpiano:noteoff", onOff);
      clearTimeout(clearTimerRef.current);
    };
  }, []);

  // ── Active-state choreography: keylight pan, mini-region heartbeat, grid pulse, beam emission ──
  useEffect(() => {
    const beamLayer = document.getElementById("beamLayer");
    const keylight  = document.getElementById("keylight");
    const gridPulse = document.getElementById("gridPulse");
    let gridFadeRaf = null;
    let gridAlpha = 0;

    function fadeGrid() {
      gridAlpha = Math.max(0, gridAlpha - 0.04);
      if (gridPulse) gridPulse.style.opacity = String(gridAlpha);
      if (gridAlpha > 0.01) gridFadeRaf = requestAnimationFrame(fadeGrid);
      else gridFadeRaf = null;
    }

    function findKeyEl(midi) {
      return document.querySelector(`[data-midi="${midi}"]`);
    }
    function findBarEl(hand, fingerIdx) {
      return document.querySelector(`[data-detbar="${hand}_${fingerIdx}"]`);
    }

    function onNoteOn(e) {
      const midi = e.detail.midi;
      const keyEl = findKeyEl(midi);
      if (!keyEl) return;

      // Keylight follows the average played note column
      const rect = keyEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const viewportCx = window.innerWidth / 2;
      const offset = (cx - viewportCx) * 0.55;
      if (keylight) keylight.style.setProperty("--keylight-x", offset.toFixed(0) + "px");

      // Mini-region heartbeat
      const region = document.querySelector(".mini-region");
      if (region) {
        region.classList.remove("beat");
        // Force reflow so animation can restart
        void region.offsetWidth;
        region.classList.add("beat");
      }

      // Grid pulse — global brightness blip; fades back over ~600ms via RAF
      if (gridPulse) {
        gridAlpha = Math.min(1, gridAlpha + 0.45);
        gridPulse.style.opacity = String(gridAlpha);
        if (!gridFadeRaf) gridFadeRaf = requestAnimationFrame(fadeGrid);
      }
    }

    function onGesturePress(e) {
      const { midi, hand, fingerIdx } = e.detail;
      const keyEl = findKeyEl(midi);
      const barEl = findBarEl(hand, fingerIdx);
      if (!keyEl || !barEl || !beamLayer) return;
      const kRect = keyEl.getBoundingClientRect();
      const bRect = barEl.getBoundingClientRect();
      const kTopY = kRect.top + 6;
      const bMidY = bRect.top + bRect.height * 0.5;
      // Beam: a thin div connecting (bar mid x, bar mid y) → (key mid x, key top)
      const x1 = bRect.left + bRect.width / 2;
      const y1 = bMidY;
      const x2 = kRect.left + kRect.width / 2;
      const y2 = kTopY;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx*dx + dy*dy);
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      const beam = document.createElement("div");
      beam.className = "beam";
      beam.style.left = x1 + "px";
      beam.style.top  = y1 + "px";
      beam.style.height = len + "px";
      beam.style.transformOrigin = "top center";
      beam.style.transform = `rotate(${angle - 90}deg)`;
      beamLayer.appendChild(beam);
      setTimeout(() => { try { beam.remove(); } catch(_) {} }, 360);
    }

    window.addEventListener("airpiano:noteon", onNoteOn);
    window.addEventListener("airpiano:gesturepress", onGesturePress);
    // Keylight returns to center on noteoff after a short hold
    let recenterTimer;
    function onNoteOff() {
      clearTimeout(recenterTimer);
      recenterTimer = setTimeout(() => {
        if (keylight) keylight.style.setProperty("--keylight-x", "0px");
      }, 800);
    }
    window.addEventListener("airpiano:noteoff", onNoteOff);

    return () => {
      window.removeEventListener("airpiano:noteon", onNoteOn);
      window.removeEventListener("airpiano:gesturepress", onGesturePress);
      window.removeEventListener("airpiano:noteoff", onNoteOff);
      clearTimeout(recenterTimer);
      if (gridFadeRaf) cancelAnimationFrame(gridFadeRaf);
    };
  }, []);

  // ── VoiceHUD portal target ──
  const [hudTarget] = useState(() => document.getElementById("hudVoiceTarget"));

  return (
    <React.Fragment>
      {hudTarget && ReactDOM.createPortal(
        <VoiceHUD currentVoice={currentVoice} paramVals={paramVals}
          onVoiceChange={handleVoice} onParamChange={handleParam} />,
        hudTarget
      )}

      <div style={{
        display: "flex",
        alignItems: "stretch",
        width: "min(1500px, 94vw)",
        gap: "28px",
        minHeight: "clamp(260px, 50vh, 480px)",
      }}>
        <DetectionFlank hand={0} sens={sens} onSensChange={handleSens} barsRef={barsRef} peaksRef={peaksRef} sensOpen={sensOpen} onSensToggle={toggleSens} />
        <div style={{
          flex: "1 1 0",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          minWidth: 0,
        }}>
          <MainKeyboard
            WHITES={WHITES} BLACKS={BLACKS} startMidi={startMidi}
            isGlow={isGlow} hovered={hovered} setHovered={setHovered}
            pressed={pressed} press={press} release={release}
            mouseDown={mouseDown}
            extraStyle={{ width: "100%" }}
          />
          <SpectrumVisualizer analyserRef={analyserRef} />
        </div>
        <DetectionFlank hand={1} sens={sens} onSensChange={handleSens} barsRef={barsRef} peaksRef={peaksRef} sensOpen={sensOpen} onSensToggle={toggleSens} />
      </div>

      <div className="mini-piano-wrap">
        <MiniPiano startMidi={startMidi} octaveSpan={octaveSpan} pressed={pressed} decay={decay} />
        <div className="mini-meta">
          <span className="group">
            <span>RANGE</span>
            <span className="val">{nameOf(startMidi)} – {nameOf(endMidi)}</span>
            <span>OCT</span>
            <span className="val">{octaveSpan.toFixed(1)}</span>
          </span>
          <span className="hint" id="miniStatus">IDLE</span>
          <span className="group">
            <span>KEYS</span>
            <span className="val">{WHITES.length + BLACKS.length}</span>
          </span>
        </div>
      </div>

      <NowDisplay nowNote={nowNote} noteActive={noteActive} noteHistory={noteHistory} />
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<AirPiano />);
