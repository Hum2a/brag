// Storyboard contract for the default /brag pipeline.
// The agent writes spec.json. render.mjs refuses to draw a spec that fails validateSpec.

export const TONES = ['default', 'polished', 'yc-parody', 'chaotic', 'deadpan', 'cinematic', 'app-store', 'demo', 'launch'];

export const DENSITIES = ['full', 'sparse', 'dry', 'dense', 'swell', 'clean'];

export const CUTS = {
  hook: { seconds: 6, tolerance: 0.35 },
  social: { seconds: 15, tolerance: 0.5 },
  launch: { seconds: 20, tolerance: 2 },
  trailer: { seconds: 35, tolerance: 1 },
};

export const CEILING = 35.05;

export const FORMATS = {
  landscape: { width: 1920, height: 1080, margin: 96, marginY: 96 },
  vertical: { width: 1080, height: 1920, margin: 80, marginY: 160 },
  square: { width: 1080, height: 1080, margin: 80, marginY: 80 },
};

export const TONE_MOTION = {
  default: { wipe: 'shutter', anim: 'slam', background: 'blobs' },
  chaotic: { wipe: 'shutter', anim: 'slam', background: 'blobs' },
  polished: { wipe: 'dip', anim: 'mask', background: 'flat' },
  'app-store': { wipe: 'dip', anim: 'mask', background: 'flat' },
  launch: { wipe: 'dip', anim: 'mask', background: 'flat' },
  'yc-parody': { wipe: 'cut', anim: 'words', background: 'flat' },
  deadpan: { wipe: 'cut', anim: 'words', background: 'flat' },
  demo: { wipe: 'cut', anim: 'words', background: 'flat' },
  cinematic: { wipe: 'fade', anim: 'mask', background: 'blobs' },
};

export const TONE_MUSIC = {
  default: { bpm: 118, mode: 'major', density: 'full' },
  polished: { bpm: 92, mode: 'major', density: 'sparse', gain: 0.85 },
  'yc-parody': { bpm: 100, mode: 'minor', density: 'dry' },
  chaotic: { bpm: 140, mode: 'minor', density: 'dense' },
  deadpan: { bpm: 80, mode: 'minor', density: 'sparse', gain: 0.45 },
  cinematic: { bpm: 84, mode: 'minor', density: 'swell' },
  'app-store': { bpm: 108, mode: 'major', density: 'clean' },
  demo: { bpm: 104, mode: 'major', density: 'sparse', gain: 0.7 },
  launch: { bpm: 112, mode: 'major', density: 'clean' },
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const TOKEN = /\b(?:sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})\b/;

export function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

export function requiredHold(text) {
  const words = wordCount(text);
  if (words === 0) return 0;
  if (words <= 3) return 0.8;
  return Math.max(1.2, words * 0.3);
}

function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (!rgb) return null;
  return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] == null ? 1 : +rgb[4] };
}

function channel(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(fg, bg) {
  const top = parseColor(fg);
  const back = parseColor(bg);
  if (!top || !back) return null;
  const a = top.a ?? 1;
  const over = {
    r: top.r * a + back.r * (1 - a),
    g: top.g * a + back.g * (1 - a),
    b: top.b * a + back.b * (1 - a),
  };
  const lighter = Math.max(luminance(over), luminance(back));
  const darker = Math.min(luminance(over), luminance(back));
  return (lighter + 0.05) / (darker + 0.05);
}

function layerCopy(layer) {
  if (layer.type === 'text') return (layer.lines ?? []).map((line) => (Array.isArray(line) ? line[0] : line)).join(' ');
  if (layer.type === 'endcard') return [layer.name, layer.line, layer.url].filter(Boolean).join(' ');
  return '';
}

export function textHold(layer, scene) {
  const dur = scene.e - scene.s;
  const until = layer.until ?? dur;
  if (layer.type === 'lower') {
    const end = Math.min(until, dur);
    const settledAt = (layer.at ?? 0) + 0.25;
    return (end - 0.25) - settledAt;
  }
  const stagger = layer.stagger ?? (layer.anim === 'words' ? 0.085 : 0.22);
  const settle = layer.anim === 'slam' ? 0.3 : layer.anim === 'mask' ? 0.42 : 0.34;
  let units = 1;
  if (layer.anim === 'words') units = Math.max(1, wordCount(layerCopy(layer)));
  else if (layer.type === 'text') units = Math.max(1, layer.lines?.length ?? 1);
  const settledAt = (layer.at ?? 0) + Math.max(0, units - 1) * stagger + settle;
  return until - settledAt;
}

function lowerCopy(layer) {
  return [layer.name, layer.line].filter(Boolean).join(' ');
}

function lowerBox(spec) {
  const margin = spec.margin ?? 0;
  const marginY = spec.marginY ?? margin;
  const width = spec.width ?? 0;
  const height = spec.height ?? 0;
  const size = Math.max(22, Math.round(height * 0.032));
  const lineSize = Math.max(16, Math.round(size * 0.7));
  const h = Math.round(size * 1.15 + lineSize * 1.25 + 28);
  const w = Math.min(Math.round(width * 0.46), Math.max(1, width - margin * 2));
  const capH = Math.round(height * 0.037 * 1.15);
  const y = height - marginY - capH - 16 - h;
  return { x: margin, y, w, h, size, lineSize };
}

function placeLower(spec, layer) {
  const box = lowerBox(spec);
  layer.x = box.x;
  layer.y = box.y;
  layer.w = box.w;
  layer.h = box.h;
  layer.size = box.size;
  layer.lineSize = box.lineSize;
}

function stickerBox(layer) {
  const size = layer.size ?? (layer.shape === 'step' ? 64 : 22);
  if (layer.shape === 'step') {
    const d = layer.w ?? layer.h ?? 64;
    return { x: layer.x, y: layer.y, w: layer.w ?? d, h: layer.h ?? d };
  }
  const text = String(layer.text ?? '');
  const w = layer.w ?? Math.max(88, Math.ceil(text.length * size * 0.62) + 36);
  const h = layer.h ?? Math.round(size * 2.1);
  return { x: layer.x, y: layer.y, w, h };
}

function endcardLine(spec, layer) {
  return layer.line || spec.endcard?.line || layer.name || spec.endcard?.name || '';
}

function endcardMark(spec, layer) {
  return layer.mark || spec.endcard?.mark || '';
}

function endcardHold(spec, layer, scene) {
  const sting = endcardMark(spec, layer) ? 0.6 : 0;
  return (scene.e - scene.s) - (layer.at ?? 0) - sting;
}

export function holdsFor(spec, bounds) {
  for (let i = 0; i < spec.scenes.length; i += 1) {
    const scene = { ...spec.scenes[i], s: bounds[i], e: bounds[i + 1] };
    if (!(scene.e > scene.s + 0.05)) return false;
    for (const layer of scene.layers ?? []) {
      if (layer.type === 'text' && layerCopy(layer).trim()) {
        if (textHold(layer, scene) + 1e-3 < requiredHold(layerCopy(layer))) return false;
      }
      if (layer.type === 'lower' && lowerCopy(layer).trim()) {
        if (textHold(layer, scene) + 1e-3 < requiredHold(lowerCopy(layer))) return false;
      }
      if (layer.type === 'endcard') {
        const line = endcardLine(spec, layer);
        if (line && endcardHold(spec, layer, scene) + 1e-3 < requiredHold(line)) return false;
      }
    }
  }
  return true;
}

function walkStrings(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((item) => walkStrings(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => walkStrings(item, visit));
}

export function prepareSpec(raw) {
  const spec = structuredClone(raw ?? {});
  spec.cut = spec.cut ?? 'launch';
  spec.format = spec.format ?? 'landscape';
  spec.tone = spec.tone ?? 'default';
  spec.fps = spec.fps ?? 30;
  spec.id = spec.id ?? 'brag';
  const stage = FORMATS[spec.format];
  if (stage) {
    spec.width = stage.width;
    spec.height = stage.height;
    spec.margin = stage.margin;
    spec.marginY = stage.marginY;
  }
  if (spec.duration == null && CUTS[spec.cut]) spec.duration = CUTS[spec.cut].seconds;
  const musicPreset = TONE_MUSIC[spec.tone] ?? TONE_MUSIC.default;
  spec.music = { ...musicPreset, ...(spec.music ?? {}) };
  if (spec.duration != null) {
    if (spec.music.drop == null) spec.music.drop = spec.duration < 8 ? 1.5 : spec.duration < 16 ? 3 : 4;
    if (spec.music.end == null) spec.music.end = Math.max(spec.music.drop + 0.4, spec.duration - Math.min(2.5, spec.duration * 0.18));
  }
  const motion = TONE_MOTION[spec.tone] ?? TONE_MOTION.default;
  spec.background = spec.background ?? motion.background;
  spec.motion = spec.motion ?? motion;
  for (const scene of spec.scenes ?? []) {
    if (scene.wipe == null) scene.wipe = motion.wipe;
    for (const layer of scene.layers ?? []) {
      if (layer.type === 'text' && layer.anim == null) layer.anim = motion.anim;
      if (layer.type === 'lower') placeLower(spec, layer);
    }
  }
  return spec;
}

export function reflow(spec, format) {
  const next = structuredClone(spec);
  const from = FORMATS[spec.format];
  const to = FORMATS[format];
  if (!to || spec.format === format) return next;
  const sx = from ? to.width / from.width : 1;
  const sy = from ? to.height / from.height : 1;
  const s = Math.min(sx, sy);
  for (const scene of next.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      if (Array.isArray(layer.box)) {
        const [x, y, w, h] = layer.box;
        layer.box = [Math.round(x * sx), Math.round(y * sy), Math.round(w * sx), Math.round(h * sy)];
      }
      if (typeof layer.x === 'number') layer.x = Math.round(layer.x * sx);
      if (typeof layer.y === 'number') layer.y = Math.round(layer.y * sy);
      if (typeof layer.w === 'number') layer.w = Math.round(layer.w * sx);
      if (typeof layer.h === 'number') layer.h = Math.round(layer.h * sy);
      if (typeof layer.size === 'number') layer.size = Math.max(18, Math.round(layer.size * s));
      if (Array.isArray(layer.point)) layer.point = layer.point.map((n, i) => Math.round(n * (i === 0 ? sx : sy)));
    }
  }
  next.format = format;
  next.width = to.width;
  next.height = to.height;
  next.margin = to.margin;
  next.marginY = to.marginY;
  for (const scene of next.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      if (Array.isArray(layer.box)) {
        let [x, y, w, h] = layer.box;
        w = Math.max(1, Math.min(w, to.width));
        h = Math.max(1, Math.min(h, to.height));
        x = Math.max(0, Math.min(x, to.width - w));
        y = Math.max(0, Math.min(y, to.height - h));
        layer.box = [x, y, w, h];
      }
      if (layer.type === 'text' || layer.type === 'count') {
        const lines = layer.type === 'text' ? Math.max(1, layer.lines?.length ?? 1) : 1;
        const blockH = layer.h ?? (layer.size ?? 64) * (layer.lh ?? 1.08) * lines;
        const blockW = Math.min(layer.w ?? (to.width - to.margin * 2), to.width - to.margin * 2);
        layer.w = blockW;
        layer.x = Math.max(to.margin, Math.min(layer.x ?? to.margin, to.width - to.margin - blockW));
        layer.y = Math.max(to.marginY, Math.min(layer.y ?? to.marginY, Math.max(to.marginY, to.height - to.marginY - blockH)));
      }
    }
  }
  return next;
}

// Take time at a scene-local instant. A set freeze holds that frame (a number is the
// frame; any other set value holds `from`). `ramp` is [[sceneTime, speed], ...], sorted
// and scene-local: each speed holds until the next knot and replaces constant `speed`.
// Integrate from `from` (default 0). Otherwise from + (sceneTime - at) * speed.
// The result may fall outside the take. The page clamps it to the frame list.
export function clipTime(layer, sceneTime) {
  const from = layer.from ?? 0;
  const at = layer.at ?? 0;
  if (layer.freeze != null && layer.freeze !== false) {
    return typeof layer.freeze === 'number' ? layer.freeze : from;
  }
  if (Array.isArray(layer.ramp) && layer.ramp.length) {
    const knots = layer.ramp.map((knot) => [knot[0], knot[1]]).sort((a, b) => a[0] - b[0]);
    const speedAt = (time) => {
      let speed = knots[0][1];
      for (const [knotTime, knotSpeed] of knots) {
        if (knotTime <= time) speed = knotSpeed;
        else break;
      }
      return speed;
    };
    const lo = Math.min(at, sceneTime);
    const hi = Math.max(at, sceneTime);
    const marks = [lo];
    for (const [knotTime] of knots) {
      if (knotTime > lo && knotTime < hi) marks.push(knotTime);
    }
    marks.push(hi);
    let covered = 0;
    for (let i = 0; i < marks.length - 1; i += 1) {
      covered += speedAt(marks[i]) * (marks[i + 1] - marks[i]);
    }
    const direction = sceneTime >= at ? 1 : -1;
    return from + direction * covered;
  }
  return from + (sceneTime - at) * (layer.speed ?? 1);
}

export function stillTimes(spec) {
  const times = [];
  for (const scene of spec.scenes ?? []) {
    const dur = scene.e - scene.s;
    const settled = scene.s + Math.min(Math.max(0.55, dur * 0.4), Math.max(0.05, dur - 0.08));
    times.push(+settled.toFixed(3));
    if (scene.s > 0.05) times.push(+scene.s.toFixed(3));
  }
  return times;
}

function srtStamp(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(f, 3)}`;
}

export function toSrt(captions) {
  return (captions ?? []).map((cap, i) => `${i + 1}\n${srtStamp(cap.s)} --> ${srtStamp(cap.e)}\n${String(cap.text ?? '').replace(/\*/g, '')}\n`).join('\n');
}

function insideSafe(spec, layer, label) {
  const margin = spec.margin ?? 0;
  const marginY = spec.marginY ?? margin;
  const right = spec.width - margin;
  const bottom = spec.height - marginY;
  const x = layer.x ?? margin;
  const y = layer.y ?? marginY;
  const w = layer.w ?? (spec.width - margin * 2);
  const lines = layer.type === 'text' ? Math.max(1, layer.lines?.length ?? 1) : 1;
  const h = layer.h ?? (layer.size ?? 64) * (layer.lh ?? 1.08) * lines;
  if (x < margin - 1 || y < marginY - 1 || x + w > right + 1 || y + h > bottom + 1) {
    return `${label} sits outside the ${spec.format} safe area`;
  }
  return null;
}

export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec is missing'], warnings };

  if (!CUTS[spec.cut]) errors.push(`cut must be one of ${Object.keys(CUTS).join(', ')}`);
  if (!FORMATS[spec.format]) errors.push(`format must be one of ${Object.keys(FORMATS).join(', ')}`);
  if (!TONES.includes(spec.tone)) errors.push(`tone must be one of ${TONES.join(', ')}`);
  if (!(spec.fps > 0)) errors.push('fps must be a positive number');
  else if (spec.fps !== 30) warnings.push(`fps is ${spec.fps}; the pipeline renders at 30`);
  if (!(spec.duration > 0)) errors.push('duration must be greater than 0');
  else if (spec.duration > CEILING) errors.push(`duration ${spec.duration}s is past the 35s ceiling`);
  else if (CUTS[spec.cut] && Math.abs(spec.duration - CUTS[spec.cut].seconds) > CUTS[spec.cut].tolerance) {
    errors.push(`cut "${spec.cut}" is ${CUTS[spec.cut].seconds}s (±${CUTS[spec.cut].tolerance}); duration is ${spec.duration}s`);
  }

  const pal = spec.pal ?? {};
  if (!pal.bg || !pal.fg || !pal.accent || !pal.font) errors.push('pal needs bg, fg, accent, and font');
  if (pal.bg && pal.fg) {
    const ratio = contrastRatio(pal.fg, pal.bg);
    if (ratio == null) errors.push('pal.fg and pal.bg must be hex or rgb colors');
    else if (ratio < 4.5) errors.push(`pal.fg on pal.bg contrasts at ${ratio.toFixed(2)}:1; WCAG AA needs 4.5:1`);
  }

  if (spec.music && spec.music.density && !DENSITIES.includes(spec.music.density)) {
    errors.push(`music.density must be one of ${DENSITIES.join(', ')}`);
  }

  if (!spec.endcard || !spec.endcard.name || !spec.endcard.line) errors.push('endcard needs a name and a line');

  const captions = spec.captions;
  if (!Array.isArray(captions) || captions.length === 0) errors.push('captions need at least one { s, e, text } line so the cut works muted');
  else {
    captions.forEach((cap, i) => {
      if (!cap || typeof cap.text !== 'string' || !cap.text.trim()) errors.push(`caption ${i + 1} needs text`);
      else if (cap.style != null && cap.style !== 'plain' && cap.style !== 'pill') errors.push(`caption ${i + 1} style must be plain or pill`);
      else if (cap.raise != null && !(typeof cap.raise === 'number' && cap.raise >= 0)) errors.push(`caption ${i + 1} raise must be pixels`);
      else if (!(cap.e > cap.s)) errors.push(`caption ${i + 1} ends before it starts`);
      else {
        const hold = cap.e - cap.s;
        const need = requiredHold(cap.text);
        if (hold + 1e-3 < need) errors.push(`caption "${cap.text}" is on screen ${hold.toFixed(2)}s and needs ${need.toFixed(2)}s`);
        if (spec.duration > 0 && (cap.s < -1e-3 || cap.e > spec.duration + 1e-3)) errors.push(`caption "${cap.text}" falls outside the cut`);
      }
    });
  }

  const scenes = spec.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) errors.push('scenes are missing');
  else {
    const ordered = [...scenes].sort((a, b) => a.s - b.s);
    if (ordered[0].s > 0.08) errors.push('the first scene has to start at 0');
    ordered.forEach((scene, i) => {
      if (!(scene.e > scene.s)) errors.push(`scene ${i + 1} ends before it starts`);
      if (i > 0 && Math.abs(scene.s - ordered[i - 1].e) > 0.08) errors.push(`scene ${i + 1} does not start where the previous scene ends`);
      if (!Array.isArray(scene.layers) || scene.layers.length === 0) errors.push(`scene ${i + 1} has no layers`);
    });
    const last = ordered[ordered.length - 1];
    if (spec.duration > 0 && Math.abs(last.e - spec.duration) > 0.08) errors.push('the last scene has to end on the duration');
    if (!(last.layers ?? []).some((layer) => layer.type === 'endcard')) errors.push('the final scene needs an endcard layer');

    let hasPicture = false;
    scenes.forEach((scene, i) => {
      if (scene.layout === 'split') {
        const pictures = (scene.layers ?? []).filter((layer) => layer.type === 'clip' || layer.type === 'image');
        if (pictures.length < 2) errors.push(`scene ${i + 1} split needs two picture layers`);
      }
      for (const layer of scene.layers ?? []) {
        if (layer.chrome != null && layer.chrome !== 'phone' && layer.chrome !== 'browser') errors.push(`scene ${i + 1} chrome must be phone or browser`);
        if (layer.type === 'text' && (!Array.isArray(layer.lines) || layer.lines.length === 0)) errors.push(`scene ${i + 1} text layer needs lines`);
        if (layer.type === 'clip' && !layer.take) errors.push(`scene ${i + 1} clip needs a take`);
        if (layer.type === 'clip' && layer.box !== 'full' && !Array.isArray(layer.box)) errors.push(`scene ${i + 1} clip needs a box`);
        if (layer.type === 'image' && !layer.src) errors.push(`scene ${i + 1} image needs a src`);
        if (layer.type === 'clip' || layer.type === 'image') hasPicture = true;
        if (layer.type === 'endcard') {
          const line = endcardLine(spec, layer);
          const hold = endcardHold(spec, layer, scene);
          const need = requiredHold(line);
          if (line && hold + 1e-3 < need) errors.push(`scene ${i + 1} end card is settled for ${hold.toFixed(2)}s and needs ${need.toFixed(2)}s`);
        }
        if (layer.type === 'lower') {
          const copy = lowerCopy(layer);
          if (!layer.name || !layer.line) errors.push(`scene ${i + 1} lower third needs a name and a line`);
          else {
            const problem = insideSafe(spec, { ...layer, ...lowerBox(spec) }, `scene ${i + 1} lower`);
            if (problem) errors.push(problem);
            const hold = textHold(layer, scene);
            const need = requiredHold(copy);
            if (hold + 1e-3 < need) errors.push(`scene ${i + 1} lower third "${copy}" is settled for ${hold.toFixed(2)}s and needs ${need.toFixed(2)}s`);
          }
        }
        if (layer.type === 'sticker') {
          if (!['arrow', 'pill', 'step'].includes(layer.shape)) errors.push(`scene ${i + 1} sticker shape must be arrow, pill, or step`);
          if (typeof layer.text !== 'string' || !layer.text.trim()) errors.push(`scene ${i + 1} sticker needs text`);
          if (typeof layer.x !== 'number' || typeof layer.y !== 'number') errors.push(`scene ${i + 1} sticker needs x and y on the stage`);
          else {
            const problem = insideSafe(spec, { ...layer, ...stickerBox(layer) }, `scene ${i + 1} sticker`);
            if (problem) errors.push(problem);
          }
          if (layer.point != null && layer.shape === 'arrow' && (!Array.isArray(layer.point) || layer.point.length !== 2 || layer.point.some((n) => typeof n !== 'number'))) {
            errors.push(`scene ${i + 1} sticker point must be [x, y]`);
          }
        }
        if (layer.type === 'text' || layer.type === 'count') {
          const copy = layerCopy(layer);
          const problem = insideSafe(spec, layer, `scene ${i + 1} ${layer.type}`);
          if (problem) errors.push(problem);
          if (layer.type === 'text' && copy.trim()) {
            const hold = textHold(layer, scene);
            const need = requiredHold(copy);
            if (hold + 1e-3 < need) errors.push(`scene ${i + 1} text "${copy}" is settled for ${hold.toFixed(2)}s and needs ${need.toFixed(2)}s`);
          }
        }
      }
    });
    if (!spec.textOnly && !hasPicture) errors.push('a scene needs a clip or image of the product, or set textOnly because there is no UI');
  }

  if (typeof spec.poster === 'number' && Array.isArray(scenes)) {
    const nearCut = scenes.some((scene) => Math.abs(spec.poster - scene.s) < 0.15 || Math.abs(spec.poster - scene.e) < 0.15);
    if (nearCut) warnings.push('poster time is on a cut; pick a settled frame');
  }

  walkStrings(spec, (text) => {
    if (EMAIL.test(text)) warnings.push('spec contains an email address; swap it for a fictional stand-in before a public render');
    if (TOKEN.test(text)) warnings.push('spec contains a token-shaped string; remove it before a public render');
  });

  return { ok: errors.length === 0, errors, warnings };
}
