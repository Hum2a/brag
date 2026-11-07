// Render a spec.json trailer.
//
//   node render.mjs spec.json --stills
//   node render.mjs spec.json
//   node render.mjs spec.json --pack
//   node render.mjs spec.json --gif --webm --thumbs
//   node render.mjs spec.json --platform reels
//   node render.mjs spec.json --playwright path/to/playwright
//
// --stills validates, shoots a settled frame of every scene plus each cut, and writes work/contact.jpg.
// A full run writes brag.mp4, bakes the poster as frame 0, writes brag.jpg and brag.srt, and mixes
// voiceover.wav when one is sitting next to the spec. --pack also renders the other two formats.
// --platform reels|tiktok, on a vertical master, writes a 1080x1920 encode with captions raised
// and loudness at -14 LUFS. --gif and --webm cut a silent hook on a beat at or under 6s.
// --thumbs writes two stills and does not draw text.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose } from './live-compose.mjs';
import { FORMATS, loopHoldPad, platformPreset, prepareSpec, reflow, stillTimes, thumbTimes, toSrt, trimPoint, validateSpec } from './spec.mjs';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  let spec = null;
  let playwright = null;
  let platform = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--playwright') { playwright = argv[i + 1] ?? null; i += 1; continue; }
    if (argv[i] === '--platform') { platform = argv[i + 1] ?? null; i += 1; continue; }
    if (argv[i].startsWith('--')) continue;
    spec = argv[i];
  }
  return {
    spec,
    playwright,
    platform,
    stills: argv.includes('--stills'),
    pack: argv.includes('--pack'),
    gif: argv.includes('--gif'),
    webm: argv.includes('--webm'),
    thumbs: argv.includes('--thumbs'),
    askedPlatform: argv.includes('--platform'),
  };
}

function findPlaywright(flag) {
  if (flag) return flag;
  if (process.env.BRAG_PLAYWRIGHT) return process.env.BRAG_PLAYWRIGHT;
  try { return require.resolve('playwright'); } catch { return null; }
}

function findVoice(dir) {
  for (const rel of [['assets', 'voiceover.wav'], ['voiceover.wav']]) {
    const path = join(dir, ...rel);
    if (existsSync(path)) return path;
  }
  return null;
}

function readDuration(log) {
  const match = String(log).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return ((+match[1]) * 60 + +match[2]) * 60 + +match[3];
}

function speechSpans(log) {
  const duration = readDuration(log);
  const silence = [];
  let open = null;
  const re = /silence_start:\s*([0-9.]+)|silence_end:\s*([0-9.]+)/g;
  let match;
  while ((match = re.exec(log))) {
    if (match[1] != null) open = parseFloat(match[1]);
    else if (match[2] != null) {
      silence.push({ start: open ?? 0, end: parseFloat(match[2]) });
      open = null;
    }
  }
  const end = duration ?? (open == null ? null : open);
  if (open != null && end != null) silence.push({ start: open, end });
  if (end == null) return [{ start: 0, end: 86400 }];
  const speech = [];
  let cursor = 0;
  for (const gap of silence) {
    const s = Math.max(0, gap.start);
    const e = Math.min(end, Math.max(gap.end, s));
    if (s > cursor + 0.001) speech.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (cursor < end - 0.001) speech.push({ start: cursor, end });
  return speech;
}

function bedVolume(spans) {
  if (!spans.length) return '1';
  const pieces = spans.map((span) => {
    const fade = Math.min(0.08, Math.max(0, span.end - span.start) / 2);
    const s = span.start.toFixed(4);
    const e = span.end.toFixed(4);
    if (fade < 0.001) return `between(t\\,${s}\\,${e})`;
    const s1 = (span.start + fade).toFixed(4);
    const e0 = (span.end - fade).toFixed(4);
    const f = fade.toFixed(4);
    return `if(lt(t\\,${s})\\,0\\,if(lt(t\\,${s1})\\,(t-${s})/${f}\\,if(lt(t\\,${e0})\\,1\\,if(lt(t\\,${e})\\,(${e}-t)/${f}\\,0))))`;
  });
  return `1-0.65*min(1\\,${pieces.join('+')})`;
}

function mixFlat(video, voice) {
  const tmp = video.replace(/\.mp4$/i, '.voice.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', video, '-i', voice,
    '-filter_complex', '[0:a]volume=0.2[m];[1:a]volume=1[v];[m][v]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]',
    '-map', '0:v', '-map', '[a]',
    '-map_metadata', '0', '-map_chapters', '0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '224k', '-movflags', '+faststart',
    tmp,
  ]);
  rmSync(video);
  renameSync(tmp, video);
}

function mixVoice(video, voice, work) {
  const bed = join(work, 'bed.wav');
  const sfx = join(work, 'sfx.wav');
  if (!existsSync(bed) || !existsSync(sfx)) {
    mixFlat(video, voice);
    return;
  }
  const detected = spawnSync('ffmpeg', [
    '-hide_banner', '-i', voice,
    '-af', 'silencedetect=noise=-30dB:d=0.2',
    '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const log = `${detected.stderr ?? ''}\n${detected.stdout ?? ''}`;
  const expr = bedVolume(speechSpans(log));
  const tmp = video.replace(/\.mp4$/i, '.voice.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', video, '-i', bed, '-i', sfx, '-i', voice,
    '-filter_complex',
    `[1:a]aformat=channel_layouts=stereo,volume=volume='${expr}':eval=frame[bed];` +
    '[2:a]aformat=channel_layouts=stereo,volume=1[sfx];' +
    '[3:a]aformat=channel_layouts=stereo,volume=1[vo];' +
    '[bed][sfx][vo]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '224k', '-movflags', '+faststart',
    tmp,
  ]);
  rmSync(video);
  renameSync(tmp, video);
}

function measureLoudnorm(video) {
  const run = spawnSync('ffmpeg', [
    '-hide_banner', '-i', video,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function loudnormFilter(measured, seconds) {
  const cap = Number.isFinite(seconds) ? `,atrim=end=${seconds},asetpts=PTS-STARTPTS` : '';
  if (!measured || !Number.isFinite(Number(measured.input_i))) return `loudnorm=I=-14:TP=-1.5:LRA=11${cap}`;
  return `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true${cap}`;
}

function mediaDuration(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ], { encoding: 'utf8' }).trim();
    const seconds = Number(out);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

function soundMixAlreadyNormalized() {
  try {
    const src = readFileSync(fileURLToPath(new URL('./live-sound.mjs', import.meta.url)), 'utf8');
    return src.includes('loudnorm');
  } catch {
    return false;
  }
}

// This encode only, and only when the soundtrack itself is not already loudness-normalized.
// The picture stream is copied so the length stays the picture's length.
function normalizeLoudness(video, seconds) {
  const tmp = video.replace(/\.mp4$/i, '.loud.mp4');
  const end = mediaDuration(video) ?? seconds;
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', video,
      '-map', '0:v:0', '-map', '0:a:0',
      '-map_metadata', '0', '-map_chapters', '0',
      '-c:v', 'copy',
      '-af', loudnormFilter(measureLoudnorm(video), end),
      '-c:a', 'aac', '-b:a', '224k',
      '-movflags', '+faststart',
      tmp,
    ]);
    rmSync(video);
    renameSync(tmp, video);
  } catch (error) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    console.warn(`warning: loudnorm failed (${error instanceof Error ? error.message : error}); left the platform encode at its mixed level`);
  }
}

function tile(dir, count, dest) {
  if (count < 1) return;
  const cols = Math.min(4, count);
  const rows = Math.ceil(count / cols);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-start_number', '0',
    '-i', join(dir, '%02d.jpg'),
    '-frames:v', String(count),
    '-filter_complex', `tile=${cols}x${rows}:padding=8:color=0x111111`,
    dest,
  ]);
}

function loadSpec(specPath) {
  const abs = resolve(specPath);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  raw.out = raw.out ? resolve(dirname(abs), raw.out) : dirname(abs);
  if (!raw.takes) raw.takes = join(raw.out, 'takes');
  else if (!isAbsolute(raw.takes)) raw.takes = resolve(raw.out, raw.takes);
  if (raw.music?.file && !isAbsolute(raw.music.file)) raw.music.file = resolve(raw.out, raw.music.file);
  return { abs, prepared: prepareSpec(raw) };
}

function report(result) {
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exit(1);
  }
}

async function renderOne(spec, { playwright, stills, base, loudnorm = false }) {
  mkdirSync(spec.out, { recursive: true });
  if (stills) {
    const times = stillTimes(spec);
    const manifest = await compose(spec, { playwright, mode: 'stills', times, base });
    const contact = join(spec.out, 'work', base === 'brag' ? 'contact.jpg' : `${base}-contact.jpg`);
    tile(join(spec.out, 'work', 'stills'), manifest.length, contact);
    console.log(`stills: ${contact}`);
    return;
  }
  await compose(spec, { playwright, mode: 'final', base });
  const video = join(spec.out, `${base}.mp4`);
  const voice = findVoice(spec.out);
  if (voice) mixVoice(video, voice, join(spec.out, 'work'));
  if (loudnorm && !soundMixAlreadyNormalized()) normalizeLoudness(video, spec.duration + loopHoldPad(spec));
  if (base === 'brag') writeFileSync(join(spec.out, 'brag.srt'), toSrt(spec.captions));
  console.log(`video: ${video}`);
}

function grabStill(video, time, dest) {
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', video,
    '-ss', String(Math.max(0, time)),
    '-frames:v', '1',
    '-q:v', '2',
    dest,
  ]);
}

function writeThumbs(spec, video) {
  const [poster, end] = thumbTimes(spec);
  grabStill(video, poster, join(spec.out, 'brag-thumb.jpg'));
  grabStill(video, end, join(spec.out, 'brag-thumb-end.jpg'));
  console.log(`thumbs: ${join(spec.out, 'brag-thumb.jpg')}`);
}

function writeGif(spec, video, seconds) {
  const gif = join(spec.out, 'brag-hook.gif');
  const palette = join(spec.out, 'work', 'hook-palette.png');
  mkdirSync(dirname(palette), { recursive: true });
  const vf = 'fps=15,scale=720:-1:flags=lanczos';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-t', String(seconds), '-i', video, '-vf', `${vf},palettegen`, palette]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-t', String(seconds), '-i', video, '-i', palette, '-lavfi', `${vf}[x];[x][1:v]paletteuse`, '-an', gif]);
  console.log(`gif: ${gif}`);
}

function writeWebm(spec, video, seconds) {
  const webm = join(spec.out, 'brag-hook.webm');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-t', String(seconds),
    '-i', video,
    '-an',
    '-c:v', 'libvpx-vp9',
    '-crf', '33',
    '-b:v', '0',
    '-row-mt', '1',
    webm,
  ]);
  console.log(`webm: ${webm}`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.spec) {
  console.error('usage: node render.mjs spec.json [--stills] [--pack] [--gif] [--webm] [--thumbs] [--platform reels|tiktok] [--playwright <path>]');
  process.exit(1);
}
if (args.askedPlatform && args.platform !== 'reels' && args.platform !== 'tiktok') {
  console.error('error: --platform needs reels or tiktok');
  process.exit(1);
}

const { prepared } = loadSpec(args.spec);
report(validateSpec(prepared));

const playwright = findPlaywright(args.playwright);
if (!playwright) {
  console.error('Playwright was not found. Pass --playwright <path to playwright/index.mjs>, or set BRAG_PLAYWRIGHT.');
  process.exit(1);
}

const formats = args.pack ? Object.keys(FORMATS) : [prepared.format];
for (const format of formats) {
  const spec = format === prepared.format ? prepared : prepareSpec(reflow(prepared, format));
  const check = validateSpec(spec);
  if (!check.ok) {
    console.error(`refusing ${format}: the reflowed spec failed validation`);
    report(check);
  }
  const base = format === prepared.format ? 'brag' : `brag-${format}`;
  await renderOne(spec, { playwright, stills: args.stills, base });
}

if (!args.stills) {
  const master = join(prepared.out, 'brag.mp4');
  if (existsSync(master)) {
    const hook = trimPoint(prepared, 6);
    if (args.thumbs) writeThumbs(prepared, master);
    if (args.gif) writeGif(prepared, master, hook);
    if (args.webm) writeWebm(prepared, master, hook);
  }
  if (args.platform) {
    if (prepared.format !== 'vertical') {
      console.warn(`warning: --platform ${args.platform} runs only when the master format is vertical`);
    } else {
      const preset = platformPreset(args.platform);
      const spec = {
        ...prepared,
        width: preset.width,
        height: preset.height,
        caption: { raise: preset.raise },
      };
      await renderOne(spec, { playwright, stills: false, base: `brag-${args.platform}`, loudnorm: true });
    }
  }
}
