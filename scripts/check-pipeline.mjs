// Validator, soundtrack length, tone-name parity, and the slim.md sync check.
// No browser and no full-frame render.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSoundtrack } from '../skills/brag-slim/scripts/live-sound.mjs';
import {
  DENSITIES,
  TONE_MUSIC,
  TONES,
  prepareSpec,
  reflow,
  toSrt,
  validateSpec,
} from '../skills/brag-slim/scripts/spec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function assert(cond, message) {
  if (!cond) failures.push(message);
}

function goodSpec() {
  return {
    id: 'fixture',
    title: 'Horse Tinder',
    cut: 'social',
    duration: 15,
    format: 'landscape',
    tone: 'default',
    fps: 30,
    pal: { bg: '#14120b', fg: '#f4efe4', accent: '#e2a23a', glow: '#e2a23a', font: 'Geist' },
    endcard: { name: 'Horse Tinder', line: 'Find your stablemate', url: 'horse.example' },
    poster: 1.2,
    captions: [
      { s: 0.2, e: 2.6, text: 'Dating apps were built for humans.' },
      { s: 3.2, e: 7.4, text: 'Swipe through eligible horses.' },
      { s: 8.4, e: 14.6, text: 'Horse Tinder.' },
    ],
    scenes: [
      {
        s: 0,
        e: 3,
        layers: [
          { type: 'text', lines: [['Dating apps were built for humans.']], x: 96, y: 280, size: 72, w: 1728, at: 0.2 },
          { type: 'image', src: 'shot.jpg', x: 240, y: 420, w: 640, at: 0.3 },
        ],
      },
      {
        s: 3,
        e: 8,
        layers: [{ type: 'clip', take: 'swipe', box: [160, 140, 1600, 800], at: 0.2 }],
      },
      {
        s: 8,
        e: 15,
        layers: [{ type: 'endcard', at: 0.3 }],
      },
    ],
  };
}

const valid = validateSpec(prepareSpec(goodSpec()));
assert(valid.ok, `valid spec failed: ${valid.errors.join('; ')}`);

const fast = prepareSpec(goodSpec());
fast.captions[0] = { s: 0.2, e: 0.9, text: 'Dating apps were built for humans.' };
const fastResult = validateSpec(fast);
assert(!fastResult.ok && fastResult.errors.some((error) => error.includes('needs')), 'a too-fast caption should fail');

const muddy = prepareSpec(goodSpec());
muddy.pal = { ...muddy.pal, bg: '#141414', fg: '#1a1a1a' };
const muddyResult = validateSpec(muddy);
assert(!muddyResult.ok && muddyResult.errors.some((error) => error.includes('contrasts')), 'a low-contrast palette should fail');

const noPicture = prepareSpec(goodSpec());
noPicture.scenes[0].layers = noPicture.scenes[0].layers.filter((layer) => layer.type !== 'image');
noPicture.scenes[1].layers = [{ type: 'text', lines: [['Swipe through eligible horses.']], x: 96, y: 280, size: 72, w: 1728, at: 0.2 }];
const noPictureResult = validateSpec(noPicture);
assert(!noPictureResult.ok && noPictureResult.errors.some((error) => error.includes('clip or image')), 'a spec with no product picture should fail');
noPicture.textOnly = true;
assert(validateSpec(noPicture).ok, `textOnly spec should pass: ${validateSpec(noPicture).errors.join('; ')}`);

const leaked = prepareSpec(goodSpec());
leaked.endcard.url = 'ada@stable.test';
const leakedResult = validateSpec(leaked);
assert(leakedResult.ok && leakedResult.warnings.some((warning) => warning.includes('email')), 'an email should warn and still render');

const vertical = validateSpec(prepareSpec(reflow(prepareSpec(goodSpec()), 'vertical')));
assert(vertical.ok, `vertical reflow failed: ${vertical.errors.join('; ')}`);
const square = validateSpec(prepareSpec(reflow(prepareSpec(goodSpec()), 'square')));
assert(square.ok, `square reflow failed: ${square.errors.join('; ')}`);

assert(toSrt(valid ? prepareSpec(goodSpec()).captions : []).includes('Horse Tinder.'), 'srt should include caption text');

assert(JSON.stringify(Object.keys(TONE_MUSIC).sort()) === JSON.stringify([...TONES].sort()), 'every tone needs a music preset');
for (const preset of Object.values(TONE_MUSIC)) assert(DENSITIES.includes(preset.density), `unknown density ${preset.density}`);

const dir = await mkdtemp(path.join(tmpdir(), 'brag-sound-'));
try {
  for (const density of DENSITIES) {
    const duration = density === 'full' ? 20 : 4;
    const file = path.join(dir, `${density}.wav`);
    const written = makeSoundtrack({
      duration,
      music: { bpm: 120, mode: 'major', density, gain: 1, drop: 1, end: duration - 0.5 },
      scenes: [
        { s: 0, e: duration / 2, wipe: 'shutter', layers: [] },
        { s: duration / 2, e: duration, wipe: 'cut', layers: [] },
      ],
    }, {}, file);
    const wav = await readFile(file);
    const samples = wav.readUInt32LE(40) / 4;
    assert(written.samples === samples, `${density} wav length does not match the header`);
    assert(samples === Math.round(44100 * duration), `${density} soundtrack is ${samples} samples, expected ${Math.round(44100 * duration)}`);
  }
  const silent = path.join(dir, 'silent.wav');
  makeSoundtrack({ duration: 2, music: { off: true }, sfx: false, scenes: [{ s: 0, e: 2, wipe: 'cut', layers: [] }] }, {}, silent);
  const silentWav = await readFile(silent);
  assert(silentWav.readUInt32LE(40) / 4 === Math.round(44100 * 2), 'silent soundtrack should still match the duration');
} finally {
  await rm(dir, { recursive: true, force: true });
}

const [skill, tones, slim] = await Promise.all([
  readFile(path.join(root, 'skills/brag-slim/SKILL.md'), 'utf8'),
  readFile(path.join(root, 'skills/brag/references/tones.md'), 'utf8'),
  readFile(path.join(root, 'skills/brag/slim.md'), 'utf8'),
]);

assert(skill === slim, 'skills/brag/slim.md is out of sync with skills/brag-slim/SKILL.md. Fix it with: cp skills/brag-slim/SKILL.md skills/brag/slim.md');

const toneSection = skill.split('## Tones')[1]?.split('\n## ')[0] ?? '';
const skillTones = [...toneSection.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
const toneHeadings = [...tones.matchAll(/^## `([^`]+)`/gm)].map((match) => match[1]);
assert(JSON.stringify(skillTones) === JSON.stringify(TONES), `slim tone table is ${skillTones.join(', ')}`);
assert(JSON.stringify(toneHeadings) === JSON.stringify(TONES), `tones.md headings are ${toneHeadings.join(', ')}`);

if (failures.length) {
  for (const failure of failures) console.error(`error: ${failure}`);
  process.exit(1);
}

console.log('pipeline checks passed.');
console.log('skills/brag/slim.md matches skills/brag-slim/SKILL.md.');
