/* ClearTable — assistive listening prototype.
 * All audio is processed locally via Web Audio API. No recording, no uploads.
 *
 * Signal chain:
 *   getUserMedia → MediaStreamSource
 *     → high-pass → low-mid cut → presence peak → high-shelf → low-pass
 *     → DynamicsCompressor → noise-gate (sidechain analyser) → makeup gain
 *     → meter analyser → destination (monitor) + silent sink
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Map slider position 0..3 → preset key
  const CLARITY_VALUES = ['warm', 'balanced', 'bright', 'aggressive'];
  const CLARITY_LABELS = {
    warm: 'Warmer',
    balanced: 'Balanced',
    bright: 'Brighter',
    aggressive: 'Strong',
    bypass: 'Off',
  };

  // UI refs
  const ui = {
    // Setup
    screenSetup: $('screenSetup'),
    screenMain: $('screenMain'),
    continueBtn: $('continueBtn'),
    continueNote: $('continueNote'),
    skipSetupBtn: $('skipSetupBtn'),
    setupHelpBtn: $('setupHelpBtn'),
    backToSetupBtn: $('backToSetupBtn'),

    // Setup steps
    stepPair: $('setupStepPair'),
    stepMic: $('setupStepMic'),
    stepPlace: $('setupStepPlace'),
    pairConfirmBtn: $('pairConfirmBtn'),
    pairStatus: $('pairStatus'),
    checkMicBtn: $('checkMicBtn'),
    micStatus: $('micStatus'),
    micTroubleshoot: $('micTroubleshoot'),
    placeConfirmBtn: $('placeConfirmBtn'),
    placeStatus: $('placeStatus'),

    // Big button + status + meter
    toggle: $('toggle'),
    toggleLabel: $('toggleLabel'),
    status: $('status'),
    meter: $('meter'),
    clipWarn: $('clipWarn'),
    safetyWarn: $('safetyWarn'),
    latency: $('latency'),

    // Sliders
    gain: $('gain'),
    gainVal: $('gainVal'),
    gate: $('gate'),
    gateVal: $('gateVal'),
    clarity: $('clarity'),
    clarityVal: $('clarityVal'),
    preset: $('preset'),

    // Sheet
    infoBtn: $('infoBtn'),
    sheet: $('sheet'),
    sheetScrim: $('sheetScrim'),
    sheetClose: $('sheetClose'),

    // Reset
    resetBtn: $('resetBtn'),
  };

  // Audio state
  let audioCtx = null;
  let stream = null;
  let nodes = null;
  let rafId = null;
  let running = false;
  let gateRamp = 0;
  let clipCounter = 0;
  let clipTimer = 0;

  // Permission / setup state
  let micPermissionGranted = false;
  const setupState = { pair: false, mic: false, place: false };

  const DEFAULTS = { gain: 6, gate: -55, clarity: 1 /* balanced */ };

  const PRESETS = {
    balanced:   { presence: 4,  air: 1.5, lowCut: 110, highCut: 7500, comp: -22, ratio: 4 },
    bright:     { presence: 7,  air: 3,   lowCut: 130, highCut: 8500, comp: -24, ratio: 5 },
    warm:       { presence: 2,  air: -2,  lowCut: 110, highCut: 6500, comp: -22, ratio: 4 },
    aggressive: { presence: 6,  air: 2,   lowCut: 160, highCut: 7500, comp: -28, ratio: 8 },
    bypass:     { presence: 0,  air: 0,   lowCut: 20,  highCut: 20000, comp: 0,  ratio: 1 },
  };

  // ---------- Slider visual progress (CSS var) ----------
  function paintRange(el) {
    const min = Number(el.min), max = Number(el.max);
    const v = Number(el.value);
    const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
    el.style.setProperty('--val', pct + '%');
  }

  // ---------- Labels ----------
  function fmtDb(v, sign = false) {
    const n = Number(v);
    const s = sign && n > 0 ? '+' : '';
    return `${s}${n} dB`;
  }
  function updateGainLabel() {
    ui.gainVal.textContent = fmtDb(ui.gain.value, true);
    paintRange(ui.gain);
  }
  function updateGateLabel() {
    // Display as user-friendly label, plus dB
    const v = Number(ui.gate.value);
    let level = 'Medium';
    if (v <= -60) level = 'Low';
    else if (v >= -45) level = 'High';
    ui.gateVal.textContent = `${level}`;
    paintRange(ui.gate);
  }
  function clarityKey() {
    const idx = Math.max(0, Math.min(3, Number(ui.clarity.value)));
    return CLARITY_VALUES[idx];
  }
  function updateClarityLabel() {
    const key = clarityKey();
    ui.preset.value = key;
    ui.clarityVal.textContent = CLARITY_LABELS[key];
    paintRange(ui.clarity);
  }

  // ---------- Sliders ----------
  ui.gain.addEventListener('input', () => {
    updateGainLabel();
    if (nodes) applyMakeupGain();
  });
  ui.gate.addEventListener('input', updateGateLabel);
  ui.clarity.addEventListener('input', () => {
    updateClarityLabel();
    if (nodes) applyPreset();
  });

  // ---------- Big toggle ----------
  ui.toggle.addEventListener('click', async () => {
    if (running) stop();
    else await start();
  });

  // ---------- Reset ----------
  ui.resetBtn.addEventListener('click', () => {
    ui.gain.value = DEFAULTS.gain;
    ui.gate.value = DEFAULTS.gate;
    ui.clarity.value = DEFAULTS.clarity;
    updateGainLabel();
    updateGateLabel();
    updateClarityLabel();
    if (nodes) {
      applyPreset();
      applyMakeupGain();
    }
  });

  // ---------- Screens & sheet ----------
  function showMain() {
    ui.screenSetup.classList.remove('is-active');
    ui.screenSetup.hidden = true;
    ui.screenMain.classList.add('is-active');
    ui.screenMain.hidden = false;
    window.scrollTo(0, 0);
  }
  function showSetup() {
    if (running) stop();
    ui.screenMain.classList.remove('is-active');
    ui.screenMain.hidden = true;
    ui.screenSetup.classList.add('is-active');
    ui.screenSetup.hidden = false;
    window.scrollTo(0, 0);
  }

  ui.continueBtn.addEventListener('click', showMain);
  ui.skipSetupBtn.addEventListener('click', showMain);
  ui.backToSetupBtn.addEventListener('click', showSetup);

  // ---------- Setup step interactions ----------
  function setStepState(stepEl, state, statusEl, statusText) {
    if (stepEl) stepEl.setAttribute('data-state', state);
    if (statusEl && typeof statusText === 'string') statusEl.textContent = statusText;
  }

  function updateContinueState() {
    if (micPermissionGranted) {
      ui.continueBtn.classList.remove('is-secondary');
      ui.continueBtn.setAttribute('aria-disabled', 'false');
      ui.continueNote.textContent = setupState.pair && setupState.place
        ? "You're set. Tap to continue."
        : 'Microphone allowed. You can continue now.';
    } else {
      ui.continueBtn.classList.add('is-secondary');
      ui.continueBtn.setAttribute('aria-disabled', 'true');
      ui.continueNote.textContent = 'Allow the microphone above, or skip \u2014 Start Listening will ask again.';
    }
  }

  ui.pairConfirmBtn.addEventListener('click', () => {
    setupState.pair = true;
    setStepState(ui.stepPair, 'done', ui.pairStatus, 'Confirmed');
    updateContinueState();
  });

  ui.placeConfirmBtn.addEventListener('click', () => {
    setupState.place = true;
    setStepState(ui.stepPlace, 'done', ui.placeStatus, 'Confirmed');
    updateContinueState();
  });

  function showMicTroubleshoot(kind) {
    if (!ui.micTroubleshoot) return;
    if (kind === 'unsupported') {
      ui.micTroubleshoot.setAttribute('data-kind', 'unsupported');
      ui.micTroubleshoot.innerHTML =
        '<p class="step__trouble-title">Microphone API isn\u2019t available here</p>' +
        '<ul class="step__trouble-list">' +
          '<li>Open this page in <strong>Safari on iPhone</strong> over <strong>HTTPS</strong>.</li>' +
          '<li>If you tapped the link from inside another app (Messages, Mail, Slack), use the <strong>Share \u2192 Open in Safari</strong> action.</li>' +
          '<li>The microphone API requires a secure context \u2014 plain http:// won\u2019t work.</li>' +
        '</ul>';
    } else {
      ui.micTroubleshoot.setAttribute('data-kind', 'denied');
      ui.micTroubleshoot.innerHTML =
        '<p class="step__trouble-title">Trouble with the mic?</p>' +
        '<ul class="step__trouble-list">' +
          '<li>Open this page in <strong>Safari</strong> directly \u2014 not from inside an app\u2019s browser (e.g. Messages, Mail, Slack).</li>' +
          '<li>Make sure the URL is <strong>https://</strong>.</li>' +
          '<li>If you previously denied: <strong>Settings \u2192 Safari \u2192 Microphone</strong> (or <strong>Settings \u2192 Safari \u2192 Advanced \u2192 Website Data / Settings for Websites</strong>) and allow this site.</li>' +
          '<li>Disable <strong>Low Power Mode</strong> and close other apps that may be using the mic (calls, voice notes).</li>' +
          '<li>Then tap <em>Allow microphone</em> again.</li>' +
        '</ul>';
    }
    ui.micTroubleshoot.hidden = false;
  }

  function hideMicTroubleshoot() {
    if (ui.micTroubleshoot) ui.micTroubleshoot.hidden = true;
  }

  async function checkMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStepState(ui.stepMic, 'error', ui.micStatus, 'Not available in this browser');
      ui.checkMicBtn.textContent = 'Open in Safari on iPhone (HTTPS)';
      ui.checkMicBtn.setAttribute('aria-disabled', 'true');
      ui.checkMicBtn.disabled = true;
      showMicTroubleshoot('unsupported');
      return;
    }

    setStepState(ui.stepMic, 'checking', ui.micStatus, 'Asking for permission\u2026');
    ui.checkMicBtn.disabled = true;

    try {
      const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      testStream.getTracks().forEach((t) => t.stop());

      micPermissionGranted = true;
      setupState.mic = true;
      setStepState(ui.stepMic, 'done', ui.micStatus, 'Allowed');
      ui.checkMicBtn.textContent = 'Microphone allowed';
      hideMicTroubleshoot();
      updateContinueState();
    } catch (err) {
      console.warn('Mic permission failed:', err);
      micPermissionGranted = false;
      setupState.mic = false;
      const name = err && err.name ? err.name : '';
      let msg = 'Permission needed';
      if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Permission denied';
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') msg = 'No microphone found';
      else if (name === 'NotReadableError' || name === 'AbortError') msg = 'Microphone is busy';
      setStepState(ui.stepMic, 'error', ui.micStatus, msg);
      ui.checkMicBtn.textContent = 'Try again';
      ui.checkMicBtn.disabled = false;
      showMicTroubleshoot('denied');
      updateContinueState();
    }
  }

  ui.checkMicBtn.addEventListener('click', checkMic);

  function openSheet() {
    ui.sheet.hidden = false;
    ui.sheet.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    ui.sheet.hidden = true;
    ui.sheet.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
  ui.infoBtn.addEventListener('click', openSheet);
  ui.setupHelpBtn.addEventListener('click', openSheet);
  ui.sheetClose.addEventListener('click', closeSheet);
  ui.sheetScrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ui.sheet.hidden) closeSheet();
  });

  // Initial labels & slider paints
  updateGainLabel();
  updateGateLabel();
  updateClarityLabel();

  // ---------- Audio engine ----------
  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Open in Safari on iPhone (HTTPS)', 'error');
      return;
    }
    setStatus(micPermissionGranted ? 'Starting…' : 'Asking for microphone…', '');
    try {
      // Always request a fresh stream when starting — the setup test stream was stopped.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      micPermissionGranted = true;
    } catch (err) {
      micPermissionGranted = false;
      const name = err && err.name ? err.name : '';
      let msg = 'Microphone blocked';
      if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Permission denied — check Settings → Safari → Microphone';
      else if (name === 'NotFoundError') msg = 'No microphone found';
      else if (name === 'NotReadableError') msg = 'Microphone is in use by another app';
      setStatus(msg, 'error');
      console.error(err);
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (_) {}
    }

    const src = audioCtx.createMediaStreamSource(stream);

    const highPass = audioCtx.createBiquadFilter();
    highPass.type = 'highpass'; highPass.Q.value = 0.707;
    const lowMidCut = audioCtx.createBiquadFilter();
    lowMidCut.type = 'peaking'; lowMidCut.frequency.value = 280; lowMidCut.Q.value = 1.0; lowMidCut.gain.value = -3;
    const presence = audioCtx.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 2500; presence.Q.value = 1.1;
    const air = audioCtx.createBiquadFilter();
    air.type = 'highshelf'; air.frequency.value = 6500;
    const lowPass = audioCtx.createBiquadFilter();
    lowPass.type = 'lowpass'; lowPass.Q.value = 0.707;

    const comp = audioCtx.createDynamicsCompressor();
    comp.attack.value = 0.005;
    comp.release.value = 0.12;
    comp.knee.value = 18;

    const gate = audioCtx.createGain();
    gate.gain.value = 0;

    const sidechain = audioCtx.createAnalyser();
    sidechain.fftSize = 1024;
    sidechain.smoothingTimeConstant = 0.4;

    const makeup = audioCtx.createGain();
    makeup.gain.value = 1;

    const meter = audioCtx.createAnalyser();
    meter.fftSize = 1024;
    meter.smoothingTimeConstant = 0.6;

    const muteSink = audioCtx.createGain();
    muteSink.gain.value = 0;

    src.connect(highPass);
    highPass.connect(lowMidCut);
    lowMidCut.connect(presence);
    presence.connect(air);
    air.connect(lowPass);
    lowPass.connect(comp);
    comp.connect(sidechain);
    comp.connect(gate);
    gate.connect(makeup);
    makeup.connect(meter);
    meter.connect(audioCtx.destination); // monitor on by default
    meter.connect(muteSink);
    muteSink.connect(audioCtx.destination);

    nodes = { src, highPass, lowMidCut, presence, air, lowPass, comp, gate, sidechain, makeup, meter, muteSink };

    applyPreset();
    applyMakeupGain();

    running = true;
    ui.toggle.classList.add('is-live');
    ui.toggle.setAttribute('aria-pressed', 'true');
    ui.toggle.setAttribute('aria-label', 'Stop Listening');
    ui.toggleLabel.textContent = 'Stop';
    setStatus('Listening', 'live');

    if (typeof audioCtx.outputLatency === 'number' || typeof audioCtx.baseLatency === 'number') {
      const ms = Math.round(((audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0)) * 1000);
      ui.latency.textContent = `Engine latency: ${ms} ms`;
    } else {
      ui.latency.textContent = 'Engine latency: —';
    }

    runMeterLoop();
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    rafId = null;

    if (nodes) {
      try { Object.values(nodes).forEach((n) => n.disconnect && n.disconnect()); } catch (_) {}
      nodes = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }

    ui.toggle.classList.remove('is-live');
    ui.toggle.setAttribute('aria-pressed', 'false');
    ui.toggle.setAttribute('aria-label', 'Start Listening');
    ui.toggleLabel.textContent = 'Start Listening';
    setStatus('Tap to start', '');
    ui.meter.style.width = '0%';
    ui.clipWarn.hidden = true;
    ui.safetyWarn.hidden = true;
    ui.latency.textContent = 'Engine latency: —';
  }

  function applyPreset() {
    if (!nodes || !audioCtx) return;
    const key = clarityKey();
    const p = PRESETS[key] || PRESETS.balanced;
    const t = audioCtx.currentTime;
    const ramp = 0.05;

    nodes.highPass.frequency.linearRampToValueAtTime(p.lowCut, t + ramp);
    nodes.lowPass.frequency.linearRampToValueAtTime(p.highCut, t + ramp);
    nodes.presence.gain.linearRampToValueAtTime(p.presence, t + ramp);
    nodes.air.gain.linearRampToValueAtTime(p.air, t + ramp);
    nodes.lowMidCut.gain.linearRampToValueAtTime(p === PRESETS.bypass ? 0 : -3, t + ramp);

    nodes.comp.threshold.linearRampToValueAtTime(p.comp, t + ramp);
    nodes.comp.ratio.linearRampToValueAtTime(p.ratio, t + ramp);
  }

  function applyMakeupGain() {
    if (!nodes || !audioCtx) return;
    const db = Number(ui.gain.value);
    const lin = Math.pow(10, db / 20);
    nodes.makeup.gain.linearRampToValueAtTime(lin, audioCtx.currentTime + 0.05);
  }

  function setStatus(text, kind) {
    ui.status.textContent = text;
    ui.status.classList.remove('is-live', 'is-error');
    if (kind === 'live') ui.status.classList.add('is-live');
    if (kind === 'error') ui.status.classList.add('is-error');
  }

  // ---------- Meter + gate loop ----------
  function runMeterLoop() {
    const sideBuf = new Float32Array(nodes.sidechain.fftSize);
    const meterBuf = new Float32Array(nodes.meter.fftSize);

    const tick = () => {
      if (!running || !nodes) return;
      rafId = requestAnimationFrame(tick);

      nodes.sidechain.getFloatTimeDomainData(sideBuf);
      let sumSq = 0;
      for (let i = 0; i < sideBuf.length; i++) sumSq += sideBuf[i] * sideBuf[i];
      const rms = Math.sqrt(sumSq / sideBuf.length);
      const sideDb = rms > 0 ? 20 * Math.log10(rms) : -120;

      const threshold = Number(ui.gate.value);
      const target = sideDb > threshold ? 1 : 0;
      const coef = target > gateRamp ? 0.45 : 0.05;
      gateRamp += (target - gateRamp) * coef;
      const gateVal = clarityKey() === 'bypass' ? 1 : gateRamp;
      try { nodes.gate.gain.setTargetAtTime(gateVal, audioCtx.currentTime, 0.01); } catch (_) {}

      nodes.meter.getFloatTimeDomainData(meterBuf);
      let peak = 0;
      for (let i = 0; i < meterBuf.length; i++) {
        const v = Math.abs(meterBuf[i]);
        if (v > peak) peak = v;
      }
      const pct = Math.min(100, peak * 100);
      ui.meter.style.width = pct.toFixed(1) + '%';

      const now = performance.now();
      if (peak >= 0.98) {
        clipCounter++;
        clipTimer = now;
      }
      ui.clipWarn.hidden = !(clipCounter > 0 && now - clipTimer < 1500);
      if (now - clipTimer > 2000) clipCounter = 0;

      ui.safetyWarn.hidden = !(peak > 0.85 && Number(ui.gain.value) >= 12);
    };

    rafId = requestAnimationFrame(tick);
  }

  // ---------- Cleanup ----------
  window.addEventListener('beforeunload', () => { if (running) stop(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  });

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Microphone not supported', 'error');
    ui.toggle.disabled = true;
    if (ui.checkMicBtn) {
      setStepState(ui.stepMic, 'error', ui.micStatus, 'Not available in this browser');
      ui.checkMicBtn.textContent = 'Open in Safari on iPhone (HTTPS)';
      ui.checkMicBtn.disabled = true;
      ui.checkMicBtn.setAttribute('aria-disabled', 'true');
      showMicTroubleshoot('unsupported');
    }
  }

  // Surface existing permission silently for return visits — only if the
  // mic API is actually usable in this context.
  (async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: 'microphone' });
        if (status.state === 'granted') {
          micPermissionGranted = true;
          setupState.mic = true;
          setStepState(ui.stepMic, 'done', ui.micStatus, 'Already allowed');
          if (ui.checkMicBtn) ui.checkMicBtn.textContent = 'Microphone allowed';
          updateContinueState();
        }
      }
    } catch (_) { /* permissions API not supported on iOS Safari — ignore */ }
  })();

  updateContinueState();
})();
