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
    openBtSettingsBtn: $('openBtSettingsBtn'),
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

    // Wake lock
    awake: $('awake'),
    awakeToggle: $('awakeToggle'),
    awakeStatus: $('awakeStatus'),
    awakeWarn: $('awakeWarn'),
    nosleepVideo: $('nosleepVideo'),

    // Mic source
    micSource: $('micSource'),
    micSourceSelect: $('micSourceSelect'),
    refreshMicsBtn: $('refreshMicsBtn'),
    activeMicStatus: $('activeMicStatus'),
    micSourceWarn: $('micSourceWarn'),

    // Transcript
    transcriptSection: $('transcriptSection'),
    transcriptStatus: $('transcriptStatus'),
    transcriptToggleBtn: $('transcriptToggleBtn'),
    transcriptClearBtn: $('transcriptClearBtn'),
    transcriptAutoscroll: $('transcriptAutoscroll'),
    transcriptOutput: $('transcriptOutput'),
    transcriptPlaceholder: $('transcriptPlaceholder'),

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
    setStepState(ui.stepPair, 'done', ui.pairStatus, 'Connected');
    updateContinueState();
  });

  // ---------- Open iOS Bluetooth Settings (best-effort) ----------
  // iOS deep-link schemes are unofficial and unreliable from web pages,
  // but we try common ones. We always show fallback copy in the UI.
  if (ui.openBtSettingsBtn) {
    ui.openBtSettingsBtn.addEventListener('click', () => {
      const ua = (navigator.userAgent || '').toLowerCase();
      const isIOS = /iphone|ipad|ipod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

      if (isIOS) {
        // Try the App-Prefs scheme first; some iOS versions ignore it.
        // Use a hidden iframe so failures don't navigate Safari away.
        const tryScheme = (url) => {
          try {
            const f = document.createElement('iframe');
            f.style.cssText = 'display:none;width:0;height:0;border:0;';
            f.src = url;
            document.body.appendChild(f);
            setTimeout(() => { try { f.remove(); } catch (_) {} }, 1500);
          } catch (_) { /* ignore */ }
        };
        tryScheme('App-Prefs:root=Bluetooth');
        setTimeout(() => tryScheme('prefs:root=Bluetooth'), 250);
      }

      // Visual nudge so the user knows what to do next.
      if (ui.pairStatus) ui.pairStatus.textContent = 'Check Settings, then tap \u201CHeadset is connected\u201D';
    });
  }

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
      // Now that we have permission, labels are available — populate the picker.
      refreshMicList().catch(() => {});
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

  // ---------- Live transcript (Web Speech API) ----------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const transcript = {
    rec: null,
    enabled: false,        // user wants it on
    listening: false,      // recognizer is currently active
    interimEl: null,       // span for current interim result
    autoRestart: true,     // restart on natural end while enabled
    supported: !!SpeechRecognitionCtor,
  };

  function setTranscriptStatus(text, state) {
    if (!ui.transcriptStatus) return;
    ui.transcriptStatus.textContent = text;
    if (state) ui.transcriptStatus.setAttribute('data-state', state);
    else ui.transcriptStatus.removeAttribute('data-state');
  }

  function setTranscriptToggleLabel() {
    if (!ui.transcriptToggleBtn) return;
    if (!transcript.supported) {
      ui.transcriptToggleBtn.textContent = 'Unavailable';
      ui.transcriptToggleBtn.disabled = true;
      ui.transcriptToggleBtn.setAttribute('aria-disabled', 'true');
      ui.transcriptToggleBtn.setAttribute('aria-pressed', 'false');
      return;
    }
    ui.transcriptToggleBtn.textContent = transcript.enabled ? 'Turn off' : 'Turn on';
    ui.transcriptToggleBtn.setAttribute('aria-pressed', transcript.enabled ? 'true' : 'false');
  }

  function clearTranscriptOutput() {
    if (!ui.transcriptOutput) return;
    ui.transcriptOutput.innerHTML = '';
    if (ui.transcriptPlaceholder) {
      ui.transcriptOutput.appendChild(ui.transcriptPlaceholder);
      ui.transcriptPlaceholder.hidden = false;
    }
    transcript.interimEl = null;
  }

  function hidePlaceholder() {
    if (ui.transcriptPlaceholder) {
      ui.transcriptPlaceholder.hidden = true;
      if (ui.transcriptPlaceholder.parentNode === ui.transcriptOutput) {
        ui.transcriptOutput.removeChild(ui.transcriptPlaceholder);
      }
    }
  }

  function appendFinal(text) {
    if (!text || !text.trim()) return;
    hidePlaceholder();
    const span = document.createElement('span');
    span.className = 'transcript__final';
    span.textContent = (ui.transcriptOutput.childElementCount > 0 && !transcript.interimEl ? ' ' : '') + text.trim() + ' ';
    if (transcript.interimEl && transcript.interimEl.parentNode === ui.transcriptOutput) {
      ui.transcriptOutput.insertBefore(span, transcript.interimEl);
    } else {
      ui.transcriptOutput.appendChild(span);
    }
    autoScrollTranscript();
  }

  function setInterim(text) {
    if (!ui.transcriptOutput) return;
    if (!text) {
      if (transcript.interimEl && transcript.interimEl.parentNode) {
        transcript.interimEl.parentNode.removeChild(transcript.interimEl);
      }
      transcript.interimEl = null;
      return;
    }
    hidePlaceholder();
    if (!transcript.interimEl) {
      transcript.interimEl = document.createElement('span');
      transcript.interimEl.className = 'transcript__interim';
      ui.transcriptOutput.appendChild(transcript.interimEl);
    }
    transcript.interimEl.textContent = text;
    autoScrollTranscript();
  }

  function autoScrollTranscript() {
    if (!ui.transcriptOutput || !ui.transcriptAutoscroll) return;
    if (!ui.transcriptAutoscroll.checked) return;
    ui.transcriptOutput.scrollTop = ui.transcriptOutput.scrollHeight;
  }

  function buildRecognition() {
    if (!SpeechRecognitionCtor) return null;
    const rec = new SpeechRecognitionCtor();
    try { rec.continuous = true; } catch (_) {}
    try { rec.interimResults = true; } catch (_) {}
    try { rec.lang = 'en-US'; } catch (_) {}

    rec.onstart = () => {
      transcript.listening = true;
      setTranscriptStatus('Listening', 'listening');
    };
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0] && result[0].transcript ? result[0].transcript : '';
        if (result.isFinal) {
          appendFinal(text);
        } else {
          interim += text;
        }
      }
      setInterim(interim);
    };
    rec.onerror = (event) => {
      const err = event && event.error ? event.error : 'unknown';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        transcript.enabled = false;
        transcript.autoRestart = false;
        setTranscriptStatus('Permission denied', 'error');
        setTranscriptToggleLabel();
      } else if (err === 'no-speech' || err === 'aborted') {
        // benign; will end naturally
      } else if (err === 'audio-capture') {
        setTranscriptStatus('No microphone', 'error');
      } else if (err === 'network') {
        setTranscriptStatus('Network error', 'error');
      } else {
        setTranscriptStatus('Error: ' + err, 'error');
      }
    };
    rec.onend = () => {
      transcript.listening = false;
      // Flush any lingering interim into the DOM as-is (don't promote to final).
      if (transcript.enabled && transcript.autoRestart) {
        // Continuous mode on iOS Safari often ends after a few seconds; restart.
        try { rec.start(); setTranscriptStatus('Listening', 'listening'); }
        catch (_) { setTranscriptStatus('On', 'on'); }
      } else {
        setTranscriptStatus('Off');
      }
    };
    return rec;
  }

  function startTranscript() {
    if (!transcript.supported) {
      setTranscriptStatus('Unsupported', 'unsupported');
      return;
    }
    if (!transcript.rec) transcript.rec = buildRecognition();
    if (!transcript.rec) return;
    transcript.enabled = true;
    transcript.autoRestart = true;
    setTranscriptToggleLabel();
    try {
      transcript.rec.start();
      setTranscriptStatus('Starting\u2026', 'listening');
    } catch (err) {
      // start() throws if already started — treat as "on"
      setTranscriptStatus('On', 'on');
    }
  }

  function stopTranscript() {
    transcript.enabled = false;
    transcript.autoRestart = false;
    setTranscriptToggleLabel();
    if (transcript.rec && transcript.listening) {
      try { transcript.rec.stop(); } catch (_) {}
    }
    setInterim('');
    setTranscriptStatus('Off');
  }

  if (ui.transcriptToggleBtn) {
    ui.transcriptToggleBtn.addEventListener('click', () => {
      if (!transcript.supported) return;
      if (transcript.enabled) stopTranscript();
      else startTranscript();
    });
  }
  if (ui.transcriptClearBtn) {
    ui.transcriptClearBtn.addEventListener('click', () => {
      clearTranscriptOutput();
    });
  }

  // Initial state for transcript UI
  if (!transcript.supported) {
    setTranscriptStatus('Unsupported', 'unsupported');
    if (ui.transcriptPlaceholder) {
      ui.transcriptPlaceholder.textContent = 'Live transcript is not available in this browser.';
    }
  } else {
    setTranscriptStatus('Off');
  }
  setTranscriptToggleLabel();

  // ---------- Screen wake lock ----------
  // Tries to keep the iPhone screen awake while listening so Safari
  // doesn't suspend and cut off audio. iOS 16.4+ Safari supports this.
  // We ALSO run a NoSleep-style silent looping <video> as a fallback for
  // older iOS, Low Power Mode, or when Wake Lock is silently released.
  const wake = {
    supported: !!(navigator.wakeLock && typeof navigator.wakeLock.request === 'function'),
    sentinel: null,
    enabled: true,        // user wants it on while listening
    deniedOnce: false,    // we tried and got rejected — show fallback
    videoActive: false,
  };

  // Tiny silent looping MP4 (h264 + aac) — public-domain payload from the
  // NoSleep.js project, embedded so we have no external dependency.
  // Source: https://github.com/richtr/NoSleep.js (Apache-2.0). The asset is a
  // 5-second muted clip in two formats; iOS Safari plays the MP4.
  const NOSLEEP_MP4 = 'data:video/mp4;base64,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';

  function setNoSleepVideoSrc() {
    if (!ui.nosleepVideo) return;
    if (ui.nosleepVideo.dataset.ready === '1') return;
    try {
      ui.nosleepVideo.src = NOSLEEP_MP4;
      ui.nosleepVideo.dataset.ready = '1';
    } catch (_) {}
  }

  function startNoSleepVideo() {
    if (!ui.nosleepVideo) return false;
    setNoSleepVideoSrc();
    try {
      ui.nosleepVideo.muted = true;
      ui.nosleepVideo.playsInline = true;
      ui.nosleepVideo.setAttribute('playsinline', '');
      ui.nosleepVideo.setAttribute('webkit-playsinline', '');
      const p = ui.nosleepVideo.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          wake.videoActive = true;
          // Defer the status update so the Wake Lock sentinel (if any)
          // has time to land first; we don't want to downgrade "On" to
          // "On (fallback)" when the real API is also working.
          setTimeout(() => {
            if (running && wake.enabled && !wake.sentinel) {
              setAwakeStatus('On (fallback)', 'on');
              showAwakeWarn(false);
            }
          }, 60);
        }).catch(() => { wake.videoActive = false; });
      } else {
        wake.videoActive = true;
      }
      return true;
    } catch (_) {
      wake.videoActive = false;
      return false;
    }
  }

  function stopNoSleepVideo() {
    if (!ui.nosleepVideo) return;
    try { ui.nosleepVideo.pause(); } catch (_) {}
    try { ui.nosleepVideo.removeAttribute('src'); ui.nosleepVideo.load(); } catch (_) {}
    ui.nosleepVideo.dataset.ready = '';
    wake.videoActive = false;
  }

  function setAwakeStatus(text, state) {
    if (!ui.awakeStatus) return;
    ui.awakeStatus.textContent = text;
    if (state) ui.awakeStatus.setAttribute('data-state', state);
    else ui.awakeStatus.removeAttribute('data-state');
  }

  function showAwakeWarn(show) {
    if (!ui.awakeWarn) return;
    ui.awakeWarn.hidden = !show;
  }

  async function acquireWakeLock() {
    if (!wake.enabled) {
      // Caller turned it off — stop both layers.
      stopNoSleepVideo();
      setAwakeStatus('Off');
      return false;
    }

    // Always start the NoSleep video fallback (cheap, always works on iOS
    // when called from a user gesture). It survives Wake Lock release.
    startNoSleepVideo();

    if (!wake.supported) {
      // Wake Lock API not present — rely on the video keep-awake.
      if (wake.videoActive) {
        setAwakeStatus('On (fallback)', 'on');
        showAwakeWarn(false);
      } else {
        setAwakeStatus('Not supported', 'unsupported');
        showAwakeWarn(true);
      }
      return wake.videoActive;
    }

    if (wake.sentinel) {
      setAwakeStatus('On', 'on');
      return true;
    }
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wake.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        // The browser may release for many reasons (tab hidden, low power).
        // Drop our handle; visibilitychange will try to reacquire if still listening.
        if (wake.sentinel === sentinel) wake.sentinel = null;
        if (running && wake.enabled) {
          // Sentinel released — fall back to the video keep-awake.
          setAwakeStatus(wake.videoActive ? 'On (fallback)' : 'Paused', wake.videoActive ? 'on' : 'paused');
        } else {
          setAwakeStatus('Off');
        }
      });
      setAwakeStatus('On', 'on');
      showAwakeWarn(false);
      return true;
    } catch (err) {
      console.warn('Wake lock request failed:', err);
      wake.deniedOnce = true;
      // Still rely on the video fallback if it took.
      if (wake.videoActive) {
        setAwakeStatus('On (fallback)', 'on');
        showAwakeWarn(false);
      } else {
        setAwakeStatus('Unavailable', 'error');
        showAwakeWarn(true);
      }
      return wake.videoActive;
    }
  }

  async function releaseWakeLock() {
    const s = wake.sentinel;
    wake.sentinel = null;
    if (s) {
      try { await s.release(); } catch (_) { /* ignore */ }
    }
    stopNoSleepVideo();
    setAwakeStatus('Off');
  }

  // Initial wake-lock UI state. Even without the Wake Lock API we still
  // expose the toggle, because the NoSleep video fallback works on iOS.
  if (!wake.supported) {
    if (ui.awake) ui.awake.setAttribute('data-state', 'fallback');
    setAwakeStatus('Off (fallback ready)', 'paused');
  } else {
    setAwakeStatus('Off');
  }

  if (ui.awakeToggle) {
    ui.awakeToggle.addEventListener('change', async () => {
      wake.enabled = !!ui.awakeToggle.checked;
      if (running && wake.enabled) {
        await acquireWakeLock();
      } else if (!wake.enabled) {
        await releaseWakeLock();
      }
      // If turned on but not listening, the lock will be acquired when Start is tapped.
      if (wake.enabled && !running) setAwakeStatus('Off');
    });
  }

  // Reacquire on visibility change if we should still be holding it.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (running && wake.enabled && !wake.sentinel) {
      await acquireWakeLock();
    }
  });

  // ---------- Microphone source picker ----------
  // We enumerate audioinput devices after permission is granted, present a
  // dropdown if there are multiple, and warn loudly if the active track looks
  // like a Bluetooth headset — a known iOS Safari limitation.
  const micPicker = {
    selectedId: '',          // chosen deviceId, '' = default
    devices: [],             // [{deviceId, label, kind, isHeadset, isPhoneMic}]
    populated: false,
  };

  const HEADSET_RE = /(airpods|beats|bluetooth|headset|hands?[- ]?free|wireless|bose|sony|jabra|earbuds?|earpods?|pixel buds|galaxy buds|sennheiser|hf\b|sco\b|bt\b)/i;
  const PHONE_MIC_RE = /(iphone|built[- ]?in|front|back|rear|top|bottom|integrated|internal|default|primary|microphone array|imac|macbook|mac mini|laptop|phone)/i;

  function classifyMic(label) {
    const l = (label || '').trim();
    return {
      isHeadset: !!l && HEADSET_RE.test(l),
      isPhoneMic: !!l && PHONE_MIC_RE.test(l),
    };
  }

  function setActiveMicStatus(text, state) {
    if (!ui.activeMicStatus) return;
    ui.activeMicStatus.textContent = text;
    if (state) ui.activeMicStatus.setAttribute('data-state', state);
    else ui.activeMicStatus.removeAttribute('data-state');
  }

  function showMicWarn(show) {
    if (!ui.micSourceWarn) return;
    ui.micSourceWarn.hidden = !show;
  }

  async function refreshMicList(opts) {
    opts = opts || {};
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    let devices = [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter((d) => d.kind === 'audioinput').map((d) => {
        const label = d.label || '';
        const cls = classifyMic(label);
        return {
          deviceId: d.deviceId || '',
          label: label || (d.deviceId ? ('Microphone ' + d.deviceId.slice(0, 4)) : 'Default microphone'),
          isHeadset: cls.isHeadset,
          isPhoneMic: cls.isPhoneMic,
        };
      });
    } catch (err) {
      console.warn('enumerateDevices failed:', err);
      return [];
    }

    micPicker.devices = devices;
    micPicker.populated = true;

    // Repopulate the <select>.
    const sel = ui.micSourceSelect;
    if (sel) {
      const previous = micPicker.selectedId;
      sel.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = devices.length ? 'Default microphone' : 'No microphones found';
      sel.appendChild(defaultOpt);
      for (const dev of devices) {
        if (!dev.deviceId) continue; // skip unlabelled "" deviceId duplicates
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        const tag = dev.isPhoneMic ? ' — phone' : (dev.isHeadset ? ' — headset' : '');
        opt.textContent = dev.label + tag;
        sel.appendChild(opt);
      }
      // Re-select the previously chosen device if still available.
      if (previous && devices.some((d) => d.deviceId === previous)) {
        sel.value = previous;
      } else {
        sel.value = '';
        micPicker.selectedId = '';
      }
      // Enable the dropdown only if the user has actual choice.
      const realCount = devices.filter((d) => d.deviceId).length;
      sel.disabled = realCount < 2;
    }

    // Update the active-mic status if we're not currently listening.
    if (!running) {
      if (!devices.length) {
        setActiveMicStatus('No microphone', 'warn');
      } else {
        // Try to surface the chosen-or-likely device.
        const chosen = micPicker.selectedId
          ? devices.find((d) => d.deviceId === micPicker.selectedId)
          : (devices.find((d) => d.isPhoneMic) || devices[0]);
        if (chosen) {
          setActiveMicStatus(chosen.label, chosen.isHeadset ? 'warn' : (chosen.isPhoneMic ? 'ok' : ''));
          showMicWarn(!!chosen.isHeadset);
        }
      }
    }
    return devices;
  }

  if (ui.micSourceSelect) {
    ui.micSourceSelect.addEventListener('change', async () => {
      micPicker.selectedId = ui.micSourceSelect.value || '';
      // Reflect the choice in the active-mic status while idle.
      if (!running) {
        const dev = micPicker.devices.find((d) => d.deviceId === micPicker.selectedId);
        if (dev) {
          setActiveMicStatus(dev.label, dev.isHeadset ? 'warn' : (dev.isPhoneMic ? 'ok' : ''));
          showMicWarn(!!dev.isHeadset);
        } else {
          setActiveMicStatus('Default microphone', '');
          showMicWarn(false);
        }
      } else {
        // Live-swap: restart the audio chain with the new deviceId.
        try { await restartWithSelectedMic(); } catch (_) {}
      }
    });
  }
  if (ui.refreshMicsBtn) {
    ui.refreshMicsBtn.addEventListener('click', () => refreshMicList({ user: true }));
  }

  async function restartWithSelectedMic() {
    if (!running) return;
    stop();
    await start();
  }

  function micConstraints() {
    const base = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (micPicker.selectedId) {
      base.deviceId = { exact: micPicker.selectedId };
    }
    return base;
  }

  function reportActiveMic(track) {
    if (!track) {
      setActiveMicStatus('—');
      showMicWarn(false);
      return;
    }
    const settings = (typeof track.getSettings === 'function') ? track.getSettings() : {};
    const label = track.label || '';
    const cls = classifyMic(label);
    setActiveMicStatus(label || 'Active microphone', cls.isHeadset ? 'warn' : (cls.isPhoneMic ? 'ok' : ''));
    showMicWarn(!!cls.isHeadset);
    // If the chosen deviceId did not match what we got, sync the dropdown.
    if (settings && settings.deviceId && ui.micSourceSelect) {
      const realId = settings.deviceId;
      if (micPicker.selectedId && realId !== micPicker.selectedId) {
        // iOS likely overrode our selection. Reflect reality.
        if (Array.from(ui.micSourceSelect.options).some((o) => o.value === realId)) {
          ui.micSourceSelect.value = realId;
          micPicker.selectedId = realId;
        }
      }
    }
  }

  // ---------- Audio engine ----------
  async function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Open in Safari on iPhone (HTTPS)', 'error');
      return;
    }
    setStatus(micPermissionGranted ? 'Starting…' : 'Asking for microphone…', '');
    try {
      // Always request a fresh stream when starting — the setup test stream was stopped.
      // Apply the user's selected deviceId if any.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(),
          video: false,
        });
      } catch (err) {
        // OverconstrainedError from a stale deviceId: clear it and retry default.
        const name = err && err.name ? err.name : '';
        if ((name === 'OverconstrainedError' || name === 'NotFoundError') && micPicker.selectedId) {
          console.warn('Selected mic unavailable, falling back to default:', err);
          micPicker.selectedId = '';
          if (ui.micSourceSelect) ui.micSourceSelect.value = '';
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
            video: false,
          });
        } else {
          throw err;
        }
      }
      micPermissionGranted = true;
    } catch (err) {
      micPermissionGranted = false;
      const name = err && err.name ? err.name : '';
      let msg = 'Microphone blocked';
      if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Permission denied — check Settings → Safari → Microphone';
      else if (name === 'NotFoundError') msg = 'No microphone found';
      else if (name === 'NotReadableError') msg = 'Microphone is in use by another app';
      else if (name === 'OverconstrainedError') msg = 'That microphone is unavailable — pick another';
      setStatus(msg, 'error');
      console.error(err);
      return;
    }

    // Surface the active mic and warn if it looks like a Bluetooth headset.
    const audioTrack = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
    reportActiveMic(audioTrack);
    // Refresh the device list now that labels are available (post-permission).
    refreshMicList().catch(() => {});

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

    // Auto-start transcript when listening begins, if supported and not already on.
    // Uses a *separate* SpeechRecognition session — does not touch our Web Audio stream.
    if (transcript.supported && !transcript.enabled) {
      startTranscript();
    }

    // Request a screen wake lock from this user-gesture call to keep the
    // iPhone awake while listening. Safe no-op if unsupported.
    if (wake.enabled) {
      acquireWakeLock();
    }

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

    // Release the screen wake lock when we stop listening.
    releaseWakeLock();

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
    // Clear the active-mic line; warning persists until the device list is
    // re-evaluated, then refreshMicList resets it.
    setActiveMicStatus('—');
    refreshMicList().catch(() => {});
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
  // Wake lock reacquire is handled in its own visibilitychange listener above.

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
          refreshMicList().catch(() => {});
        }
      }
    } catch (_) { /* permissions API not supported on iOS Safari — ignore */ }
    // Even without permission, attempt an enumerateDevices pass so the UI
    // can show "No microphone" or, on platforms that expose anonymous
    // entries, an initial count.
    refreshMicList().catch(() => {});
  })();

  // React to OS-level device hot-plug events (BT headset connect/disconnect).
  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    try {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        refreshMicList().catch(() => {});
      });
    } catch (_) {}
  }

  updateContinueState();
})();
