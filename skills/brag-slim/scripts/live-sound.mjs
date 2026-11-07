// Original soundtrack and effects for a composed video, written as one mix on one beat grid.
// Clicks, keystrokes and path steps come from the take logs and snap to sixteenth notes.
import { writeFileSync } from 'node:fs';

const SR = 44100;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

export function makeSoundtrack(spec, takes, file) {
  const n = Math.round(SR * spec.duration);
  const beat = 60 / (spec.music.bpm ?? 120), sixteenth = beat / 4;
  const buses = { musL: new Float32Array(n), musR: new Float32Array(n), fxL: new Float32Array(n), fxR: new Float32Array(n), duck: new Float32Array(n) };
  const add = (bus, start, len, fn, gain, pan = 0) => {
    const s = Math.round(start * SR), L = bus === 'mus' ? buses.musL : buses.fxL, R = bus === 'mus' ? buses.musR : buses.fxR;
    const end = Math.min(n, s + Math.round(len * SR));
    for (let i = Math.max(0, s); i < end; i += 1) {
      const v = fn((i - s) / SR) * gain;
      L[i] += v * (1 - pan * .6);
      R[i] += v * (1 + pan * .6);
    }
  };
  let seed = 11 + (spec.music.root ?? 0);
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 1073741823.5) - 1;
  const kick = (t) => Math.sin(2 * Math.PI * (46 * t + 16 * (1 - Math.exp(-t * 32)))) * Math.exp(-t * 8.5);
  const hat = (t) => noise() * Math.exp(-t * 85);
  const clap = (t) => noise() * (Math.exp(-t * 24) + .5 * Math.exp(-Math.abs(t - .012) * 300));
  const pluck = (f, d = 5.5) => (t) => (Math.sin(2 * Math.PI * f * t) + .4 * Math.sin(4 * Math.PI * f * t) + .12 * Math.sin(6 * Math.PI * f * t)) * Math.min(1, t * 260) * Math.exp(-t * d);
  const bass = (f) => (t) => { const s = Math.sin(2 * Math.PI * f * t); return (s + .35 * Math.tanh(3 * s)) * Math.min(1, t * 90) * Math.exp(-t * 1.6); };
  const pad = (f, len) => (t) => (Math.sin(2 * Math.PI * f * t) + .7 * Math.sin(2 * Math.PI * f * 1.004 * t + 1) + .4 * Math.sin(2 * Math.PI * f * 2 * t)) * Math.min(1, t * 1.8) * Math.min(1, (len - t) * 2.2);
  const root = 57 + (spec.music.root ?? 0);
  const prog = spec.music.mode === 'major' ? [[0, 4, 7], [7, 11, 14], [-3, 0, 4], [5, 9, 12]] : [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]];
  const chord = (t) => prog[Math.floor(t / (beat * 4)) % 4].map((x) => x + root);
  const drop = spec.music.drop ?? 4, end = spec.music.end ?? spec.duration - 2.5;
  const barLen = beat * 4, melody = spec.music.mode === 'major' ? [12, 16, 19, 16, 21, 19, 16, 14] : [12, 15, 19, 15, 22, 19, 15, 14];

  for (let t = 0; t < spec.duration - .01; t += barLen) chord(t).forEach((m, i) => add('mus', t, barLen, pad(hz(m), barLen), t < drop ? .05 : .034, i * .6 - .6));
  const beats = Math.ceil(spec.duration / beat);
  for (let b = 0; b < beats; b += 1) {
    const t = b * beat;
    if (t < drop) {
      add('mus', t, .9, pluck(hz(chord(t)[b % 3] + 12), 3.4), .1, (b % 2) * .6 - .3);
      if (t >= drop - barLen) for (let k = 0; k < 2; k += 1) add('mus', t + k * beat / 2, .06, hat, .025 + (t / drop) * .03, .3);
    } else if (t < end) {
      add('mus', t, .5, kick, .62);
      const s = Math.round(t * SR), len = Math.round(.3 * SR);
      for (let i = 0; i < len && s + i < n; i += 1) buses.duck[s + i] = Math.max(buses.duck[s + i], 1 - i / len);
      if (b % 2 === 1) add('mus', t, .22, clap, .11, -.1);
      for (let k = 0; k < 2; k += 1) add('mus', t + (k + .5) * beat / 2, .07, hat, .05, k ? .35 : -.35);
      add('mus', t, beat * .95, bass(hz(chord(t)[0] - 24)), .24);
      add('mus', t + beat * .75, beat * .25, bass(hz(chord(t)[0] - 12)), .1);
      for (let a = 0; a < 4; a += 1) add('mus', t + a * sixteenth, .3, pluck(hz(chord(t)[a % 3] + 24), 7), .036, a % 2 ? .55 : -.55);
      if (b % 2 === 0) add('mus', t, .8, pluck(hz(root + melody[(b / 2) % 8]), 3.2), .075, .15);
    }
  }
  // Riser into the drop and a resolving hit at the end.
  add('fx', drop - 1.5, 1.5, (x) => noise() * Math.pow(x / 1.5, 3) * .9, .1, 0);
  chord(0).concat(chord(0).map((m) => m + 12), [chord(0)[0] - 12, chord(0)[0] - 24]).forEach((m) => add('mus', end, spec.duration - end, (t) => pluck(hz(m), 1.5)(t) * Math.min(1, (spec.duration - end - t) * 3), .1));
  add('mus', end, 1.1, kick, .7);
  // A whoosh under every shutter wipe.
  for (const sc of spec.scenes) if (sc.s > 0 && sc.wipe !== false) add('fx', sc.s - .22, .46, (t) => noise() * Math.sin(Math.PI * t / .46) ** 2, .1, (sc.s % 1) - .5);
  // Interaction sounds, tuned to the current chord.
  const grid = (t) => Math.round(t / sixteenth) * sixteenth;
  const used = new Set();
  let step = 0;
  for (const sc of spec.scenes) {
    for (const l of sc.layers) {
      if (l.type !== 'clip' || l.sound === false) continue;
      const events = takes[l.take].events;
      for (const e of events) {
        if (!['click', 'key', 'step'].includes(e.type)) continue;
        const t = sc.s + (l.at ?? 0) + (e.t - (l.from ?? 0)) / (l.speed ?? 1);
        if (t < sc.s + .05 || t >= sc.e - .05) continue;
        const g = grid(t), key = `${e.type}${g.toFixed(3)}`;
        if (used.has(key)) continue;
        used.add(key);
        const c = chord(g);
        if (e.type === 'click') add('fx', g, .3, pluck(hz(c[1] + 24), 14), .1, .1);
        else if (e.type === 'key') add('fx', g, .05, (t2) => noise() * Math.exp(-t2 * 130), .05, .2);
        else { add('fx', g, .22, pluck(hz(c[step % 3] + 24 + (step > 8 ? 12 : 0)), 11), .075, step % 2 ? .3 : -.3); step += 1; }
      }
    }
  }
  for (const h of spec.music.hits ?? []) { const c = chord(h); c.forEach((m) => add('fx', h, 1, pluck(hz(m + 24), 4), .05)); add('fx', h, .4, kick, .3); }

  // Mix: music ducks under the kick, a short stereo echo adds space, and a soft limiter catches peaks.
  const outL = new Float32Array(n), outR = new Float32Array(n), delay = Math.round(beat * .75 * SR);
  for (let i = 0; i < n; i += 1) {
    const d = 1 - .42 * buses.duck[i];
    let l = buses.musL[i] * d + buses.fxL[i], r = buses.musR[i] * d + buses.fxR[i];
    if (i >= delay) { l += outR[i - delay] * .16; r += outL[i - delay] * .16; }
    outL[i] = l; outR[i] = r;
  }
  let peak = 0;
  for (let i = 0; i < n; i += 1) { outL[i] = Math.tanh(outL[i] * 1.3); outR[i] = Math.tanh(outR[i] * 1.3); peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i])); }
  const g = .89 / peak, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i += 1) { buf.writeInt16LE(Math.round(outL[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(outR[i] * g * 32767), 46 + i * 4); }
  writeFileSync(file, buf);
}
