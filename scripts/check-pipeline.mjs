// Validator, soundtrack length, tone-name parity, and the slim.md sync check.
// No browser and no full-frame render.
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTake } from '../skills/brag-slim/scripts/live-capture.mjs';
import { makeSoundtrack } from '../skills/brag-slim/scripts/live-sound.mjs';
import {
  DENSITIES,
  TONE_MUSIC,
  TONES,
  beatGrid,
  clipTime,
  critiqueSpec,
  gradeFilter,
  holdsFor,
  loopHoldPad,
  platformPreset,
  prepareSpec,
  reflow,
  sceneKey,
  textHold,
  toSrt,
  trimPoint,
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

assert(gradeFilter({ contrast: 1.1 }).includes('contrast(1.1)'), 'gradeFilter({ contrast: 1.1 }) should contain contrast(1.1)');

const graded = prepareSpec(goodSpec());
graded.scenes[1].layers[0].blend = 'screen';
graded.scenes[1].layers[0].grade = { contrast: 1.1, saturate: 0.9, temperature: -1 };
graded.scenes[1].layers[0].shadow = true;
graded.scenes[0].layers[1].grain = true;
graded.scenes[0].layers[1].vignette = true;
graded.scenes[0].layers[1].blend = 'multiply';
graded.scenes[0].layers[1].grade = { temperature: 1 };
const gradedResult = validateSpec(graded);
assert(gradedResult.ok, `graded footage should pass: ${gradedResult.errors.join('; ')}`);

const badBlend = prepareSpec(goodSpec());
badBlend.scenes[1].layers[0].blend = 'overlay';
const badBlendResult = validateSpec(badBlend);
assert(!badBlendResult.ok && badBlendResult.errors.some((error) => error.includes('blend')), 'an unknown blend should fail validation');

const hot = prepareSpec(goodSpec());
hot.scenes[0].layers[1].grade = { temperature: 1.2 };
const hotResult = validateSpec(hot);
assert(!hotResult.ok && hotResult.errors.some((error) => error.includes('temperature')), 'a temperature outside -1 to 1 should fail');

assert(toSrt(valid ? prepareSpec(goodSpec()).captions : []).includes('Horse Tinder.'), 'srt should include caption text');

// Speed holds at 1 until 0.5s, then at 2. One second of that ramp advances 1.5s of take.
const ramped = clipTime({ from: 0, speed: 9, ramp: [[0, 1], [0.5, 2]] }, 1);
assert(Math.abs(ramped - 1.5) < 1e-9, `a 1-second ramp from speed 1 to speed 2 advances 1.5s of take, got ${ramped}`);
const frozen = clipTime({ freeze: 2, speed: 4 }, 0);
assert(frozen === 2 && clipTime({ freeze: 2, speed: 4 }, 3) === frozen, 'a freeze does not advance');
assert(clipTime({ speed: -1, from: 2 }, 1) === 1, 'speed -1 from from:2 at 1s of scene time is take time 1');

const badChrome = prepareSpec(goodSpec());
badChrome.scenes[1].layers[0].chrome = 'laptop';
const badChromeResult = validateSpec(badChrome);
assert(!badChromeResult.ok && badChromeResult.errors.some((error) => error.includes('chrome')), 'a bad chrome value should fail');

const thinSplit = prepareSpec(goodSpec());
thinSplit.scenes[0].layout = 'split';
const thinSplitResult = validateSpec(thinSplit);
assert(!thinSplitResult.ok && thinSplitResult.errors.some((error) => error.includes('split')), 'a split without two picture layers should fail');

const paired = prepareSpec(goodSpec());
paired.scenes[1].layout = 'split';
paired.scenes[1].layers[0].chrome = 'phone';
paired.scenes[1].layers.push({ type: 'image', src: 'other.jpg', x: 80, y: 80, w: 400 });
const pairedResult = validateSpec(paired);
assert(pairedResult.ok, `phone chrome and a two-picture split should pass: ${pairedResult.errors.join('; ')}`);

const briefLower = prepareSpec(goodSpec());
briefLower.scenes[0].layers.push({ type: 'lower', name: 'Ada', line: 'Wrote the notes', at: 0, until: 1 });
const briefLowerResult = validateSpec(briefLower);
assert(!briefLowerResult.ok && briefLowerResult.errors.some((error) => error.includes('lower third') && error.includes('needs')), `a short lower third should fail: ${briefLowerResult.errors.join('; ')}`);

const spoken = { type: 'text', anim: 'slam', lines: [['Hold this line']], at: 0.2, until: 3.2 };
const spokenScene = { s: 0, e: 5 };
const held = textHold(spoken, spokenScene);
const heldExit = textHold({ ...spoken, exit: 0.8 }, spokenScene);
assert(heldExit === held, `exit reduced the hold from ${held} to ${heldExit}`);
assert(Math.abs(spoken.at + 0.3 + heldExit - spoken.until) < 1e-9, `measured hold ends at ${spoken.at + 0.3 + heldExit}, until is ${spoken.until}`);

const sting = prepareSpec(goodSpec());
sting.scenes[1].e = 14.2;
sting.scenes[2].s = 14.2;
sting.scenes[2].layers[0].at = 0;
sting.scenes[2].layers[0].mark = 'HT';
const stingBounds = [0, 3, 14.2, 15];
assert(holdsFor(sting, stingBounds) === false, 'a mark sting should shorten a tight end card');
const quiet = structuredClone(sting);
delete quiet.scenes[2].layers[0].mark;
assert(holdsFor(quiet, stingBounds) === true, 'the same end card without a mark still holds');

const emphasized = toSrt([{ s: 0.2, e: 2.4, text: 'Swipe *left* now.' }]);
assert(emphasized.includes('Swipe left now.'), 'srt should keep the emphasized word');
assert(!emphasized.includes('*'), 'srt should strip emphasis marks');

const timed = prepareSpec({
  duration: 8,
  tone: 'default',
  music: {
    bpm: 120,
    regions: [
      { at: 0.3, start: 0.2, dur: 1 },
      { at: 0.3, start: 0.2, dur: 1, lock: false },
    ],
  },
});
const [snapped, locked] = timed.music.regions;
assert(snapped.at === 0.5 && snapped.start === 0, `region snapped to ${snapped.at} / ${snapped.start}`);
assert(locked.at === 0.3 && locked.start === 0.2, `locked region moved to ${locked.at} / ${locked.start}`);

const offDrop = prepareSpec(goodSpec());
offDrop.music.drop = 1.2;
assert(validateSpec(offDrop).warnings.some((warning) => warning.includes('music.drop')), 'a drop away from a scene boundary should warn');
const bareFile = prepareSpec({ ...goodSpec(), music: { file: 'custom.wav', bpm: 100 } });
const bareFileResult = validateSpec(bareFile);
assert(!bareFileResult.ok && bareFileResult.errors.some((error) => error.includes('bpm and downbeat')), 'a file without downbeat should fail');

const shortOverlay = goodSpec();
shortOverlay.overlays = [{
  type: 'text',
  s: 1,
  e: 1.4,
  lines: [['This headline needs longer']],
  x: 96,
  y: 220,
  w: 1200,
  size: 64,
}];
const shortOverlayResult = validateSpec(prepareSpec(shortOverlay));
assert(!shortOverlayResult.ok && shortOverlayResult.errors.some((error) => error.includes('needs')), 'an overlay that is too short should fail');

const marked = goodSpec();
marked.markers = { hook: 1, reveal: 4.2, punchline: 12 };
marked.markersLock = { reveal: false };
const markedSpec = prepareSpec(marked);
const grid = beatGrid(markedSpec);
assert(grid.some((beat) => Math.abs(beat - markedSpec.markers.hook) < 1e-6), 'a marker should snap onto a beat');
assert(Math.abs(markedSpec.markers.hook - 1) > 1e-3, 'hook at 1s is off the beat grid and should move');
assert(markedSpec.markers.reveal === 4.2, 'markersLock false should keep that marker put');
const lateHook = validateSpec(prepareSpec({ ...goodSpec(), markers: { hook: 3 } }));
assert(lateHook.warnings.some((warning) => warning.includes('hook')), 'a hook later than 2 seconds should warn');

const left = prepareSpec(goodSpec());
const right = prepareSpec(goodSpec());
left.captions = [];
right.captions = [];
const shared = structuredClone(left.scenes[0]);
const other = structuredClone(left.scenes[1]);
const tail = structuredClone(left.scenes[2]);
const place = (scene, s) => {
  const dur = scene.e - scene.s;
  return { ...scene, s, e: s + dur };
};
right.scenes = [
  place(other, 0),
  place(shared, other.e - other.s),
  place(tail, (other.e - other.s) + (shared.e - shared.s)),
];
assert(sceneKey(left, left.scenes[0]) === sceneKey(right, right.scenes[1]), 'a shared scene should keep the same sceneKey when the scene order swaps');
assert(sceneKey(left, left.scenes[0]) !== sceneKey(right, right.scenes[0]), 'a different scene should not reuse that sceneKey');

assert(platformPreset('reels').raise === 220, 'a reels preset raises captions by 220');
assert(platformPreset('tiktok').raise === 220, 'a tiktok preset raises captions by 220');
assert(platformPreset('reels').width === 1080 && platformPreset('reels').height === 1920, 'reels is 1080x1920');
assert(platformPreset('tiktok').width === 1080 && platformPreset('tiktok').height === 1920, 'tiktok is 1080x1920');
assert(platformPreset().raise === 0, 'the default caption raise is 0');
assert(platformPreset('landscape').raise === 0, 'an unknown platform raise is 0');

const beatSpec = prepareSpec(goodSpec());
const hook = trimPoint(beatSpec, 6);
const beat = 60 / beatSpec.music.bpm;
const origin = Number(beatSpec.music.downbeat);
const phase = (hook - (Number.isFinite(origin) ? origin : 0)) / beat;
assert(hook > 0 && hook <= 6 && hook <= beatSpec.duration, `hook trim ${hook}s should sit at or under 6s`);
assert(Math.abs(phase - Math.round(phase)) < 0.02, `hook trim ${hook}s should sit on a beat`);

const looped = prepareSpec(goodSpec());
looped.loopHold = true;
const loopedResult = validateSpec(looped);
assert(loopedResult.ok && looped.duration === 15, `loopHold should still validate duration: ${loopedResult.errors.join('; ')}`);
assert(loopHoldPad(looped) === 0.5, 'loopHold pads 15 frames, 0.5s at 30fps');
const capped = prepareSpec(goodSpec());
capped.loopHold = true;
capped.duration = 35.05;
assert(loopHoldPad(capped) === 0, 'loopHold skips a pad that would pass 35.5s');

const unburned = prepareSpec(goodSpec());
unburned.burnCaptions = false;
const unburnedResult = validateSpec(unburned);
assert(unburnedResult.ok && toSrt(unburned.captions).includes('Horse Tinder.'), 'burnCaptions false still keeps the srt');

const lateLine = prepareSpec(goodSpec());
lateLine.captions = [
  { s: 3, e: 6.5, text: 'Dating apps were built for humans.' },
  { s: 6.5, e: 10.5, text: 'Swipe through eligible horses.' },
  { s: 10.5, e: 15, text: 'Horse Tinder.' },
];
lateLine.scenes[0].layers[0].at = 3;
const lateLineResult = critiqueSpec(lateLine);
assert(
  lateLineResult.errors.some((error) => error.includes('after 2 seconds')),
  'a fixture whose first line starts at 3 seconds should fail critiqueSpec',
);

const covered = prepareSpec(goodSpec());
covered.captions = [
  { s: 0, e: 5, text: 'Dating apps were built for humans.' },
  { s: 5, e: 10, text: 'Swipe through eligible horses.' },
  { s: 10, e: 15, text: 'Horse Tinder.' },
];
const coveredResult = critiqueSpec(covered);
assert(coveredResult.errors.length === 0, `a fixture with captions covering the cut should pass critiqueSpec: ${coveredResult.errors.join('; ')}`);

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
  let silentPeak = 0;
  for (let i = 44; i + 1 < silentWav.length; i += 2) silentPeak = Math.max(silentPeak, Math.abs(silentWav.readInt16LE(i)));
  assert(silentPeak === 0, 'silent soundtrack should stay silent');

  const loudFile = path.join(dir, 'loudnorm.wav');
  makeSoundtrack({
    duration: 4,
    music: { bpm: 120, mode: 'major', density: 'sparse', gain: 1, drop: 1, end: 3.5 },
    scenes: [
      { s: 0, e: 2, wipe: 'cut', layers: [] },
      { s: 2, e: 4, wipe: 'cut', layers: [] },
    ],
  }, {}, loudFile);
  const loudWav = await readFile(loudFile);
  assert(loudWav.readUInt32LE(40) / 4 === 44100 * 4, `loudnorm soundtrack is ${loudWav.readUInt32LE(40) / 4} samples`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

function commandWorks(bin) {
  const result = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0;
}

if (commandWorks('ffmpeg')) {
  const importDir = await mkdtemp(path.join(tmpdir(), 'brag-import-'));
  try {
    const clip = path.join(importDir, 'color.mp4');
    const count = 12;
    const generated = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:s=80x48:r=30',
      '-frames:v', String(count),
      '-pix_fmt', 'yuv420p',
      clip,
    ], { encoding: 'utf8', windowsHide: true });
    assert(generated.status === 0, `ffmpeg could not write a color clip: ${generated.stderr || generated.error?.message || generated.status}`);
    if (generated.status === 0) {
      importTake(clip, importDir, 'color');
      const index = JSON.parse(await readFile(path.join(importDir, 'color', 'index.json'), 'utf8'));
      assert(index.frames.length === count, `imported ${index.frames.length} frames, expected ${count}`);
      assert(index.scale === 1, 'imported take scale should be 1');
      assert(index.viewport?.width === 80 && index.viewport?.height === 48, `viewport should be 80x48, got ${index.viewport?.width}x${index.viewport?.height}`);
      assert(Array.isArray(index.events) && index.events.length === 0, 'imported take should have no events');
      index.frames.forEach((frame, i) => {
        assert(Math.abs(frame.t - i / 30) < 1e-9, `frame ${i} t is ${frame.t}, expected ${i / 30}`);
        if (i > 0) assert(Math.abs(frame.t - index.frames[i - 1].t - 1 / 30) < 1e-9, `frame ${i} t spacing is off`);
      });
    }
  } finally {
    await rm(importDir, { recursive: true, force: true });
  }
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
