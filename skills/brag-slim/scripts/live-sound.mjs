// Original soundtrack and effects for a composed video, written as one mix on one beat grid.
// Clicks, keystrokes and path steps come from the take logs and snap to sixteenth notes.
// spec.music.file replaces the tone's palette bed. spec.music.regions slices that file onto the timeline.
// Without regions the file loops from the start. spec.music.density selects the synth bed when no file plays.
// spec.music.off skips the bed. spec.sfx === false skips effects. The wav is always spec.duration long.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const decoded = new Map();

function resolveAssets() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (process.env.BRAG_ASSETS) candidates.push(process.env.BRAG_ASSETS);
  candidates.push(resolve(here, '../../brag/assets'));
  for (const dir of candidates) {
    if (existsSync(join(dir, 'palette.json'))) return dir;
  }
  return null;
}

function readPalette(dir) {
  try {
    const data = JSON.parse(readFileSync(join(dir, 'palette.json'), 'utf8'));
    data.dir = dir;
    return data;
  } catch {
    return null;
  }
}

function decodeStereo(file, duration, loop) {
  const key = `${file}|${duration ?? ''}|${loop ? 1 : 0}`;
  if (decoded.has(key)) return decoded.get(key);
  if (!existsSync(file)) {
    decoded.set(key, null);
    return null;
  }
  const args = ['-v', 'error'];
  if (loop) args.push('-stream_loop', '-1');
  args.push('-i', file);
  if (duration != null) args.push('-t', String(duration));
  args.push('-f', 'f32le', '-ac', '2', '-ar', String(SR), 'pipe:1');
  let result;
  try {
    result = spawnSync('ffmpeg', args, { maxBuffer: 256 * 1024 * 1024 });
  } catch {
    decoded.set(key, null);
    return null;
  }
  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length < 8) {
    decoded.set(key, null);
    return null;
  }
  decoded.set(key, result.stdout);
  return result.stdout;
}

function mixStereo(buses, bus, start, pcm, amount, pan, n) {
  const L = bus === 'mus' ? buses.musL : buses.fxL;
  const R = bus === 'mus' ? buses.musR : buses.fxR;
  const s = Math.round(start * SR);
  const frames = Math.floor(pcm.length / 8);
  const left = amount * (1 - pan * 0.6);
  const right = amount * (1 + pan * 0.6);
  for (let i = 0; i < frames; i += 1) {
    const idx = s + i;
    if (idx < 0 || idx >= n) continue;
    L[idx] += pcm.readFloatLE(i * 8) * left;
    R[idx] += pcm.readFloatLE(i * 8 + 4) * right;
  }
}

function layRegions(buses, pcm, regions, amount, n) {
  const frames = Math.floor(pcm.length / 8);
  for (const region of regions) {
    const dst = Math.round((region.at ?? 0) * SR);
    const src = Math.round((region.start ?? 0) * SR);
    const count = Math.round((region.dur ?? 0) * SR);
    for (let i = 0; i < count; i += 1) {
      const from = src + i;
      const to = dst + i;
      if (from < 0 || from >= frames || to < 0 || to >= n) continue;
      buses.musL[to] += pcm.readFloatLE(from * 8) * amount;
      buses.musR[to] += pcm.readFloatLE(from * 8 + 4) * amount;
    }
  }
}

function wavHeader(buf, n) {
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
}

function writeWav(file, left, right, n, gain) {
  const buf = Buffer.alloc(44 + n * 4);
  wavHeader(buf, n);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i] * gain)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i] * gain)) * 32767), 46 + i * 4);
  }
  writeFileSync(file, buf);
}

function loudnormStats(stderr) {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const stats = JSON.parse(stderr.slice(start, end + 1));
    for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
      if (!Number.isFinite(parseFloat(stats[key]))) return null;
    }
    return stats;
  } catch {
    return null;
  }
}

function loudnormWav(file, n) {
  const measured = spawnSync('ffmpeg', [
    '-hide_banner', '-i', file,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const stats = loudnormStats(`${measured.stderr ?? ''}\n${measured.stdout ?? ''}`);
  if (!stats) return false;
  const raw = `${file}.norm.raw`;
  const num = (value) => String(parseFloat(value));
  const filter = [
    'loudnorm=I=-14:TP=-1.5:LRA=11',
    `measured_I=${num(stats.input_i)}`,
    `measured_TP=${num(stats.input_tp)}`,
    `measured_LRA=${num(stats.input_lra)}`,
    `measured_thresh=${num(stats.input_thresh)}`,
    `offset=${num(stats.target_offset)}`,
    'linear=true',
  ].join(':');
  const applied = spawnSync('ffmpeg', [
    '-hide_banner', '-y', '-i', file,
    '-af', filter,
    '-f', 's16le', '-ac', '2', '-ar', String(SR),
    raw,
  ]);
  if (applied.error || applied.status !== 0 || !existsSync(raw)) {
    rmSync(raw, { force: true });
    return false;
  }
  const pcm = readFileSync(raw);
  rmSync(raw, { force: true });
  const frames = Math.floor(pcm.length / 4);
  if (frames < 1) return false;
  const buf = Buffer.alloc(44 + n * 4);
  wavHeader(buf, n);
  pcm.copy(buf, 44, 0, Math.min(frames, n) * 4);
  writeFileSync(file, buf);
  return true;
}

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

export function makeSoundtrack(spec, takes, file) {
  const n = Math.round(SR * spec.duration);
  const music = spec.music ?? {};
  const gain = music.gain ?? 1;
  const sfxGain = Math.min(1, gain);
  const musicOn = music.off !== true && spec.noMusic !== true;
  const sfxOn = spec.sfx !== false && spec.noSfx !== true;
  const density = music.density ?? 'full';
  const assets = resolveAssets();
  const palette = assets ? readPalette(assets) : null;
  const regions = Array.isArray(music.regions) ? music.regions : [];
  const fileOverride = musicOn && Boolean(music.file);
  let bedInfo = null;
  let bedPcm = null;
  if (fileOverride) {
    bedPcm = regions.length ? decodeStereo(music.file, null, false) : decodeStereo(music.file, spec.duration, true);
    bedInfo = { file: music.file, bpm: music.bpm, downbeat: music.downbeat ?? 0 };
  } else if (musicOn && palette?.beds?.[spec.tone]) {
    bedInfo = palette.beds[spec.tone];
    bedPcm = decodeStereo(join(palette.dir, bedInfo.file), spec.duration, true);
  }
  const bedFrames = bedPcm ? Math.floor(bedPcm.length / 8) : 0;
  const useBed = fileOverride
    ? bedFrames > 0
    : bedFrames >= n - Math.round(SR / 10);
  const beat = 60 / (useBed ? (bedInfo.bpm || music.bpm || 120) : (music.bpm ?? 120));
  const sixteenth = beat / 4;
  const phase = useBed ? (bedInfo.downbeat ?? 0) : 0;
  const buses = { musL: new Float32Array(n), musR: new Float32Array(n), fxL: new Float32Array(n), fxR: new Float32Array(n), duck: new Float32Array(n) };
  const add = (bus, start, len, fn, amount, pan = 0) => {
    const s = Math.round(start * SR);
    const L = bus === 'mus' ? buses.musL : buses.fxL;
    const R = bus === 'mus' ? buses.musR : buses.fxR;
    const end = Math.min(n, s + Math.round(len * SR));
    for (let i = Math.max(0, s); i < end; i += 1) {
      const v = fn((i - s) / SR) * amount;
      L[i] += v * (1 - pan * 0.6);
      R[i] += v * (1 + pan * 0.6);
    }
  };
  let seed = 11 + (music.root ?? 0);
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 1073741823.5) - 1;
  const kick = (t) => Math.sin(2 * Math.PI * (46 * t + 16 * (1 - Math.exp(-t * 32)))) * Math.exp(-t * 8.5);
  const hat = (t) => noise() * Math.exp(-t * 85);
  const clap = (t) => noise() * (Math.exp(-t * 24) + 0.5 * Math.exp(-Math.abs(t - 0.012) * 300));
  const pluck = (f, d = 5.5) => (t) => (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t)) * Math.min(1, t * 260) * Math.exp(-t * d);
  const bass = (f) => (t) => { const s = Math.sin(2 * Math.PI * f * t); return (s + 0.35 * Math.tanh(3 * s)) * Math.min(1, t * 90) * Math.exp(-t * 1.6); };
  const pad = (f, len) => (t) => (Math.sin(2 * Math.PI * f * t) + 0.7 * Math.sin(2 * Math.PI * f * 1.004 * t + 1) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t)) * Math.min(1, t * 1.8) * Math.min(1, (len - t) * 2.2);
  const root = 57 + (music.root ?? 0);
  const prog = music.mode === 'major' ? [[0, 4, 7], [7, 11, 14], [-3, 0, 4], [5, 9, 12]] : [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]];
  const chord = (t) => prog[Math.floor(t / (beat * 4)) % 4].map((x) => x + root);
  const drop = music.drop ?? 4;
  const end = music.end ?? spec.duration - 2.5;
  const barLen = beat * 4;
  const melody = music.mode === 'major' ? [12, 16, 19, 16, 21, 19, 16, 14] : [12, 15, 19, 15, 22, 19, 15, 14];
  const beats = Math.ceil(spec.duration / beat);
  const mus = (start, len, fn, amount, pan) => add('mus', start, len, fn, amount * gain, pan);

  if (useBed && regions.length && fileOverride) {
    layRegions(buses, bedPcm, regions, gain * 0.75, n);
  } else if (useBed) {
    mixStereo(buses, 'mus', 0, bedPcm, gain * 0.75, 0, n);
  } else if (musicOn && density === 'sparse') {
    for (let t = 0; t < spec.duration - 0.01; t += barLen) chord(t).forEach((m, i) => mus(t, barLen, pad(hz(m), barLen), 0.04, i * 0.6 - 0.6));
    for (let b = 0; b < beats; b += 1) {
      const t = b * beat;
      if (t >= end) break;
      if (b % 4 === 0) {
        mus(t, 0.5, kick, 0.22);
        mus(t, 0.9, pluck(hz(chord(t)[0] + 12), 2.2), 0.06, 0.1);
      }
    }
  } else if (musicOn && density === 'dry') {
    for (let t = 0; t < spec.duration - 0.01; t += barLen) chord(t).forEach((m, i) => mus(t, barLen, pad(hz(m), barLen), 0.018, i * 0.4 - 0.4));
    for (let b = 0; b < beats; b += 1) {
      const t = b * beat;
      if (t >= end) break;
      if (b % 2 === 0) mus(t, 0.4, kick, 0.16);
    }
  } else if (musicOn && density === 'dense') {
    for (let t = 0; t < spec.duration - 0.01; t += barLen) chord(t).forEach((m, i) => mus(t, barLen, pad(hz(m), barLen), 0.03, i * 0.6 - 0.6));
    for (let b = 0; b < beats; b += 1) {
      const t = b * beat;
      if (t < drop) {
        mus(t, 0.7, pluck(hz(chord(t)[b % 3] + 12), 3.4), 0.12, (b % 2) * 0.6 - 0.3);
      } else if (t < end) {
        mus(t, 0.45, kick, 0.7);
        mus(t, 0.2, clap, 0.14, -0.1);
        mus(t, beat * 0.95, bass(hz(chord(t)[0] - 24)), 0.28);
        for (let a = 0; a < 4; a += 1) {
          mus(t + a * sixteenth, 0.08, hat, 0.07, a % 2 ? 0.4 : -0.4);
          mus(t + a * sixteenth, 0.25, pluck(hz(chord(t)[a % 3] + 24), 8), 0.05, a % 2 ? 0.5 : -0.5);
        }
        mus(t, 0.6, pluck(hz(root + melody[b % 8]), 3.2), 0.08, 0.15);
      }
    }
    add('fx', drop - 1.2, 1.2, (x) => noise() * Math.pow(x / 1.2, 3) * 0.9, 0.12 * sfxGain, 0);
    mus(end, 1.1, kick, 0.75);
  } else if (musicOn && density === 'swell') {
    for (let t = 0; t < spec.duration - 0.01; t += barLen) {
      const swell = 0.02 + 0.09 * (t / spec.duration);
      chord(t).forEach((m, i) => mus(t, barLen * 1.05, pad(hz(m), barLen), swell, i * 0.7 - 0.7));
    }
    for (let b = 0; b < beats; b += 2) {
      const t = b * beat;
      if (t >= end) break;
      mus(t, 1.4, pluck(hz(root + melody[(b / 2) % 8] + 12), 1.6), 0.05, 0.2);
    }
    mus(end, 1.4, kick, 0.4);
  } else if (musicOn && density === 'clean') {
    for (let t = 0; t < spec.duration - 0.01; t += barLen) chord(t).forEach((m, i) => mus(t, barLen, pad(hz(m), barLen), 0.03, i * 0.5 - 0.5));
    for (let b = 0; b < beats; b += 1) {
      const t = b * beat;
      if (t >= end) break;
      if (b % 2 === 0) mus(t, 0.45, kick, 0.4);
      mus(t + beat / 2, 0.07, hat, 0.03, 0.3);
      mus(t, beat * 0.9, bass(hz(chord(t)[0] - 24)), 0.16);
      if (b % 4 === 0) mus(t, 0.8, pluck(hz(chord(t)[0] + 12), 3), 0.07, 0.1);
    }
  } else if (musicOn) {
    for (let t = 0; t < spec.duration - 0.01; t += barLen) chord(t).forEach((m, i) => mus(t, barLen, pad(hz(m), barLen), t < drop ? 0.05 : 0.034, i * 0.6 - 0.6));
    for (let b = 0; b < beats; b += 1) {
      const t = b * beat;
      if (t < drop) {
        mus(t, 0.9, pluck(hz(chord(t)[b % 3] + 12), 3.4), 0.1, (b % 2) * 0.6 - 0.3);
        if (t >= drop - barLen) for (let k = 0; k < 2; k += 1) mus(t + k * beat / 2, 0.06, hat, 0.025 + (t / drop) * 0.03, 0.3);
      } else if (t < end) {
        mus(t, 0.5, kick, 0.62);
        const s = Math.round(t * SR);
        const len = Math.round(0.3 * SR);
        for (let i = 0; i < len && s + i < n; i += 1) buses.duck[s + i] = Math.max(buses.duck[s + i], 1 - i / len);
        if (b % 2 === 1) mus(t, 0.22, clap, 0.11, -0.1);
        for (let k = 0; k < 2; k += 1) mus(t + (k + 0.5) * beat / 2, 0.07, hat, 0.05, k ? 0.35 : -0.35);
        mus(t, beat * 0.95, bass(hz(chord(t)[0] - 24)), 0.24);
        mus(t + beat * 0.75, beat * 0.25, bass(hz(chord(t)[0] - 12)), 0.1);
        for (let a = 0; a < 4; a += 1) mus(t + a * sixteenth, 0.3, pluck(hz(chord(t)[a % 3] + 24), 7), 0.036, a % 2 ? 0.55 : -0.55);
        if (b % 2 === 0) mus(t, 0.8, pluck(hz(root + melody[(b / 2) % 8]), 3.2), 0.075, 0.15);
      }
    }
    add('fx', Math.max(0, drop - 1.5), Math.min(1.5, drop), (x) => noise() * Math.pow(x / 1.5, 3) * 0.9, 0.1 * sfxGain, 0);
    chord(0).concat(chord(0).map((m) => m + 12), [chord(0)[0] - 12, chord(0)[0] - 24]).forEach((m) => mus(end, spec.duration - end, (t) => pluck(hz(m), 1.5)(t) * Math.min(1, (spec.duration - end - t) * 3), 0.1));
    mus(end, 1.1, kick, 0.7);
  }

  if (musicOn) {
    for (const h of music.hits ?? []) {
      const c = chord(h);
      c.forEach((m) => add('fx', h, 1, pluck(hz(m + 24), 4), 0.05 * sfxGain));
      add('fx', h, 0.4, kick, 0.3 * sfxGain);
    }
  }

  if (sfxOn) {
    for (const sc of spec.scenes ?? []) {
      if (sc.s > 0 && (sc.wipe === 'shutter' || sc.wipe === 'dip' || sc.wipe === 'fade')) {
        add('fx', sc.s - 0.22, 0.46, (t) => noise() * Math.sin(Math.PI * t / 0.46) ** 2, 0.1 * sfxGain, (sc.s % 1) - 0.5);
      }
    }
    const grid = (t) => Math.max(0, phase + Math.round((t - phase) / sixteenth) * sixteenth);
    const used = new Set();
    let step = 0;
    for (const sc of spec.scenes ?? []) {
      for (const l of sc.layers ?? []) {
        if (l.type !== 'clip' || l.sound === false) continue;
        const events = takes?.[l.take]?.events;
        if (!events) continue;
        for (const e of events) {
          if (!['click', 'key', 'step'].includes(e.type)) continue;
          const t = sc.s + (l.at ?? 0) + (e.t - (l.from ?? 0)) / (l.speed ?? 1);
          if (t < sc.s + 0.05 || t >= sc.e - 0.05) continue;
          const g = grid(t);
          const key = `${e.type}${g.toFixed(3)}`;
          if (used.has(key)) continue;
          used.add(key);
          const c = chord(g);
          if (e.type === 'click') add('fx', g, 0.3, pluck(hz(c[1] + 24), 14), 0.1 * sfxGain, 0.1);
          else if (e.type === 'key') add('fx', g, 0.05, (t2) => noise() * Math.exp(-t2 * 130), 0.05 * sfxGain, 0.2);
          else { add('fx', g, 0.22, pluck(hz(c[step % 3] + 24 + (step > 8 ? 12 : 0)), 11), 0.075 * sfxGain, step % 2 ? 0.3 : -0.3); step += 1; }
        }
      }
    }
  }

  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const delay = Math.round(beat * 0.75 * SR);
  for (let i = 0; i < n; i += 1) {
    const d = 1 - 0.42 * buses.duck[i];
    let l = buses.musL[i] * d + buses.fxL[i];
    let r = buses.musR[i] * d + buses.fxR[i];
    if (i >= delay) { l += outR[i - delay] * 0.16; r += outL[i - delay] * 0.16; }
    outL[i] = l;
    outR[i] = r;
  }
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    outL[i] = Math.tanh(outL[i] * 1.3);
    outR[i] = Math.tanh(outR[i] * 1.3);
    peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  }
  const g = peak > 0.0001 ? 0.89 / peak : 1;
  const bedL = new Float32Array(n);
  const bedR = new Float32Array(n);
  const sfxL = new Float32Array(n);
  const sfxR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const ducked = 1 - 0.42 * buses.duck[i];
    bedL[i] = Math.tanh(buses.musL[i] * ducked * 1.3);
    bedR[i] = Math.tanh(buses.musR[i] * ducked * 1.3);
    sfxL[i] = Math.tanh(buses.fxL[i] * 1.3);
    sfxR[i] = Math.tanh(buses.fxR[i] * 1.3);
  }
  const dir = dirname(file);
  writeWav(join(dir, 'bed.wav'), bedL, bedR, n, g);
  writeWav(join(dir, 'sfx.wav'), sfxL, sfxR, n, g);
  writeWav(file, outL, outR, n, g);
  if (peak > 0.0001) loudnormWav(file, n);
  return { samples: n, sampleRate: SR, bed: useBed ? bedInfo.file : null };
}
