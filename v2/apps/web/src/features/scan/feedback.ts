/** A short beep and buzz: the clerk is looking at the box, not the screen. */
let audio: AudioContext | null = null;

export function signal(kind: "ok" | "warn" | "error") {
  try {
    navigator.vibrate?.(kind === "ok" ? 40 : [60, 60, 60]);
  } catch {
    // no vibration motor
  }
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = kind === "ok" ? 1320 : kind === "warn" ? 660 : 330;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (kind === "ok" ? 0.09 : 0.25));
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.3);
  } catch {
    // audio blocked until a tap; the flash still shows
  }
}
