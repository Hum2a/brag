// Render a spec.json trailer.
//
//   node render.mjs spec.json --stills
//   node render.mjs spec.json
//   node render.mjs spec.json --pack
//   node render.mjs spec.json --playwright path/to/playwright
//
// --stills validates, shoots a settled frame of every scene plus each cut, and writes work/contact.jpg.
// A full run writes brag.mp4, bakes the poster as frame 0, writes brag.jpg and brag.srt, and mixes
// voiceover.wav when one is sitting next to the spec. --pack also renders the other two formats.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { compose } from './live-compose.mjs';
import { FORMATS, prepareSpec, reflow, stillTimes, toSrt, validateSpec } from './spec.mjs';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  let spec = null;
  let playwright = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--playwright') { playwright = argv[i + 1] ?? null; i += 1; continue; }
    if (argv[i].startsWith('--')) continue;
    spec = argv[i];
  }
  return { spec, playwright, stills: argv.includes('--stills'), pack: argv.includes('--pack') };
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

function mixVoice(video, voice) {
  const tmp = video.replace(/\.mp4$/i, '.voice.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', video, '-i', voice,
    '-filter_complex', '[0:a]volume=0.2[m];[1:a]volume=1[v];[m][v]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '224k', '-movflags', '+faststart',
    tmp,
  ]);
  rmSync(video);
  renameSync(tmp, video);
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
  return { abs, prepared: prepareSpec(raw) };
}

function report(result) {
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exit(1);
  }
}

async function renderOne(spec, { playwright, stills, base }) {
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
  const voice = findVoice(spec.out);
  if (voice) mixVoice(join(spec.out, `${base}.mp4`), voice);
  if (base === 'brag') writeFileSync(join(spec.out, 'brag.srt'), toSrt(spec.captions));
  console.log(`video: ${join(spec.out, `${base}.mp4`)}`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.spec) {
  console.error('usage: node render.mjs spec.json [--stills] [--pack] [--playwright <path>]');
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
