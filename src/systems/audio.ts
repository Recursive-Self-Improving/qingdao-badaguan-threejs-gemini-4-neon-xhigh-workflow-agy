import { clamp, smoothstep } from '../world/layout';

export interface AmbientAudioSystem {
  toggle(): boolean;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  update(playerZ: number, windStrength?: number): void;
  dispose(): void;
}

type WebkitAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/**
 * Generates a seamless crossfaded pink/brown noise AudioBuffer for organic waves & sea breeze.
 */
function createSeamlessNoiseBuffer(
  ctx: AudioContext,
  durationSeconds: number,
  character: 'brown' | 'pink'
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(sampleRate, Math.floor(sampleRate * durationSeconds));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.45), Math.floor(length * 0.15));

  for (let ch = 0; ch < 2; ch++) {
    const raw = new Float32Array(length + fadeSamples);

    if (character === 'brown') {
      let lastOut = 0;
      for (let i = 0; i < raw.length; i++) {
        const white = Math.random() * 2 - 1;
        lastOut = (lastOut + 0.025 * white) / 1.025;
        // Mix a touch of white surf texture into the deep brown swell
        raw[i] = lastOut * 2.8 + white * 0.08;
      }
    } else {
      // Paul Kellet's refined pink-noise filter
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < raw.length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }

    // Equal-power crossfade tail into head for click-free looping
    const out = buffer.getChannelData(ch);
    let peak = 0.001;
    for (let i = 0; i < length; i++) {
      let sample = raw[i];
      if (i < fadeSamples) {
        const t = i / fadeSamples;
        sample = sample * Math.sin(t * Math.PI * 0.5) + raw[length + i] * Math.cos(t * Math.PI * 0.5);
      }
      out[i] = sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }

    const norm = 0.72 / peak;
    for (let i = 0; i < length; i++) {
      out[i] *= norm;
    }
  }

  return buffer;
}

/**
 * Procedural Web Audio coastal soundscape for Qingdao Badaguan:
 * - Yellow Sea waves modulated by dual non-harmonic swell LFOs (louder near beach/jetty)
 * - Autumn sea breeze rustling through ginkgo, maple & sycamore leaves
 * - Occasional distant gliding seagull calls echoing softly over the bay
 */
export function createAmbientAudio(): AmbientAudioSystem {
  let ctx: AudioContext | null = null;
  let enabled = false;
  let initialized = false;
  let disposed = false;

  // Core audio nodes
  let masterGain: GainNode | null = null;
  let seaProximityGain: GainNode | null = null;
  let windGain: GainNode | null = null;
  let windFilter: BiquadFilterNode | null = null;
  let gullBusGain: GainNode | null = null;
  let gullEchoDelay: DelayNode | null = null;

  const activeSources: AudioScheduledSourceNode[] = [];

  // Runtime state for dynamic modulation & distant seagull scheduling
  let currentPlayerZ = -34;
  let currentWind = 1.0;
  let lastUpdateMs = 0;
  let nextGullCountdown = 6.5 + Math.random() * 6.0;

  function ensureGraph(): boolean {
    if (disposed) return false;
    if (initialized && ctx) return true;

    try {
      const AudioCtor =
        window.AudioContext || (window as WebkitAudioWindow).webkitAudioContext;
      if (!AudioCtor) return false;

      ctx = new AudioCtor();

      masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      masterGain.connect(ctx.destination);

      // ----------------------------------------------------------------------
      // 1. Yellow Sea Ocean Waves (Deep Swell + Soft Shore Foam Shimmer)
      // ----------------------------------------------------------------------
      const brownBuffer = createSeamlessNoiseBuffer(ctx, 6.5, 'brown');
      const pinkBuffer = createSeamlessNoiseBuffer(ctx, 5.5, 'pink');

      seaProximityGain = ctx.createGain();
      seaProximityGain.gain.setValueAtTime(0.35, ctx.currentTime);
      seaProximityGain.connect(masterGain);

      // Deep rolling tide swell
      const waveSource = ctx.createBufferSource();
      waveSource.buffer = brownBuffer;
      waveSource.loop = true;

      const waveFilter = ctx.createBiquadFilter();
      waveFilter.type = 'lowpass';
      waveFilter.frequency.setValueAtTime(360, ctx.currentTime);
      waveFilter.Q.setValueAtTime(0.85, ctx.currentTime);

      const waveGain = ctx.createGain();
      waveGain.gain.setValueAtTime(0.46, ctx.currentTime);

      // Dual slow non-harmonic LFOs for organic Yellow Sea wave rhythm
      const lfoPrimary = ctx.createOscillator();
      lfoPrimary.type = 'sine';
      lfoPrimary.frequency.setValueAtTime(0.105, ctx.currentTime); // ~9.5s period

      const lfoPrimaryFreqDepth = ctx.createGain();
      lfoPrimaryFreqDepth.gain.setValueAtTime(195, ctx.currentTime);
      lfoPrimary.connect(lfoPrimaryFreqDepth);
      lfoPrimaryFreqDepth.connect(waveFilter.frequency);

      const lfoPrimaryAmpDepth = ctx.createGain();
      lfoPrimaryAmpDepth.gain.setValueAtTime(0.14, ctx.currentTime);
      lfoPrimary.connect(lfoPrimaryAmpDepth);
      lfoPrimaryAmpDepth.connect(waveGain.gain);

      const lfoSecondary = ctx.createOscillator();
      lfoSecondary.type = 'sine';
      lfoSecondary.frequency.setValueAtTime(0.067, ctx.currentTime); // ~14.9s harmonic beat

      const lfoSecondaryFreqDepth = ctx.createGain();
      lfoSecondaryFreqDepth.gain.setValueAtTime(115, ctx.currentTime);
      lfoSecondary.connect(lfoSecondaryFreqDepth);
      lfoSecondaryFreqDepth.connect(waveFilter.frequency);

      waveSource.connect(waveFilter);
      waveFilter.connect(waveGain);
      waveGain.connect(seaProximityGain);

      // Subtle receding surf foam hiss
      const foamSource = ctx.createBufferSource();
      foamSource.buffer = pinkBuffer;
      foamSource.loop = true;

      const foamFilter = ctx.createBiquadFilter();
      foamFilter.type = 'bandpass';
      foamFilter.frequency.setValueAtTime(1480, ctx.currentTime);
      foamFilter.Q.setValueAtTime(1.15, ctx.currentTime);

      const foamGain = ctx.createGain();
      foamGain.gain.setValueAtTime(0.055, ctx.currentTime);

      const foamLfo = ctx.createOscillator();
      foamLfo.type = 'sine';
      foamLfo.frequency.setValueAtTime(0.105, ctx.currentTime);
      const foamLfoDepth = ctx.createGain();
      foamLfoDepth.gain.setValueAtTime(0.04, ctx.currentTime);
      foamLfo.connect(foamLfoDepth);
      foamLfoDepth.connect(foamGain.gain);

      foamSource.connect(foamFilter);
      foamFilter.connect(foamGain);
      foamGain.connect(seaProximityGain);

      // ----------------------------------------------------------------------
      // 2. Sea Breeze Rustling Through Autumn Ginkgo & Sycamore Leaves
      // ----------------------------------------------------------------------
      const windSource = ctx.createBufferSource();
      windSource.buffer = pinkBuffer;
      windSource.loop = true;

      windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.setValueAtTime(760, ctx.currentTime);
      windFilter.Q.setValueAtTime(1.1, ctx.currentTime);

      const windSoftCap = ctx.createBiquadFilter();
      windSoftCap.type = 'lowpass';
      windSoftCap.frequency.setValueAtTime(2200, ctx.currentTime);

      windGain = ctx.createGain();
      windGain.gain.setValueAtTime(0.12, ctx.currentTime);

      const windLfo = ctx.createOscillator();
      windLfo.type = 'sine';
      windLfo.frequency.setValueAtTime(0.082, ctx.currentTime);

      const windFreqMod = ctx.createGain();
      windFreqMod.gain.setValueAtTime(240, ctx.currentTime);
      windLfo.connect(windFreqMod);
      windFreqMod.connect(windFilter.frequency);

      const windAmpMod = ctx.createGain();
      windAmpMod.gain.setValueAtTime(0.042, ctx.currentTime);
      windLfo.connect(windAmpMod);
      windAmpMod.connect(windGain.gain);

      windSource.connect(windFilter);
      windFilter.connect(windSoftCap);
      windSoftCap.connect(windGain);
      windGain.connect(masterGain);

      // ----------------------------------------------------------------------
      // 3. Distant Seagull Echo Bus
      // ----------------------------------------------------------------------
      gullBusGain = ctx.createGain();
      gullBusGain.gain.setValueAtTime(0.75, ctx.currentTime);

      gullEchoDelay = ctx.createDelay(1.0);
      gullEchoDelay.delayTime.setValueAtTime(0.28, ctx.currentTime);

      const gullEchoFeedback = ctx.createGain();
      gullEchoFeedback.gain.setValueAtTime(0.26, ctx.currentTime);

      const gullEchoTone = ctx.createBiquadFilter();
      gullEchoTone.type = 'lowpass';
      gullEchoTone.frequency.setValueAtTime(1500, ctx.currentTime);

      gullBusGain.connect(masterGain);
      gullBusGain.connect(gullEchoDelay);
      gullEchoDelay.connect(gullEchoTone);
      gullEchoTone.connect(gullEchoFeedback);
      gullEchoFeedback.connect(gullEchoDelay);
      gullEchoTone.connect(masterGain);

      // Start all continuous nodes
      const now = ctx.currentTime;
      waveSource.start(now);
      foamSource.start(now + 1.1);
      windSource.start(now + 0.5);
      lfoPrimary.start(now);
      lfoSecondary.start(now);
      foamLfo.start(now + 1.8);
      windLfo.start(now);

      activeSources.push(
        waveSource,
        foamSource,
        windSource,
        lfoPrimary,
        lfoSecondary,
        foamLfo,
        windLfo
      );

      initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  function triggerDistantSeagullCall(): void {
    if (!ctx || !gullBusGain || !enabled || ctx.state !== 'running') return;

    try {
      const coastalPresence = smoothstep(-22, 42, currentPlayerZ);
      if (coastalPresence < 0.08) return;

      const baseNow = ctx.currentTime + 0.04;
      const callCount = Math.random() < 0.58 ? 2 : 1;
      const panValue = (Math.random() - 0.5) * 1.35;

      for (let c = 0; c < callCount; c++) {
        const start = baseNow + c * (0.42 + Math.random() * 0.2);
        const dur = 0.28 + Math.random() * 0.16;
        const baseFreq = 1480 + Math.random() * 440;
        const peakFreq = baseFreq * (1.16 + Math.random() * 0.12);
        const endFreq = baseFreq * (0.68 + Math.random() * 0.09);

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(baseFreq, start);
        osc.frequency.exponentialRampToValueAtTime(peakFreq, start + dur * 0.26);
        osc.frequency.exponentialRampToValueAtTime(endFreq, start + dur);

        // Subtle avian FM warble
        const vib = ctx.createOscillator();
        vib.type = 'sine';
        vib.frequency.setValueAtTime(17 + Math.random() * 7, start);
        const vibGain = ctx.createGain();
        vibGain.gain.setValueAtTime(24, start);
        vib.connect(vibGain);
        vibGain.connect(osc.frequency);

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(baseFreq * 1.05, start);
        filter.Q.setValueAtTime(1.8, start);

        const env = ctx.createGain();
        const peakVol = (0.016 + coastalPresence * 0.032) * (c === 0 ? 1.0 : 0.72);
        env.gain.setValueAtTime(0.0001, start);
        env.gain.linearRampToValueAtTime(peakVol, start + dur * 0.18);
        env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

        osc.connect(filter);
        filter.connect(env);

        if (typeof ctx.createStereoPanner === 'function') {
          const panner = ctx.createStereoPanner();
          panner.pan.setValueAtTime(clamp(panValue, -0.8, 0.8), start);
          env.connect(panner);
          panner.connect(gullBusGain);
        } else {
          env.connect(gullBusGain);
        }

        osc.start(start);
        vib.start(start);
        osc.stop(start + dur + 0.05);
        vib.stop(start + dur + 0.05);
      }
    } catch {
      // Never allow audio synth glitch to disrupt frame loop
    }
  }

  function applySpatialMix(): void {
    if (!ctx || !seaProximityGain || !windGain || !windFilter) return;

    const now = ctx.currentTime;
    // Waves swell louder as player approaches Shanhaiguan Rd (Z~29), Second Bathing Beach, & Stone Jetty
    const coastFactor = smoothstep(-48, 54, currentPlayerZ);
    const waveTarget = 0.16 + coastFactor * 0.86;
    seaProximityGain.gain.setTargetAtTime(waveTarget, now, 0.35);

    // Autumn sea breeze scales subtly with atmosphere windStrength
    const safeWind = clamp(currentWind, 0.35, 1.8);
    windGain.gain.setTargetAtTime(0.075 + safeWind * 0.065, now, 0.45);
    windFilter.frequency.setTargetAtTime(620 + safeWind * 210, now, 0.6);
  }

  function setEnabled(nextEnabled: boolean): void {
    if (disposed) return;

    if (nextEnabled) {
      if (!ensureGraph() || !ctx || !masterGain) {
        enabled = false;
        return;
      }
      enabled = true;
      try {
        if (ctx.state === 'suspended') {
          void ctx.resume();
        }
        masterGain.gain.setTargetAtTime(0.84, ctx.currentTime, 0.45);
        applySpatialMix();
        lastUpdateMs = performance.now();
      } catch {
        enabled = false;
      }
    } else {
      enabled = false;
      if (ctx && masterGain) {
        try {
          masterGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.28);
        } catch {
          // Ignore
        }
      }
    }
  }

  function toggle(): boolean {
    setEnabled(!enabled);
    return enabled;
  }

  function update(playerZ: number, windStrength = 1.0): void {
    currentPlayerZ = playerZ;
    currentWind = windStrength;

    if (!enabled || !ctx || !initialized) return;

    applySpatialMix();

    const nowMs = performance.now();
    const dtSec = lastUpdateMs > 0 ? Math.min((nowMs - lastUpdateMs) / 1000, 0.5) : 0.016;
    lastUpdateMs = nowMs;

    nextGullCountdown -= dtSec;
    if (nextGullCountdown <= 0) {
      triggerDistantSeagullCall();
      nextGullCountdown = 8.0 + Math.random() * 10.0;
    }
  }

  return {
    toggle,
    setEnabled,
    isEnabled: () => enabled,
    update,
    dispose() {
      disposed = true;
      enabled = false;
      for (const node of activeSources) {
        try {
          node.stop();
        } catch {
          // Ignore already stopped sources
        }
      }
      activeSources.length = 0;
      if (ctx) {
        void ctx.close().catch(() => {
          // Ignore close error
        });
        ctx = null;
      }
      initialized = false;
    }
  };
}
