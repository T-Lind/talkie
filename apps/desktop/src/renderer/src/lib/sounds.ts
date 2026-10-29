export type SoundName = 'raise' | 'lower' | 'join' | 'turn' | 'welcome' | 'error';

interface Tone {
  freq: number;
  at: number;
  dur: number;
  gain?: number;
  type?: OscillatorType;
}

const SEQUENCES: Record<SoundName, Tone[]> = {
  raise: [
    { freq: 523.25, at: 0, dur: 0.16, gain: 0.045 },
    { freq: 783.99, at: 0.07, dur: 0.22, gain: 0.04 },
  ],
  lower: [
    { freq: 659.25, at: 0, dur: 0.12, gain: 0.03 },
    { freq: 440, at: 0.06, dur: 0.18, gain: 0.028 },
  ],
  join: [
    { freq: 392, at: 0, dur: 0.16, gain: 0.03 },
    { freq: 587.33, at: 0.09, dur: 0.26, gain: 0.03 },
  ],
  turn: [
    { freq: 523.25, at: 0, dur: 0.16, gain: 0.04 },
    { freq: 659.25, at: 0.09, dur: 0.18, gain: 0.042 },
    { freq: 987.77, at: 0.18, dur: 0.4, gain: 0.045 },
  ],
  welcome: [
    { freq: 440, at: 0, dur: 0.2, gain: 0.035 },
    { freq: 554.37, at: 0.09, dur: 0.22, gain: 0.035 },
    { freq: 659.25, at: 0.18, dur: 0.42, gain: 0.04 },
  ],
  error: [
    { freq: 220, at: 0, dur: 0.18, gain: 0.03, type: 'triangle' },
  ],
};

let context: AudioContext | null = null;
let unlocked = false;

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  if (!context) {
    try {
      context = new AudioCtor();
    } catch {
      return null;
    }
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

export function primeAudio(): void {
  if (unlocked) return;
  const ctx = ensureContext();
  if (!ctx) return;
  unlocked = true;
  if (ctx.state === 'suspended') void ctx.resume();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', primeAudio, { once: true, capture: true });
  window.addEventListener('keydown', primeAudio, { once: true, capture: true });
}

let lastPlayed: { name: SoundName; at: number } = { name: 'welcome', at: 0 };

export function playSound(name: SoundName): void {
  const nowMs = performance.now();
  if (lastPlayed.name === name && nowMs - lastPlayed.at < 280) return;
  lastPlayed = { name, at: nowMs };

  const ctx = ensureContext();
  if (!ctx) return;
  const sequence = SEQUENCES[name];
  const start = ctx.currentTime + 0.01;

  for (const tone of sequence) {
    const at = start + tone.at;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = tone.type ?? 'sine';
    oscillator.frequency.setValueAtTime(tone.freq, at);
    // A whisper of upward drift keeps the chimes from sounding synthetic.
    oscillator.detune.setValueAtTime(0, at);
    oscillator.detune.linearRampToValueAtTime(3, at + tone.dur);

    const peak = tone.gain ?? 0.03;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.dur);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + tone.dur + 0.05);
  }
}
