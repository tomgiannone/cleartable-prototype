/* ClearTable — assistive listening prototype (v5).
 * All audio is processed locally via Web Audio API. No recording, no uploads.
 *
 * v5 signal chain:
 *   getUserMedia → MediaStreamSource
 *     → high-pass → low-mid cut → second low-mid → presence peak → high-shelf → low-pass
 *     → DynamicsCompressor (clarity preset)
 *     → smooth downward expander  ← replaces the old binary noise gate
 *     → AGC ("Auto level voices") with limiter target
 *     → self-voice duck            ← "Reduce my voice" (best-effort)
 *     → makeup gain → soft limiter → meter analyser
 *     → destination + silent sink
 *
 * Choppiness fix: the old gate snapped between mute and unity. v5 uses
 * setTargetAtTime on a smoothed gain stage with hysteresis (open at
 * threshold+4 dB, close at threshold-4 dB) and a noise floor of -18 dB
 * instead of -∞ dB, so silence is reduced, not killed.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Map slider position 0..4 → preset key. "Restaurant" is the default and
  // sits in the middle as the recommended choice for noisy rooms.
  const CLARITY_VALUES = ['warm', 'balanced', 'restaurant', 'bright', 'aggressive'];
  const CLARITY_LABELS = {
    warm: 'Warmer',
    balanced: 'Balanced',
    restaurant: 'Restaurant',
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

    // Quick row: echo reduction + calibrate (calibrate moved to Advanced)
    echoReductionToggle: $('echoReductionToggle'),
    calibrateBtn: $('calibrateBtn'),
    calibrationStatus: $('calibrationStatus'),

    // v5 — Auto level voices (AGC + limiter)
    autoLevelToggle: $('autoLevelToggle'),
    autoLevelStrength: $('autoLevelStrength'),
    autoLevelStatus: $('autoLevelStatus'),

    // v5 — Reduce my voice (best-effort self-voice ducking)
    selfVoiceToggle: $('selfVoiceToggle'),
    selfVoiceStrength: $('selfVoiceStrength'),
    selfVoiceStrengthVal: $('selfVoiceStrengthVal'),
    selfVoiceStatus: $('selfVoiceStatus'),
    trainSelfVoiceBtn: $('trainSelfVoiceBtn'),
    selfVoiceControl: document.querySelector('[data-testid="control-self-voice"]'),
    selfVoiceProgress: $('selfVoiceProgress'),
    selfVoicePrompt: $('selfVoicePrompt'),

    // v5 — Background-audio note
    backgroundAudioWarn: $('backgroundAudioWarn'),

    // Auto-Lock shortcuts
    awakeOpenAutoLockBtn: $('awakeOpenAutoLockBtn'),
    helpOpenAutoLockBtn: $('helpOpenAutoLockBtn'),

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
    transcriptRestartBtn: $('transcriptRestartBtn'),
    transcriptClearBtn: $('transcriptClearBtn'),
    transcriptAutoscroll: $('transcriptAutoscroll'),
    transcriptOutput: $('transcriptOutput'),
    transcriptPlaceholder: $('transcriptPlaceholder'),
    transcriptHint: $('transcriptHint'),

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

  // Default tuning targets a noisy restaurant room. v5 reduces choppiness:
  // the binary gate is gone, replaced by a downward expander with hysteresis
  // and slow release. Auto-level voices is ON by default with Medium strength.
  const DEFAULTS = {
    gain: 4,
    gate: -50,
    clarity: 2 /* restaurant */,
    echoReduction: true,
    autoLevel: true,
    autoLevelStrength: 3,    // 0=off,1=light,2=medium,3=strong (v6 default)
    selfVoiceOn: false,
    selfVoiceStrength: 3,    // v6: default Strong duck depth
  };
  // Strength labels are paired with target loudness, max boost, and limiter
  // headroom in the meter loop. v6 default is "Strong" — restaurant testing
  // showed Medium was not aggressive enough to even out near vs. far talkers.
  const STRENGTH_LABELS = ['Off', 'Light', 'Medium', 'Strong'];
  const SELF_VOICE_STRENGTH_LABELS = ['Off', 'Light', 'Medium', 'Strong'];

  // Each preset describes a five-band EQ + dynamics settings:
  //   presence: 1.5–3 kHz peak gain (consonant intelligibility)
  //   air:      6.5 kHz high-shelf gain (‘sparkle’)
  //   lowCut:   high-pass corner (rumble + plosive control)
  //   lowMid:   ~280 Hz peaking gain (mud / boxiness control)
  //   highCut:  low-pass corner (plate-clatter / harshness)
  //   comp/ratio/knee/release: DynamicsCompressor
  //   gateThreshold: starting suggestion for the noise gate (dB)
  //
  // Restaurant is intentionally tighter than Balanced: the lowMid is more
  // negative to peel out room boom, the highCut is lower to tame plate
  // clatter, the air is reduced to avoid harshness, and the compressor
  // uses a softer knee + slower release so it pumps less under chatter.
  const PRESETS = {
    warm:       { presence: 2,    air: -2,   lowCut: 110, lowMid: -3, highCut: 6500, comp: -22, ratio: 4, knee: 18, release: 0.12, gateThreshold: -55 },
    balanced:   { presence: 4,    air: 1.5,  lowCut: 110, lowMid: -3, highCut: 7500, comp: -22, ratio: 4, knee: 18, release: 0.12, gateThreshold: -55 },
    restaurant: { presence: 4.5,  air: -1,   lowCut: 150, lowMid: -5, highCut: 6800, comp: -26, ratio: 3.2, knee: 24, release: 0.20, gateThreshold: -48 },
    bright:     { presence: 7,    air: 3,    lowCut: 130, lowMid: -3, highCut: 8500, comp: -24, ratio: 5, knee: 18, release: 0.12, gateThreshold: -55 },
    aggressive: { presence: 6,    air: 2,    lowCut: 160, lowMid: -4, highCut: 7500, comp: -28, ratio: 8, knee: 14, release: 0.10, gateThreshold: -45 },
    bypass:     { presence: 0,    air: 0,    lowCut: 20,  lowMid: 0,  highCut: 20000, comp: 0,  ratio: 1, knee: 0,  release: 0.25, gateThreshold: -80 },
  };

  // Echo / room reduction adds an extra mid-cut + tighter highpass + a
  // touch more presence dip to reduce reverberant tail. We toggle it by
  // adjusting nodes.lowMidCut2 (a second peaking band around 500 Hz) and
  // by sliding the highpass corner up by ~30 Hz when ON.
  let echoReductionOn = true;

  // v6 — Auto level (smoothed AGC) state
  let autoLevelOn = true;
  let autoLevelStrength = 3;
  // Two envelopes: a fast one for peak/loud detection (~50 ms), and a slow
  // one for the average voice level the AGC chases (~500 ms). The slow one
  // is what makes restaurant leveling feel like a steady listening level
  // instead of pumping every syllable.
  let envFast = 0;
  let envSlow = 0;
  // Backwards-compat alias used by older code paths (calibrate, etc.)
  let envSmooth = 0;
  // Smoothed downward-expander gain (0..1) — replaces hard gate.
  let expanderGain = 1;
  // Smoothed AGC gain (linear). 1 = no change.
  let agcGain = 1;
  // Smoothed self-voice ducking gain (1 = no duck, e.g. 0.4 = ~ -8 dB).
  let selfVoiceDuck = 1;

  // v5 — Self voice profile (kept in-memory only, never persisted/uploaded).
  // We capture: mean RMS (linear), peak RMS, mean spectral centroid (Hz)
  // during a ~3-second training phrase. These broad features let us guess
  // when very-loud near-mic speech matches the user. Honest limit: this is
  // not voiceprint speaker separation and will sometimes false-trip.
  const selfVoice = {
    on: false,
    strength: 3,
    trained: false,
    profile: null, // { rmsMean, rmsPeak, centroidMean, centroidStd }
    training: false,
    cancelRequested: false,
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
    // v5: this is a smooth downward-expander threshold, not a hard gate.
    // Lower (more negative) values = more reduction below the threshold.
    const v = Number(ui.gate.value);
    let level = 'Medium';
    if (v <= -65) level = 'Low';
    else if (v <= -55) level = 'Medium';
    else if (v <= -42) level = 'High';
    else if (v <= -30) level = 'Very High';
    else level = 'Max';
    ui.gateVal.textContent = level;
    paintRange(ui.gate);
  }

  // ---------- Auto-level + self-voice UI labels ----------
  function updateAutoLevelLabel() {
    if (!ui.autoLevelStatus || !ui.autoLevelToggle) return;
    const on = !!ui.autoLevelToggle.checked;
    autoLevelOn = on;
    autoLevelStrength = ui.autoLevelStrength ? Number(ui.autoLevelStrength.value) : 2;
    if (ui.autoLevelStrength) paintRange(ui.autoLevelStrength);
    if (!on) {
      ui.autoLevelStatus.textContent = 'Off';
      ui.autoLevelStatus.setAttribute('data-state', 'off');
      if (ui.autoLevelStrength) ui.autoLevelStrength.disabled = true;
      if (typeof applyLevelerStrength === 'function') applyLevelerStrength();
      return;
    }
    if (ui.autoLevelStrength) ui.autoLevelStrength.disabled = false;
    ui.autoLevelStatus.textContent = 'On \u00b7 ' + (STRENGTH_LABELS[autoLevelStrength] || 'Strong');
    ui.autoLevelStatus.setAttribute('data-state', 'active');
    if (typeof applyLevelerStrength === 'function') applyLevelerStrength();
  }

  // Update the "Reduce my voice" status pill + toggle wiring. Honest states:
  //   Not trained  → toggle disabled (no profile yet)
  //   Training\u2026     → toggle disabled (capture in progress)
  //   Active       → trained + on; ducking applies when self-voice detected
  //   Off          → trained but user has flipped it off
  // The toggle is ONLY disabled before a profile exists; once trained the user
  // is always allowed to flip it on/off, even mid-listening session.
  function updateSelfVoiceLabels() {
    if (ui.selfVoiceStrength) {
      paintRange(ui.selfVoiceStrength);
      const s = Number(ui.selfVoiceStrength.value);
      selfVoice.strength = s;
      if (ui.selfVoiceStrengthVal) ui.selfVoiceStrengthVal.textContent = SELF_VOICE_STRENGTH_LABELS[s] || 'Strong';
    }
    if (!ui.selfVoiceStatus) return;
    // Toggle wiring — set BEFORE writing status text so a brief race during
    // training cannot leave the input in a stuck `disabled` state.
    if (ui.selfVoiceToggle) {
      const shouldDisable = selfVoice.training || !selfVoice.trained;
      ui.selfVoiceToggle.disabled = shouldDisable;
      if (shouldDisable) {
        ui.selfVoiceToggle.setAttribute('aria-disabled', 'true');
      } else {
        ui.selfVoiceToggle.removeAttribute('aria-disabled');
      }
      // Keep visual checked state synced to the truthful self-voice state.
      // (Otherwise an iOS Safari paint glitch can leave the thumb stale.)
      const wantChecked = !!(selfVoice.trained && selfVoice.on);
      if (ui.selfVoiceToggle.checked !== wantChecked) {
        ui.selfVoiceToggle.checked = wantChecked;
      }
    }
    if (selfVoice.training) {
      ui.selfVoiceStatus.textContent = 'Training\u2026';
      ui.selfVoiceStatus.setAttribute('data-state', 'working');
      return;
    }
    if (!selfVoice.trained) {
      ui.selfVoiceStatus.textContent = 'Not trained';
      ui.selfVoiceStatus.setAttribute('data-state', 'off');
      return;
    }
    if (selfVoice.on) {
      ui.selfVoiceStatus.textContent = 'Active';
      ui.selfVoiceStatus.setAttribute('data-state', 'active');
    } else {
      ui.selfVoiceStatus.textContent = 'Off';
      ui.selfVoiceStatus.setAttribute('data-state', 'ok');
    }
  }
  function clarityKey() {
    const idx = Math.max(0, Math.min(CLARITY_VALUES.length - 1, Number(ui.clarity.value)));
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
    if (ui.echoReductionToggle) ui.echoReductionToggle.checked = DEFAULTS.echoReduction;
    echoReductionOn = DEFAULTS.echoReduction;
    if (ui.autoLevelToggle) ui.autoLevelToggle.checked = DEFAULTS.autoLevel;
    if (ui.autoLevelStrength) ui.autoLevelStrength.value = String(DEFAULTS.autoLevelStrength);
    if (ui.selfVoiceToggle) {
      ui.selfVoiceToggle.checked = DEFAULTS.selfVoiceOn;
      selfVoice.on = DEFAULTS.selfVoiceOn;
    }
    if (ui.selfVoiceStrength) ui.selfVoiceStrength.value = String(DEFAULTS.selfVoiceStrength);
    updateGainLabel();
    updateGateLabel();
    updateClarityLabel();
    updateAutoLevelLabel();
    updateSelfVoiceLabels();
    setCalibrationStatus('Hold quiet for 2 seconds, then tap.', '');
    if (nodes) {
      applyPreset();
      applyMakeupGain();
      applyEchoReduction();
    }
  });

  // ---------- v5: Auto level voices ----------
  if (ui.autoLevelToggle) {
    ui.autoLevelToggle.addEventListener('change', updateAutoLevelLabel);
  }
  if (ui.autoLevelStrength) {
    ui.autoLevelStrength.addEventListener('input', updateAutoLevelLabel);
  }

  // ---------- v5: Reduce my voice ----------
  if (ui.selfVoiceToggle) {
    ui.selfVoiceToggle.addEventListener('change', () => {
      if (!selfVoice.trained) {
        // Defensive: if a stale event arrives before training completes,
        // force the input back to its real (off) state instead of leaving
        // it half-on with no profile behind it.
        selfVoice.on = false;
      } else {
        selfVoice.on = !!ui.selfVoiceToggle.checked;
        // Reset duck so we don't carry stale state.
        selfVoiceDuck = 1;
      }
      updateSelfVoiceLabels();
    });
  }
  if (ui.selfVoiceStrength) {
    ui.selfVoiceStrength.addEventListener('input', updateSelfVoiceLabels);
  }
  if (ui.trainSelfVoiceBtn) {
    ui.trainSelfVoiceBtn.addEventListener('click', () => {
      // While training, the same button reads "Stop early" and cancels the
      // recording loop. minStopMs in trainSelfVoice() guards against ending
      // the capture so early that the profile would be unreliable.
      if (selfVoice.training) {
        selfVoice.cancelRequested = true;
        return;
      }
      trainSelfVoice();
    });
  }

  // ---------- Echo / room reduction quick toggle ----------
  if (ui.echoReductionToggle) {
    ui.echoReductionToggle.addEventListener('change', () => {
      echoReductionOn = !!ui.echoReductionToggle.checked;
      if (nodes) applyEchoReduction();
    });
  }

  // ---------- Auto-Lock shortcut buttons ----------
  // iOS deep-links are unofficial; we attempt the App-Prefs scheme but the
  // UI also explains the manual path so users aren't stranded.
  function tryOpenAutoLock() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIOS) return;
    const tryScheme = (url) => {
      try {
        const f = document.createElement('iframe');
        f.style.cssText = 'display:none;width:0;height:0;border:0;';
        f.src = url;
        document.body.appendChild(f);
        setTimeout(() => { try { f.remove(); } catch (_) {} }, 1500);
      } catch (_) { /* ignore */ }
    };
    tryScheme('App-Prefs:root=DISPLAY');
    setTimeout(() => tryScheme('prefs:root=DISPLAY'), 250);
  }
  if (ui.awakeOpenAutoLockBtn) ui.awakeOpenAutoLockBtn.addEventListener('click', tryOpenAutoLock);
  if (ui.helpOpenAutoLockBtn) ui.helpOpenAutoLockBtn.addEventListener('click', tryOpenAutoLock);

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
  updateAutoLevelLabel();
  updateSelfVoiceLabels();

  // ---------- Live transcript (Web Speech API) ----------
  // The transcript uses the browser's SpeechRecognition. On iOS Safari this
  // is unreliable when the page is already running a Web Audio mic graph: a
  // second recognition session may share the mic, time out silently after a
  // few seconds, or never deliver `onresult` at all even though the audio
  // engine is happily processing sound. We therefore:
  //
  //   - default to MANUAL start (no auto-start when listening begins)
  //   - watch for long stretches with no `onresult` and surface that
  //   - count restarts so the user can see when iOS is silently dropping us
  //   - expose a Restart transcript button that rebuilds the recognizer
  //   - keep a clear status line: Off / Starting… / Listening / No speech
  //     heard / Restarting… / Error: … / Unsupported
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const transcript = {
    rec: null,
    enabled: false,        // user wants it on
    listening: false,      // recognizer is currently active
    interimEl: null,       // span for current interim result
    autoRestart: true,     // restart on natural end while enabled
    supported: !!SpeechRecognitionCtor,
    lastResultMs: 0,       // wall-clock of last onresult (any kind)
    restartCount: 0,       // visible counter so silent iOS drops are obvious
    watchdog: null,        // setInterval id for no-speech surfacing
    lastErr: '',           // last non-benign error code we saw
  };

  function setTranscriptStatus(text, state) {
    if (!ui.transcriptStatus) return;
    let suffix = '';
    if (transcript.restartCount > 0 && (state === 'listening' || state === 'on')) {
      suffix = ' · restarts: ' + transcript.restartCount;
    }
    ui.transcriptStatus.textContent = text + suffix;
    if (state) ui.transcriptStatus.setAttribute('data-state', state);
    else ui.transcriptStatus.removeAttribute('data-state');
  }

  function setTranscriptToggleLabel() {
    if (ui.transcriptToggleBtn) {
      if (!transcript.supported) {
        ui.transcriptToggleBtn.textContent = 'Unavailable';
        ui.transcriptToggleBtn.disabled = true;
        ui.transcriptToggleBtn.setAttribute('aria-disabled', 'true');
        ui.transcriptToggleBtn.setAttribute('aria-pressed', 'false');
      } else {
        ui.transcriptToggleBtn.textContent = transcript.enabled ? 'Stop transcript' : 'Start transcript';
        ui.transcriptToggleBtn.setAttribute('aria-pressed', transcript.enabled ? 'true' : 'false');
        ui.transcriptToggleBtn.disabled = false;
        ui.transcriptToggleBtn.removeAttribute('aria-disabled');
      }
    }
    if (ui.transcriptRestartBtn) {
      // Restart is only useful when the user has the transcript turned on
      // (or it is supported and might be stuck). Disable when off.
      if (!transcript.supported) {
        ui.transcriptRestartBtn.disabled = true;
        ui.transcriptRestartBtn.setAttribute('aria-disabled', 'true');
      } else {
        ui.transcriptRestartBtn.disabled = !transcript.enabled;
        if (!transcript.enabled) ui.transcriptRestartBtn.setAttribute('aria-disabled', 'true');
        else ui.transcriptRestartBtn.removeAttribute('aria-disabled');
      }
    }
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
      transcript.lastResultMs = performance.now();
      setTranscriptStatus('Listening', 'listening');
    };
    rec.onresult = (event) => {
      transcript.lastResultMs = performance.now();
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
      // If we just got our first result after a stretch of silence, promote
      // the visible status from "No speech heard" back to "Listening".
      if (transcript.enabled) setTranscriptStatus('Listening', 'listening');
    };
    rec.onerror = (event) => {
      const err = event && event.error ? event.error : 'unknown';
      transcript.lastErr = err;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        transcript.enabled = false;
        transcript.autoRestart = false;
        setTranscriptStatus('Permission denied', 'error');
        stopTranscriptWatchdog();
        setTranscriptToggleLabel();
      } else if (err === 'no-speech') {
        // iOS Safari fires this when continuous mode times out. Don't kill
        // the session — onend will run next and we'll auto-restart.
        setTranscriptStatus('No speech heard · will retry', 'warn');
      } else if (err === 'aborted') {
        // benign; happens when we stop() or restart()
      } else if (err === 'audio-capture') {
        setTranscriptStatus('No microphone available to recognizer', 'error');
      } else if (err === 'network') {
        setTranscriptStatus('Network error · will retry', 'warn');
      } else {
        setTranscriptStatus('Error: ' + err, 'error');
      }
    };
    rec.onend = () => {
      transcript.listening = false;
      if (transcript.enabled && transcript.autoRestart) {
        // Continuous mode on iOS Safari often ends after a few seconds.
        // Bump the visible restart counter so silent drops are obvious.
        transcript.restartCount += 1;
        try {
          rec.start();
          setTranscriptStatus('Restarting\u2026', 'listening');
        } catch (_) {
          // If start() throws (race in iOS Safari), schedule a fresh
          // recognizer instance after a short delay.
          setTimeout(() => {
            if (!transcript.enabled) return;
            try {
              transcript.rec = buildRecognition();
              if (transcript.rec) transcript.rec.start();
              setTranscriptStatus('Restarting\u2026', 'listening');
            } catch (e2) {
              setTranscriptStatus('Stuck · tap Restart', 'error');
            }
          }, 250);
        }
      } else {
        setTranscriptStatus('Off');
      }
    };
    return rec;
  }

  // Watchdog: if the recognizer is supposedly listening but we haven't seen
  // *any* result in N seconds, surface that to the user. This is the case the
  // user reported — "audio is clear but nothing is being transcribed".
  function startTranscriptWatchdog() {
    stopTranscriptWatchdog();
    transcript.watchdog = setInterval(() => {
      if (!transcript.enabled) return;
      const now = performance.now();
      const since = now - (transcript.lastResultMs || now);
      // 12 s without any result while "listening" — surface the silence.
      if (transcript.listening && since > 12000) {
        setTranscriptStatus('No speech heard yet · still listening', 'warn');
      }
    }, 2000);
  }
  function stopTranscriptWatchdog() {
    if (transcript.watchdog) {
      clearInterval(transcript.watchdog);
      transcript.watchdog = null;
    }
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
    transcript.restartCount = 0;
    transcript.lastResultMs = performance.now();
    setTranscriptToggleLabel();
    try {
      transcript.rec.start();
      setTranscriptStatus('Starting\u2026', 'listening');
    } catch (err) {
      // start() throws if already started — treat as "on"
      setTranscriptStatus('On', 'on');
    }
    startTranscriptWatchdog();
  }

  function stopTranscript() {
    transcript.enabled = false;
    transcript.autoRestart = false;
    stopTranscriptWatchdog();
    setTranscriptToggleLabel();
    if (transcript.rec && transcript.listening) {
      try { transcript.rec.stop(); } catch (_) {}
    }
    setInterim('');
    transcript.restartCount = 0;
    setTranscriptStatus('Off');
  }

  // Force-restart: tear down the current recognizer (which iOS Safari often
  // gets stuck in) and rebuild a fresh one. This is the most reliable way to
  // un-stick a silent recognition on a real iPhone.
  function restartTranscript() {
    if (!transcript.supported) return;
    if (!transcript.enabled) {
      // Treat Restart-when-off as Start (forgiving UX).
      startTranscript();
      return;
    }
    transcript.autoRestart = false;
    try { if (transcript.rec) transcript.rec.abort(); } catch (_) {}
    try { if (transcript.rec) transcript.rec.stop(); } catch (_) {}
    setInterim('');
    setTranscriptStatus('Restarting\u2026', 'listening');
    setTimeout(() => {
      if (!transcript.enabled) return;
      transcript.rec = buildRecognition();
      transcript.autoRestart = true;
      transcript.restartCount += 1;
      transcript.lastResultMs = performance.now();
      try {
        if (transcript.rec) transcript.rec.start();
      } catch (err) {
        setTranscriptStatus('Could not restart · try again', 'error');
      }
    }, 350);
  }

  if (ui.transcriptToggleBtn) {
    ui.transcriptToggleBtn.addEventListener('click', () => {
      if (!transcript.supported) return;
      if (transcript.enabled) stopTranscript();
      else startTranscript();
    });
  }
  if (ui.transcriptRestartBtn) {
    ui.transcriptRestartBtn.addEventListener('click', () => {
      restartTranscript();
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
      ui.transcriptPlaceholder.textContent = 'Live transcript is not available in this browser. Try Chrome on Android, or Safari on a recent iPhone.';
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

  // Detect iOS for a few platform-specific bits (warning copy, fallback).
  const IS_IOS_UA = (() => {
    const ua = (navigator.userAgent || '').toLowerCase();
    return /iphone|ipad|ipod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  })();

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
              // The video fallback on iPhone is unreliable in Low Power
              // Mode and on older iOS — surface the Auto-Lock
              // instructions so the user has a sure-fire fix.
              showAwakeWarn(IS_IOS_UA);
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
          // Sentinel was released while listening — on iPhone this means
          // iOS likely won't honour wake-lock until Auto-Lock is set to Never.
          if (IS_IOS_UA) showAwakeWarn(true);
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
    // Second ‘room’ cut around 500 Hz — only active when echo reduction is ON.
    const lowMidCut2 = audioCtx.createBiquadFilter();
    lowMidCut2.type = 'peaking'; lowMidCut2.frequency.value = 500; lowMidCut2.Q.value = 1.4; lowMidCut2.gain.value = 0;
    const presence = audioCtx.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 2500; presence.Q.value = 1.1;
    const air = audioCtx.createBiquadFilter();
    air.type = 'highshelf'; air.frequency.value = 6500;
    const lowPass = audioCtx.createBiquadFilter();
    lowPass.type = 'lowpass'; lowPass.Q.value = 0.707;

    const comp = audioCtx.createDynamicsCompressor();
    comp.attack.value = 0.006;
    comp.release.value = 0.20;
    comp.knee.value = 24;

    // v5: "gate" is now a smooth downward-expander gain stage. We never
    // drive it to 0 instantly — the meter loop slews this with hysteresis
    // and a slow release so transitions sound natural, not choppy.
    const gate = audioCtx.createGain();
    gate.gain.value = 1;

    // Sidechain: tap signal *before* the EQ chain so our envelope reflects
    // the raw room level, independent of presence/air boosts. We use the
    // post-compressor analyser too (for self-voice spectral matching).
    const sidechain = audioCtx.createAnalyser();
    sidechain.fftSize = 1024;
    sidechain.smoothingTimeConstant = 0.4;

    // v6: voice-band compressor ("leveler") — a serious DynamicsCompressor
    // sitting in front of the AGC. Its job is to flatten loud talkers in real
    // time at the audio thread (not just the slow meter-loop AGC), so a near
    // speaker can never exceed the leveler ceiling no matter how loud they
    // are. AGC then handles the *slow* makeup needed to lift quiet voices.
    const leveler = audioCtx.createDynamicsCompressor();
    leveler.threshold.value = -28;
    leveler.ratio.value = 6;
    leveler.knee.value = 18;
    leveler.attack.value = 0.005;
    leveler.release.value = 0.18;

    // v5: AGC stage — modulated by the meter loop toward a target output.
    const agc = audioCtx.createGain();
    agc.gain.value = 1;

    // v5: Self-voice ducking stage — separate so it can transparently sit
    // at unity (1.0) when the feature is off or untrained.
    const selfDuck = audioCtx.createGain();
    selfDuck.gain.value = 1;

    const makeup = audioCtx.createGain();
    makeup.gain.value = 1;

    // v5: soft limiter to catch peaks regardless of AGC setting. Threshold
    // is high (-3 dB) and ratio steep, so it only acts on near-clipping
    // peaks. Prevents hearing harm and BT codec distortion.
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.ratio.value = 12;
    limiter.knee.value = 2;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;

    // Spectral analyser for self-voice matching (frequency-domain).
    const spectrum = audioCtx.createAnalyser();
    spectrum.fftSize = 2048;
    spectrum.smoothingTimeConstant = 0.5;

    const meter = audioCtx.createAnalyser();
    meter.fftSize = 1024;
    meter.smoothingTimeConstant = 0.6;

    const muteSink = audioCtx.createGain();
    muteSink.gain.value = 0;

    // Signal flow:
    //   src → HP → lowMid1 → lowMid2 → presence → air → LP → comp
    //                                                            ↓
    //                            sidechain (env)  spectrum (centroid)
    //                                                            ↓
    //                                              expander (gate)
    //                                                            ↓
    //                                                  AGC → selfDuck
    //                                                            ↓
    //                                                  makeup → limiter
    //                                                            ↓
    //                                                          meter
    //                                                            ↓
    //                                                       destination
    src.connect(highPass);
    highPass.connect(lowMidCut);
    lowMidCut.connect(lowMidCut2);
    lowMidCut2.connect(presence);
    presence.connect(air);
    air.connect(lowPass);
    lowPass.connect(comp);
    comp.connect(sidechain);
    comp.connect(spectrum);
    comp.connect(gate);
    // v6: gate → hardware leveler → AGC → self-voice duck → makeup → limiter
    gate.connect(leveler);
    leveler.connect(agc);
    agc.connect(selfDuck);
    selfDuck.connect(makeup);
    makeup.connect(limiter);
    limiter.connect(meter);
    meter.connect(audioCtx.destination); // monitor on by default
    meter.connect(muteSink);
    muteSink.connect(audioCtx.destination);

    nodes = {
      src, highPass, lowMidCut, lowMidCut2, presence, air, lowPass,
      comp, gate, sidechain, spectrum, leveler, agc, selfDuck, makeup, limiter, meter, muteSink,
    };

    applyPreset();
    applyMakeupGain();
    applyEchoReduction();

    // Reset dynamic-stage smoothers so the engine starts gracefully.
    envSmooth = 0;
    envFast = 0;
    envSlow = 0;
    expanderGain = 1;
    agcGain = 1;
    selfVoiceDuck = 1;
    // Apply current strength to leveler in case the user changed it before start.
    applyLevelerStrength();

    running = true;
    ui.toggle.classList.add('is-live');
    ui.toggle.setAttribute('aria-pressed', 'true');
    ui.toggle.setAttribute('aria-label', 'Stop Listening');
    ui.toggleLabel.textContent = 'Stop';
    setStatus('Listening', 'live');

    // NOTE: We deliberately do NOT auto-start the transcript here. On real
    // iPhones, running a second SpeechRecognition session at the same time as
    // the Web Audio mic graph often produces a silent recognizer (clear audio,
    // no `onresult` events). The transcript section now has its own explicit
    // "Start transcript" button so the user can opt in after audio is stable.

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
    const p = PRESETS[key] || PRESETS.restaurant;
    const t = audioCtx.currentTime;
    const ramp = 0.05;

    nodes.highPass.frequency.linearRampToValueAtTime(p.lowCut, t + ramp);
    nodes.lowPass.frequency.linearRampToValueAtTime(p.highCut, t + ramp);
    nodes.presence.gain.linearRampToValueAtTime(p.presence, t + ramp);
    nodes.air.gain.linearRampToValueAtTime(p.air, t + ramp);
    nodes.lowMidCut.gain.linearRampToValueAtTime(p === PRESETS.bypass ? 0 : (p.lowMid != null ? p.lowMid : -3), t + ramp);

    nodes.comp.threshold.linearRampToValueAtTime(p.comp, t + ramp);
    nodes.comp.ratio.linearRampToValueAtTime(p.ratio, t + ramp);
    if (typeof p.knee === 'number') {
      try { nodes.comp.knee.linearRampToValueAtTime(p.knee, t + ramp); } catch (_) {}
    }
    if (typeof p.release === 'number') {
      try { nodes.comp.release.linearRampToValueAtTime(p.release, t + ramp); } catch (_) {}
    }

    // Re-apply echo reduction since lowMid bands depend on the active preset.
    applyEchoReduction();
  }

  // ---------- Calibrate room noise ----------
  // Samples ambient mic level for ~2 seconds (while user is quiet) and sets
  // the noise gate threshold ~6 dB above the measured floor. We re-use the
  // existing audio chain when running; otherwise we open a short-lived test
  // stream just for measurement.
  const calibration = { running: false };

  function setCalibrationStatus(text, state) {
    if (!ui.calibrationStatus) return;
    ui.calibrationStatus.textContent = text;
    if (state) ui.calibrationStatus.setAttribute('data-state', state);
    else ui.calibrationStatus.removeAttribute('data-state');
    if (ui.calibrateBtn) {
      if (state === 'working') {
        ui.calibrateBtn.setAttribute('data-state', 'working');
        ui.calibrateBtn.setAttribute('aria-busy', 'true');
      } else {
        ui.calibrateBtn.removeAttribute('data-state');
        ui.calibrateBtn.removeAttribute('aria-busy');
      }
    }
  }

  async function runCalibration() {
    if (calibration.running) return;
    calibration.running = true;
    if (ui.calibrateBtn) ui.calibrateBtn.disabled = true;

    let tempStream = null;
    let tempCtx = null;
    let tempAnalyser = null;
    let usingExisting = false;

    try {
      if (running && nodes && audioCtx) {
        // Use the live sidechain analyser — no extra stream needed.
        tempAnalyser = nodes.sidechain;
        usingExisting = true;
      } else {
        // Need permission first; this also forces iOS to surface labels.
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Microphone API not available');
        }
        setCalibrationStatus('Asking for microphone\u2026', 'working');
        tempStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
          video: false,
        });
        const Ctx = window.AudioContext || window.webkitAudioContext;
        tempCtx = new Ctx({ latencyHint: 'interactive' });
        if (tempCtx.state === 'suspended') {
          try { await tempCtx.resume(); } catch (_) {}
        }
        const src = tempCtx.createMediaStreamSource(tempStream);
        tempAnalyser = tempCtx.createAnalyser();
        tempAnalyser.fftSize = 1024;
        tempAnalyser.smoothingTimeConstant = 0.4;
        src.connect(tempAnalyser);
      }

      // Sample for ~2 seconds. Take RMS frames every ~50 ms and use the
      // 75th-percentile RMS so a single cough doesn't blow the floor up.
      const buf = new Float32Array(tempAnalyser.fftSize);
      const samples = [];
      const startMs = performance.now();
      const totalMs = 2000;
      // small lead-in so the user sees the prompt before we measure
      setCalibrationStatus('Hold still for 2 seconds\u2026', 'working');
      await new Promise((r) => setTimeout(r, 250));

      while (performance.now() - startMs < totalMs) {
        tempAnalyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        samples.push(rms);
        const elapsed = performance.now() - startMs;
        const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
        setCalibrationStatus('Sampling\u2026 ' + remaining + 's', 'working');
        await new Promise((r) => setTimeout(r, 50));
      }

      if (!samples.length) throw new Error('No samples collected');
      samples.sort((a, b) => a - b);
      const p75 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.75))];
      const floorDb = p75 > 0 ? 20 * Math.log10(p75) : -100;
      // Set gate threshold ~6 dB above the noise floor, clamped to slider range.
      let target = Math.round(floorDb + 6);
      const minVal = Number(ui.gate.min);
      const maxVal = Number(ui.gate.max);
      if (target < minVal) target = minVal;
      if (target > maxVal) target = maxVal;

      ui.gate.value = String(target);
      updateGateLabel();

      const levelText = ui.gateVal.textContent;
      setCalibrationStatus(
        'Set to ' + levelText + ' (floor ' + Math.round(floorDb) + ' dB)',
        'ok'
      );
    } catch (err) {
      console.warn('Calibration failed:', err);
      const name = err && err.name ? err.name : '';
      let msg = 'Calibration failed';
      if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Microphone permission needed';
      else if (name === 'NotFoundError') msg = 'No microphone found';
      else if (name === 'NotReadableError') msg = 'Microphone is busy';
      setCalibrationStatus(msg, 'error');
    } finally {
      // Tear down the temp graph if we made one. Don't touch the live one.
      if (!usingExisting) {
        try { if (tempStream) tempStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { if (tempCtx) tempCtx.close(); } catch (_) {}
      }
      calibration.running = false;
      if (ui.calibrateBtn) ui.calibrateBtn.disabled = false;
    }
  }

  if (ui.calibrateBtn) {
    ui.calibrateBtn.addEventListener('click', () => { runCalibration(); });
  }

  // Apply (or unapply) the extra room/echo damping band + tighter highpass.
  function applyEchoReduction() {
    if (!nodes || !audioCtx) return;
    const t = audioCtx.currentTime;
    const ramp = 0.06;
    const key = clarityKey();
    const p = PRESETS[key] || PRESETS.restaurant;
    if (echoReductionOn && p !== PRESETS.bypass) {
      // Cut ~500 Hz (room boom / boxiness) and lift highpass by ~30 Hz to
      // shave the lowest reverberant tail without thinning vowels.
      try { nodes.lowMidCut2.gain.linearRampToValueAtTime(-3.5, t + ramp); } catch (_) {}
      try { nodes.highPass.frequency.linearRampToValueAtTime(p.lowCut + 30, t + ramp); } catch (_) {}
    } else {
      try { nodes.lowMidCut2.gain.linearRampToValueAtTime(0, t + ramp); } catch (_) {}
      try { nodes.highPass.frequency.linearRampToValueAtTime(p.lowCut, t + ramp); } catch (_) {}
    }
  }

  function applyMakeupGain() {
    if (!nodes || !audioCtx) return;
    const db = Number(ui.gain.value);
    const lin = Math.pow(10, db / 20);
    nodes.makeup.gain.linearRampToValueAtTime(lin, audioCtx.currentTime + 0.05);
  }

  // v6: re-tune the voice-band leveler whenever the auto-level strength or
  // toggle changes. Higher strengths = lower threshold + higher ratio so
  // loud talkers get pinned harder before they reach the AGC. When auto
  // level is OFF we relax the leveler to a transparent compressor so the
  // signal still gets gentle peak control without aggressive flattening.
  function applyLevelerStrength() {
    if (!nodes || !audioCtx || !nodes.leveler) return;
    const t = audioCtx.currentTime;
    const ramp = 0.05;
    let threshold = -28, ratio = 6, knee = 18, attack = 0.005, release = 0.18;
    if (!autoLevelOn || autoLevelStrength === 0) {
      // Transparent peak-only mode.
      threshold = -10; ratio = 2; knee = 12; attack = 0.010; release = 0.25;
    } else if (autoLevelStrength === 1) {
      // Light: gentle, only catches the loudest peaks.
      threshold = -22; ratio = 3; knee = 18; attack = 0.008; release = 0.22;
    } else if (autoLevelStrength === 2) {
      // Medium: typical broadcast-leveler feel.
      threshold = -28; ratio = 5; knee = 18; attack = 0.005; release = 0.18;
    } else {
      // Strong (v6 default): heavy real-time leveling for restaurants.
      threshold = -32; ratio = 8; knee = 16; attack = 0.004; release = 0.14;
    }
    try { nodes.leveler.threshold.linearRampToValueAtTime(threshold, t + ramp); } catch (_) {}
    try { nodes.leveler.ratio.linearRampToValueAtTime(ratio, t + ramp); } catch (_) {}
    try { nodes.leveler.knee.linearRampToValueAtTime(knee, t + ramp); } catch (_) {}
    try { nodes.leveler.attack.linearRampToValueAtTime(attack, t + ramp); } catch (_) {}
    try { nodes.leveler.release.linearRampToValueAtTime(release, t + ramp); } catch (_) {}
  }

  function setStatus(text, kind) {
    ui.status.textContent = text;
    ui.status.classList.remove('is-live', 'is-error');
    if (kind === 'live') ui.status.classList.add('is-live');
    if (kind === 'error') ui.status.classList.add('is-error');
  }

  // ---------- v5: smoothed envelope + dynamics loop ----------
  // Replaces the old binary noise gate. We compute a smoothed RMS envelope,
  // then drive three independent gain stages each frame:
  //   1) downward expander ("gate") — soft, hysteretic, slow release
  //   2) AGC (auto level voices) — scales toward a target output level
  //   3) self-voice duck — best-effort attenuation when the input matches
  //      the trained voice profile
  // All three slew via setTargetAtTime so the audio never steps; this is
  // what makes v5 sound smooth instead of choppy.
  //
  // Tunables:
  //   AGC target output (linear amplitude)
  //   AGC max gain (hard limit so we don't pump the room when nobody talks)
  //   AGC min gain
  //   Expander ratio + release per strength
  function runMeterLoop() {
    const sideBuf = new Float32Array(nodes.sidechain.fftSize);
    const meterBuf = new Float32Array(nodes.meter.fftSize);
    const freqBins = nodes.spectrum.frequencyBinCount;
    const freqBuf = new Uint8Array(freqBins);
    const sampleRate = audioCtx.sampleRate || 48000;

    // v6 smoothing constants. The fast envelope tracks syllable-level peaks
    // for downward AGC and self-voice detection; the slow envelope tracks
    // the conversational level the AGC chases for upward makeup. Two-rate
    // smoothing prevents the classic AGC pumping you get from a single
    // mid-rate envelope.
    const FAST_ATTACK = 0.35;   // ~25 ms attack
    const FAST_RELEASE = 0.12;  // ~60 ms release
    const SLOW_ATTACK = 0.04;   // ~250 ms upward integration
    const SLOW_RELEASE = 0.015; // ~700 ms downward integration
    // Expander (downward gate) gain smoothing.
    const EXP_ATTACK = 0.30;
    const EXP_RELEASE = 0.06;
    // AGC gain smoothing: asymmetric. Slow when increasing gain (so quiet
    // gaps don't pump up the noise floor), fast when decreasing gain (so a
    // sudden loud talker gets snapped back inside ~150 ms).
    const AGC_GAIN_UP = 0.025;     // ~1.2 s upward glide
    const AGC_GAIN_DOWN = 0.40;    // ~120 ms downward grab
    const DUCK_ATTACK = 0.45;      // duck quickly when self-voice detected
    const DUCK_RELEASE = 0.08;     // ease back smoothly

    const tick = () => {
      if (!running || !nodes) return;
      rafId = requestAnimationFrame(tick);

      // ---- 1) Compute fast + slow smoothed envelopes (linear RMS) ----
      nodes.sidechain.getFloatTimeDomainData(sideBuf);
      let sumSq = 0;
      for (let i = 0; i < sideBuf.length; i++) sumSq += sideBuf[i] * sideBuf[i];
      const rms = Math.sqrt(sumSq / sideBuf.length);
      const fa = rms > envFast ? FAST_ATTACK : FAST_RELEASE;
      envFast += (rms - envFast) * fa;
      // Slow envelope: only follow when above a voice-activity floor so a
      // long silence between turns doesn't pull the slow level to zero and
      // make the AGC slam to max gain when the next person speaks.
      const voiceActive = rms > 0.012;
      const sa = voiceActive ? (rms > envSlow ? SLOW_ATTACK : SLOW_RELEASE) : 0;
      if (sa > 0) envSlow += (rms - envSlow) * sa;
      // envSmooth keeps the v5 semantics for legacy callers (calibrate, etc.)
      envSmooth = envFast;
      const envDb = envFast > 1e-6 ? 20 * Math.log10(envFast) : -120;

      // ---- 2) Downward expander ("Smooth Noise Reduction") ----
      // Soft-knee around the threshold with hysteresis: opens at
      // (threshold + 4 dB), closes at (threshold - 4 dB). Below the close
      // point, attenuate by up to ~18 dB depending on how far below.
      const threshold = Number(ui.gate.value);
      let expTarget = 1;
      if (clarityKey() === 'bypass') {
        expTarget = 1;
      } else {
        const open = threshold + 4;
        const close = threshold - 4;
        if (envDb >= open) {
          expTarget = 1;
        } else if (envDb <= close) {
          // Below the soft-floor: clamp to ~0.13 (~ -18 dB) instead of 0,
          // so the room doesn't pop in/out. This is the key choppiness fix.
          const below = Math.max(-18, envDb - close);
          expTarget = Math.pow(10, below / 20); // -18 dB -> ~0.126
          if (expTarget < 0.13) expTarget = 0.13;
        } else {
          // In the soft knee: linear interpolate 0.13..1
          const t = (envDb - close) / (open - close);
          expTarget = 0.13 + t * (1 - 0.13);
        }
      }
      const ec = expTarget > expanderGain ? EXP_ATTACK : EXP_RELEASE;
      expanderGain += (expTarget - expanderGain) * ec;
      try {
        nodes.gate.gain.setTargetAtTime(expanderGain, audioCtx.currentTime, 0.015);
      } catch (_) {}

      // ---- 3) AGC / Auto level voices (v6) ----
      // Two-rate AGC. The slow envelope sets the *upward* makeup target
      // (so quiet talkers come up smoothly), the fast envelope clamps that
      // gain instantly downward when a loud talker leans in. Combined with
      // the audio-thread leveler upstream, this makes near vs. far speakers
      // hit the headset at much closer levels.
      //
      // Strength controls target loudness, max boost, and downward floor.
      // Higher strengths = louder target + more boost + tighter peak ceiling.
      const TARGET_BY_STRENGTH = [0.20, 0.18, 0.22, 0.26]; // Off/Light/Med/Strong
      const MAX_GAIN_BY_STRENGTH = [1.0, 5.0, 10.0, 16.0];
      const MIN_GAIN_BY_STRENGTH = [1.0, 0.6, 0.45, 0.30];
      // Peak ceiling — if the fast envelope exceeds this we drag gain down
      // hard so a yell can never blow the headset.
      const PEAK_CEILING_BY_STRENGTH = [0.95, 0.55, 0.42, 0.32];

      const TARGET = TARGET_BY_STRENGTH[autoLevelStrength] || 0.22;
      const maxG = MAX_GAIN_BY_STRENGTH[autoLevelStrength] || 10.0;
      const minG = MIN_GAIN_BY_STRENGTH[autoLevelStrength] || 0.45;
      const peakCeil = PEAK_CEILING_BY_STRENGTH[autoLevelStrength] || 0.42;

      let agcTarget = 1;
      if (autoLevelOn && autoLevelStrength > 0 && expanderGain > 0.25) {
        // Upward target chases the slow envelope.
        const slowRef = Math.max(0.004, envSlow);
        let upTarget = TARGET / slowRef;
        if (upTarget > maxG) upTarget = maxG;
        // Downward override: if fast envelope * current gain would exceed
        // the peak ceiling, compute a lower target so the next sample
        // lands at-or-below the ceiling. This is the "loud speaker grab."
        const projected = envFast * Math.max(0.05, agcGain);
        if (projected > peakCeil) {
          const downTarget = peakCeil / Math.max(0.005, envFast);
          // Pick whichever is lower so a loud speaker dominates a quiet one.
          upTarget = Math.min(upTarget, downTarget);
        }
        if (upTarget < minG) upTarget = minG;
        if (upTarget > maxG) upTarget = maxG;
        agcTarget = upTarget;
      } else if (!autoLevelOn || autoLevelStrength === 0) {
        agcTarget = 1;
      } else {
        // Below expander floor: glide toward unity, don't pump.
        agcTarget = 1;
      }
      const ac = agcTarget > agcGain ? AGC_GAIN_UP : AGC_GAIN_DOWN;
      agcGain += (agcTarget - agcGain) * ac;
      // Hard safety clamp.
      if (agcGain < 0.05) agcGain = 0.05;
      if (agcGain > maxG) agcGain = maxG;
      try {
        nodes.agc.gain.setTargetAtTime(agcGain, audioCtx.currentTime, 0.025);
      } catch (_) {}

      // ---- 4) Self-voice ducking (best-effort) ----
      // v6: looser "either loud OR centroid match" gating, but require near
      // field. Depth deepened so the ducks are actually audible.
      // Trigger requires (all):
      //   (a) feature trained + on
      //   (b) fast envelope is above a near-field threshold (loud + close)
      //   (c) EITHER fast envelope >= ~0.65 of profile peak,
      //       OR spectral centroid is within tolerance of profile
      let duckTarget = 1;
      if (selfVoice.on && selfVoice.trained && selfVoice.profile) {
        nodes.spectrum.getByteFrequencyData(freqBuf);
        let num = 0, den = 0;
        for (let i = 0; i < freqBins; i++) {
          const m = freqBuf[i];
          if (m < 8) continue;
          const f = (i * sampleRate) / (2 * freqBins);
          num += f * m;
          den += m;
        }
        const centroid = den > 0 ? num / den : 0;
        const prof = selfVoice.profile;
        // Near-field: must be at least ~70% of the user's training mean RMS
        // *and* above an absolute floor so quiet far talkers can't trip it.
        const nearField = envFast >= Math.max(0.04, prof.rmsMean * 0.7);
        const veryLoud = envFast >= prof.rmsPeak * 0.55;
        const spectralOk = centroid > 0 && Math.abs(centroid - prof.centroidMean) <
          Math.max(500, 1.6 * (prof.centroidStd || 280));
        const matches = nearField && (veryLoud || spectralOk);
        if (matches) {
          // v6 depths: Light -6, Medium -12, Strong -20 dB.
          const depthByStrength = [0, -6, -12, -20];
          const dB = depthByStrength[selfVoice.strength] || -12;
          duckTarget = Math.pow(10, dB / 20);
        } else {
          duckTarget = 1;
        }
      } else {
        duckTarget = 1;
      }
      const dc = duckTarget < selfVoiceDuck ? DUCK_ATTACK : DUCK_RELEASE;
      selfVoiceDuck += (duckTarget - selfVoiceDuck) * dc;
      try {
        nodes.selfDuck.gain.setTargetAtTime(selfVoiceDuck, audioCtx.currentTime, 0.02);
      } catch (_) {}

      // ---- 5) Meter + warnings ----
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

  // ---------- v5: Self-voice training ----------
  // Capture a 3-second sample of the user reading a phrase, then store an
  // in-memory profile of average level + spectral centroid. Honest about
  // limits in the UI; this is feature-engineered, not voiceprint ML.
  async function trainSelfVoice() {
    if (selfVoice.training) return;
    selfVoice.training = true;
    selfVoice.cancelRequested = false;
    if (ui.selfVoiceControl) ui.selfVoiceControl.setAttribute('data-self-voice', 'training');
    if (ui.trainSelfVoiceBtn) ui.trainSelfVoiceBtn.disabled = true;
    if (ui.selfVoiceProgress) ui.selfVoiceProgress.style.width = '0%';
    updateSelfVoiceLabels();

    let tempStream = null;
    let tempCtx = null;
    let usingExisting = false;
    let analyser = null;
    let spectrumNode = null;
    let sampleRate = 48000;

    try {
      if (running && nodes && audioCtx) {
        analyser = nodes.sidechain;
        spectrumNode = nodes.spectrum;
        sampleRate = audioCtx.sampleRate || 48000;
        usingExisting = true;
      } else {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Microphone API not available');
        }
        if (ui.selfVoiceStatus) {
          ui.selfVoiceStatus.textContent = 'Asking for mic\u2026';
          ui.selfVoiceStatus.setAttribute('data-state', 'working');
        }
        tempStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
          video: false,
        });
        const Ctx = window.AudioContext || window.webkitAudioContext;
        tempCtx = new Ctx({ latencyHint: 'interactive' });
        if (tempCtx.state === 'suspended') {
          try { await tempCtx.resume(); } catch (_) {}
        }
        sampleRate = tempCtx.sampleRate || 48000;
        const src = tempCtx.createMediaStreamSource(tempStream);
        analyser = tempCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.4;
        spectrumNode = tempCtx.createAnalyser();
        spectrumNode.fftSize = 2048;
        spectrumNode.smoothingTimeConstant = 0.5;
        src.connect(analyser);
        src.connect(spectrumNode);
      }

      // v6: 3-second countdown so the user can prepare; the prompt is
      // longer than v5 and clearly states "keep speaking until the timer
      // ends". The Train button doubles as a Stop control during recording.
      for (let n = 3; n >= 1; n--) {
        if (selfVoice.cancelRequested) throw new Error('Training cancelled');
        if (ui.selfVoiceStatus) {
          ui.selfVoiceStatus.textContent = 'Get ready\u2026 ' + n;
          ui.selfVoiceStatus.setAttribute('data-state', 'working');
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      if (ui.trainSelfVoiceBtn) {
        ui.trainSelfVoiceBtn.disabled = false;
        ui.trainSelfVoiceBtn.textContent = 'Stop early';
        ui.trainSelfVoiceBtn.setAttribute('data-state', 'recording');
      }
      if (ui.selfVoiceControl) ui.selfVoiceControl.setAttribute('data-self-voice', 'recording');

      const tBuf = new Float32Array(analyser.fftSize);
      const fBins = spectrumNode.frequencyBinCount;
      const fBuf = new Uint8Array(fBins);

      const rmsSamples = [];
      const centroidSamples = [];
      const startMs = performance.now();
      // v6: 8-second window. Long enough to read the new prompt fully even at
      // a relaxed pace, with a Stop-early control if the user finishes sooner.
      const totalMs = 8000;
      const minStopMs = 2500; // require at least 2.5 s of audio before allowing early stop
      while (performance.now() - startMs < totalMs) {
        const elapsed = performance.now() - startMs;
        const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
        if (ui.selfVoiceStatus) {
          ui.selfVoiceStatus.textContent =
            'Keep speaking\u2026 ' + remaining + 's left';
          ui.selfVoiceStatus.setAttribute('data-state', 'working');
        }
        // Drive the visible progress bar if present.
        if (ui.selfVoiceProgress) {
          const pct = Math.min(100, (elapsed / totalMs) * 100);
          ui.selfVoiceProgress.style.width = pct.toFixed(1) + '%';
        }
        analyser.getFloatTimeDomainData(tBuf);
        let sumSq = 0;
        for (let i = 0; i < tBuf.length; i++) sumSq += tBuf[i] * tBuf[i];
        const rms = Math.sqrt(sumSq / tBuf.length);
        if (rms > 0.005) rmsSamples.push(rms); // ignore silence between syllables

        spectrumNode.getByteFrequencyData(fBuf);
        let num = 0, den = 0;
        for (let i = 0; i < fBins; i++) {
          const m = fBuf[i];
          if (m < 8) continue;
          const f = (i * sampleRate) / (2 * fBins);
          num += f * m;
          den += m;
        }
        if (den > 0) centroidSamples.push(num / den);
        await new Promise((r) => setTimeout(r, 50));
        if (selfVoice.cancelRequested && elapsed >= minStopMs) break;
      }
      if (ui.selfVoiceProgress) ui.selfVoiceProgress.style.width = '100%';

      if (rmsSamples.length < 12 || centroidSamples.length < 12) {
        throw new Error('Not enough voice detected. Try again, a little louder.');
      }

      // Robust statistics: trimmed mean for level, mean+std for centroid.
      rmsSamples.sort((a, b) => a - b);
      const trim = Math.floor(rmsSamples.length * 0.1);
      const trimmed = rmsSamples.slice(trim, rmsSamples.length - trim);
      const rmsMean = trimmed.reduce((s, v) => s + v, 0) / Math.max(1, trimmed.length);
      const rmsPeak = rmsSamples[Math.min(rmsSamples.length - 1, Math.floor(rmsSamples.length * 0.95))];

      const cMean = centroidSamples.reduce((s, v) => s + v, 0) / centroidSamples.length;
      let cVar = 0;
      for (let i = 0; i < centroidSamples.length; i++) {
        const d = centroidSamples[i] - cMean;
        cVar += d * d;
      }
      const cStd = Math.sqrt(cVar / centroidSamples.length);

      selfVoice.profile = {
        rmsMean,
        rmsPeak,
        centroidMean: cMean,
        centroidStd: cStd,
      };
      selfVoice.trained = true;
      // Auto-enable so the user gets immediate effect; they can flip it off.
      if (ui.selfVoiceToggle) ui.selfVoiceToggle.checked = true;
      selfVoice.on = true;
      selfVoiceDuck = 1;
    } catch (err) {
      console.warn('Self-voice training failed:', err);
      selfVoice.trained = false;
      selfVoice.profile = null;
      const msg = (err && err.message) ? err.message : 'Training failed';
      if (ui.selfVoiceStatus) {
        ui.selfVoiceStatus.textContent = msg.length < 64 ? msg : 'Training failed';
        ui.selfVoiceStatus.setAttribute('data-state', 'warn');
      }
    } finally {
      selfVoice.training = false;
      selfVoice.cancelRequested = false;
      if (ui.selfVoiceControl) ui.selfVoiceControl.removeAttribute('data-self-voice');
      if (ui.trainSelfVoiceBtn) {
        ui.trainSelfVoiceBtn.disabled = false;
        ui.trainSelfVoiceBtn.removeAttribute('data-state');
        ui.trainSelfVoiceBtn.textContent = selfVoice.trained ? 'Retrain my voice' : 'Train my voice';
      }
      if (ui.selfVoiceProgress) {
        // Briefly hold at 100% on success, then collapse.
        setTimeout(() => { if (ui.selfVoiceProgress) ui.selfVoiceProgress.style.width = '0%'; }, 900);
      }
      if (!usingExisting) {
        try { if (tempStream) tempStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { if (tempCtx) tempCtx.close(); } catch (_) {}
      }
      updateSelfVoiceLabels();
    }
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
