// Composes a spec into a finished video. Every frame is a pure function of time.
//
//   await compose(spec, { playwright, mode: 'stills' | 'final', times, base })
//
// spec comes from spec.mjs (prepareSpec): width, height, margin, format, tone, captions,
// endcard, scenes, overlays. Clip layers play takes from live-capture. Image layers use local files.
// Tones pick the wipe (shutter, dip, cut, fade, push, iris), type entrance, and background.
// Grade, grain, vignette, blend, and shadow stay on the footage node.
// Overlays draw on #stage for their own s and e, so a headline can outlive a cut.
// A clip dur hides that clip at at + dur. The rest of the scene stays.
// Final frames are stored at work/scenes/<format>/<first 16 hex of sceneKey>/ and assembled in scene order.
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { makeSoundtrack } from './live-sound.mjs';
import { FORMATS, clipTime, gradeFilter, loopHoldPad, sceneKey } from './spec.mjs';

const RUNTIME = String.raw`
const S = window.SPEC, T = window.TAKES;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const out3 = (x) => 1 - Math.pow(1 - clamp(x), 3);
const outBack = (x) => { x = clamp(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const inOut = (x) => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const el = (tag, css, parent) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (parent) parent.appendChild(e); return e; };
${gradeFilter.toString()}
const grainUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>');
function paintFinish(frame, img, l) {
  if (img) img.style.filter = gradeFilter(l.grade);
  if (l.blend) frame.style.mixBlendMode = l.blend;
  const temp = l.grade && typeof l.grade.temperature === 'number' ? l.grade.temperature : 0;
  if (temp) {
    const wash = el('div', 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;background:' + (temp > 0 ? '#ff9a3c' : '#6aa7ff') + ';opacity:' + (Math.min(1, Math.abs(temp)) * .28), frame);
    wash.dataset.decor = '1';
  }
  if (l.vignette) {
    const vig = el('div', 'position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, transparent 46%, rgba(0,0,0,.6) 100%)', frame);
    vig.dataset.decor = '1';
  }
  if (l.grain) {
    const grain = el('div', 'position:absolute;inset:0;pointer-events:none;opacity:.08;background-image:url("' + grainUrl + '");background-size:140px 140px', frame);
    grain.dataset.decor = '1';
  }
}
const stage = document.getElementById('stage');
const W = S.width, H = S.height, M = S.margin, MY = S.marginY;
const bg = el('div', 'position:absolute;inset:0;background:' + S.pal.bg, stage);
const blobA = el('div', 'position:absolute;width:' + Math.round(W * .68) + 'px;height:' + Math.round(W * .68) + 'px;border-radius:50%;filter:blur(90px);background:' + S.pal.glow, bg);
const blobB = el('div', 'position:absolute;width:' + Math.round(W * .52) + 'px;height:' + Math.round(W * .52) + 'px;border-radius:50%;filter:blur(110px);opacity:.55;background:' + (S.pal.glow2 || S.pal.accent), bg);
const grid = el('div', 'position:absolute;inset:-200px;background-image:linear-gradient(' + S.pal.fg + ' 1px,transparent 1px),linear-gradient(90deg,' + S.pal.fg + ' 1px,transparent 1px);background-size:80px 80px', bg);
const mode = S.background || 'blobs';
blobA.style.display = mode === 'blobs' ? 'block' : 'none';
blobB.style.display = mode === 'blobs' ? 'block' : 'none';
grid.style.display = mode === 'flat' ? 'none' : 'block';
grid.style.opacity = mode === 'grid' ? '.14' : '.06';

function frameAt(take, t) {
  const f = T[take].frames; let lo = 0, hi = f.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f[m].t <= t) lo = m; else hi = m - 1; }
  return f[lo].f;
}
function cursorAt(take, t) {
  const ev = T[take].moves; if (!ev.length) return null;
  let sx = 0, sy = 0, w = 0;
  for (const e of ev) { const d = Math.abs(e.t - t); if (d < .55) { const k = 1 - d / .55; sx += e.x * k; sy += e.y * k; w += k; } }
  if (w) return [sx / w, sy / w];
  let best = ev[0]; for (const e of ev) if (e.t <= t) best = e;
  return [best.x, best.y];
}
function blendCam(cam, st) {
  let a = cam[0], b = cam[cam.length - 1];
  for (let i = 0; i < cam.length - 1; i += 1) if (st >= cam[i][0] && st <= cam[i + 1][0]) { a = cam[i]; b = cam[i + 1]; }
  const k = b[0] === a[0] ? 1 : inOut((st - a[0]) / (b[0] - a[0]));
  const mix = (u, v) => u + (v - u) * k;
  if (st <= cam[0][0]) { a = b = cam[0]; }
  return [mix(a[1], b[1]), mix(a[2], b[2]), mix(a[3], b[3])];
}
function splitSlots() {
  const gap = 8;
  if (S.format === 'vertical') {
    const h = (H - gap) / 2;
    return [{ x: 0, y: 0, w: W, h: h }, { x: 0, y: h + gap, w: W, h: h }];
  }
  const w = (W - gap) / 2;
  return [{ x: 0, y: 0, w: w, h: H }, { x: w + gap, y: 0, w: w, h: H }];
}
function addChrome(host, kind) {
  if (kind === 'phone') {
    host.style.borderRadius = '42px';
    const bezel = el('div', 'position:absolute;inset:0;border-radius:42px;box-shadow:inset 0 0 0 14px #16161a;pointer-events:none;z-index:3', host);
    bezel.dataset.decor = '1';
    const notch = el('div', 'position:absolute;top:8px;left:50%;width:26%;height:18px;transform:translateX(-50%);background:#16161a;border-radius:10px;pointer-events:none;z-index:4', host);
    notch.dataset.decor = '1';
  } else if (kind === 'browser') {
    const bar = el('div', 'position:absolute;left:0;right:0;top:0;height:28px;display:flex;align-items:center;gap:6px;padding:0 10px;background:#eceae4;pointer-events:none;z-index:3', host);
    bar.dataset.decor = '1';
    ['#ff5f57', '#febc2e', '#28c840'].forEach((color) => { const dot = el('div', 'width:8px;height:8px;border-radius:50%;background:' + color, bar); dot.dataset.decor = '1'; });
  }
}
const built = S.scenes.map((sc) => {
  const root = el('div', 'position:absolute;inset:0;display:none;transform-origin:50% 50%', stage);
  const slots = sc.layout === 'split' ? splitSlots() : [];
  let slotAt = 0;
  const layers = sc.layers.map((l) => {
    const place = (l.type === 'clip' || l.type === 'image') && slotAt < slots.length ? slots[slotAt++] : null;
    if (l.type === 'clip') {
      const full = l.box === 'full';
      const [x, y, w, h] = full ? [0, 0, W, H] : l.box;
      const radius = full ? 0 : (l.radius ?? 26);
      let host, frame;
      if (place) {
        const fit = Math.max(place.w / w, place.h / h);
        host = el('div', 'position:absolute;left:' + place.x + 'px;top:' + place.y + 'px;width:' + place.w + 'px;height:' + place.h + 'px;overflow:hidden', root);
        frame = el('div', 'position:absolute;left:50%;top:50%;width:' + w + 'px;height:' + h + 'px;overflow:hidden;isolation:isolate;transform:translate(-50%,-50%) scale(' + fit + ');background:#fff;border-radius:' + radius + 'px', host);
      } else {
        host = el('div', 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px', root);
        if (!full && l.shadow) {
          const sw = Math.round(w * .76), sh = Math.max(18, Math.round(h * .06));
          const ell = el('div', 'position:absolute;left:' + Math.round((w - sw) / 2) + 'px;top:' + (h - Math.round(sh * .4)) + 'px;width:' + sw + 'px;height:' + sh + 'px;border-radius:50%;background:rgba(0,0,0,.5);filter:blur(16px);pointer-events:none', host);
          ell.dataset.decor = '1';
        }
        frame = el('div', 'position:absolute;inset:0;overflow:hidden;isolation:isolate;background:#fff;border-radius:' + radius + 'px;' + (full ? '' : 'box-shadow:0 34px 110px rgba(0,0,0,.6)'), host);
      }
      const img = el('img', 'position:absolute;left:0;top:0;max-width:none', frame);
      paintFinish(frame, img, l);
      const spot = l.spotlight ? el('div', 'position:absolute;inset:0;pointer-events:none', frame) : null;
      if (spot) spot.dataset.decor = '1';
      const marks = (l.overlays ?? []).map((o) => { const m = el('div', 'position:absolute;display:flex;align-items:center;white-space:nowrap;font:800 16px ' + S.pal.font + ';letter-spacing:-.02em;color:' + (o.color ?? '#fff') + ';background:' + (o.fill ?? 'transparent'), frame); m.textContent = o.text ?? ''; return { o, m }; });
      if (l.chrome) addChrome(host, l.chrome);
      return { l, node: host, img, w, h, marks, spot };
    }
    if (l.type === 'text') {
      const node = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + (l.w ?? (W - M * 2)) + 'px;text-align:' + (l.align ?? 'center') + ';font:' + (l.weight ?? 800) + ' ' + l.size + 'px/' + (l.lh ?? 1.08) + ' ' + (l.font ?? S.pal.font) + ';letter-spacing:' + (l.ls ?? '-.02em') + ';color:' + S.pal.fg + ';text-shadow:0 6px 40px rgba(0,0,0,.45)', root);
      const parts = [];
      l.lines.forEach((line, li) => {
        const text = Array.isArray(line) ? line[0] : line;
        const accent = Array.isArray(line) ? line[1] : false;
        const row = el('div', 'overflow:' + (l.anim === 'mask' ? 'hidden' : 'visible') + ';padding-bottom:.08em', node);
        if (accent) row.style.color = S.pal.accent;
        if (l.anim === 'words') {
          text.split(' ').forEach((word) => { const s = el('span', 'display:inline-block;margin-right:.26em;will-change:transform', row); s.textContent = word; parts.push(s); });
        } else { const s = el('div', 'will-change:transform', row); s.textContent = text; s.dataset.li = li; parts.push(s); }
      });
      return { l, node, parts };
    }
    if (l.type === 'count') {
      const node = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + (l.w ?? (W - M * 2)) + 'px;text-align:' + (l.align ?? 'center') + ';font:800 ' + l.size + 'px/1 ' + (l.font ?? S.pal.font) + ';letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:' + (l.accent ? S.pal.accent : S.pal.fg) + ';text-shadow:0 8px 50px rgba(0,0,0,.45)', root);
      return { l, node };
    }
    if (l.type === 'bars') {
      const node = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;height:' + l.h + 'px;display:flex;align-items:flex-end;gap:' + (l.gap ?? 2) + 'px', root);
      const bars = Array.from({ length: l.n }, () => el('div', 'flex:1;background:' + S.pal.accent + ';border-radius:3px 3px 0 0;height:0', node));
      return { l, node, bars };
    }
    if (l.type === 'image') {
      if (l.cam) {
        const x = place ? place.x : l.x, y = place ? place.y : l.y, w = place ? place.w : l.w, h = place ? place.h : (l.h || l.w);
        const frame = el('div', 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;overflow:hidden;isolation:isolate;border-radius:' + (l.radius ?? 0) + 'px', root);
        const img = el('img', 'position:absolute;left:0;top:0;max-width:none', frame);
        img.src = l.src;
        paintFinish(frame, img, l);
        return { l, node: frame, img, w: w, h: h, lockH: !!(place || l.h) };
      }
      if (place) {
        const frame = el('div', 'position:absolute;left:' + place.x + 'px;top:' + place.y + 'px;width:' + place.w + 'px;height:' + place.h + 'px;overflow:hidden;isolation:isolate;border-radius:' + (l.radius ?? 0) + 'px', root);
        const img = el('img', 'display:block;width:100%;height:100%;object-fit:cover', frame);
        img.src = l.src;
        paintFinish(frame, img, l);
        return { l, node: frame, img };
      }
      const frame = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;border-radius:' + (l.radius ?? 0) + 'px;overflow:hidden;isolation:isolate', root);
      const img = el('img', 'display:block;width:100%;height:auto', frame);
      img.src = l.src;
      paintFinish(frame, img, l);
      return { l, node: frame, img };
    }
    if (l.type === 'lower') {
      const node = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;height:' + l.h + 'px;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:10px 16px 12px 14px;background:' + S.pal.bg + ';border-left:4px solid ' + S.pal.accent + ';border-radius:0 14px 14px 0', root);
      node.setAttribute('data-critique', '1');
      const name = el('div', 'font:800 ' + (l.size || 32) + 'px/1.1 ' + S.pal.font + ';letter-spacing:-.03em;color:' + S.pal.fg, node);
      name.textContent = l.name || '';
      const line = el('div', 'font:600 ' + (l.lineSize || Math.round((l.size || 32) * .7)) + 'px/1.2 ' + S.pal.font + ';color:' + S.pal.fg, node);
      line.textContent = l.line || '';
      return { l, node };
    }
    if (l.type === 'sticker') {
      const node = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;z-index:34;pointer-events:none', root);
      if (l.shape === 'arrow' && Array.isArray(l.point)) {
        const x1 = 18, y1 = 18, dx = l.point[0] - l.x, dy = l.point[1] - l.y;
        const len = Math.max(1, Math.hypot(dx - x1, dy - y1));
        const ang = Math.atan2(dy - y1, dx - x1) * 180 / Math.PI;
        const shaft = el('div', 'position:absolute;height:3px;border-radius:2px;background:' + S.pal.accent + ';transform-origin:0 50%;width:' + len + 'px', node);
        shaft.style.left = x1 + 'px';
        shaft.style.top = (y1 - 1) + 'px';
        shaft.style.transform = 'rotate(' + ang + 'deg)';
        const head = el('div', 'position:absolute;width:12px;height:12px;background:' + S.pal.accent + ';transform:translate(-50%,-50%) rotate(45deg)', node);
        head.style.left = dx + 'px';
        head.style.top = dy + 'px';
      }
      const step = l.shape === 'step';
      const label = el('div', step
        ? 'position:relative;width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:' + S.pal.accent + ';color:' + S.pal.bg + ';font:800 28px/1 ' + S.pal.font
        : 'position:relative;display:inline-flex;align-items:center;padding:8px 14px;border-radius:999px;background:' + S.pal.accent + ';color:' + S.pal.bg + ';font:800 22px/1 ' + S.pal.font + ';letter-spacing:-.02em;white-space:nowrap', node);
      label.textContent = l.text || '';
      return { l, node };
    }
    if (l.type === 'endcard') {
      const card = S.endcard || {};
      const node = el('div', 'position:absolute;left:' + M + 'px;right:' + M + 'px;top:' + MY + 'px;bottom:' + MY + 'px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:.35em', root);
      const markText = l.mark || card.mark || '';
      const mark = markText ? el('div', 'font:800 ' + Math.round(H * .2) + 'px/.9 ' + S.pal.font + ';letter-spacing:-.04em;color:' + S.pal.accent, node) : null;
      if (mark) mark.textContent = markText;
      const name = el('div', 'font:800 ' + Math.round(H * .086) + 'px/1.02 ' + S.pal.font + ';letter-spacing:-.035em;color:' + S.pal.fg, node);
      name.textContent = l.name || card.name || '';
      const line = el('div', 'font:600 ' + Math.round(H * .034) + 'px/1.25 ' + S.pal.font + ';color:' + S.pal.fg + ';max-width:18em', node);
      line.textContent = l.line || card.line || '';
      const url = el('div', 'font:700 ' + Math.round(H * .026) + 'px/1.2 ' + S.pal.font + ';letter-spacing:.01em;color:' + S.pal.accent + ';margin-top:.4em', node);
      url.textContent = l.url || card.url || '';
      let credit = null;
      const creditText = (S.music && S.music.credit) || '';
      if (creditText) {
        credit = el('div', 'position:absolute;left:0;right:0;bottom:0;font:500 ' + Math.round(H * .016) + 'px/1.3 ' + S.pal.font + ';letter-spacing:.01em;color:' + S.pal.fg + ';opacity:0', node);
        credit.textContent = creditText;
      }
      return { l, node, name, line, url, mark, credit };
    }
    const node = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;height:' + l.h + 'px;border-radius:' + (l.radius ?? 0) + 'px;background:' + l.fill, root);
    return { l, node };
  });
  return { sc, root, layers };
});
const overlays = (S.overlays || []).map((l) => {
  if (l.type === 'text') {
    const node = el('div', 'position:absolute;z-index:30;left:' + l.x + 'px;top:' + l.y + 'px;width:' + (l.w ?? (W - M * 2)) + 'px;text-align:' + (l.align ?? 'center') + ';font:' + (l.weight ?? 800) + ' ' + l.size + 'px/' + (l.lh ?? 1.08) + ' ' + (l.font ?? S.pal.font) + ';letter-spacing:' + (l.ls ?? '-.02em') + ';color:' + S.pal.fg + ';text-shadow:0 6px 40px rgba(0,0,0,.45)', stage);
    const parts = [];
    (l.lines || []).forEach((line, li) => {
      const text = Array.isArray(line) ? line[0] : line;
      const accent = Array.isArray(line) ? line[1] : false;
      const row = el('div', 'overflow:' + (l.anim === 'mask' ? 'hidden' : 'visible') + ';padding-bottom:.08em', node);
      if (accent) row.style.color = S.pal.accent;
      if (l.anim === 'words') {
        String(text).split(' ').forEach((word) => { const s = el('span', 'display:inline-block;margin-right:.26em;will-change:transform', row); s.textContent = word; parts.push(s); });
      } else { const s = el('div', 'will-change:transform', row); s.textContent = text; s.dataset.li = li; parts.push(s); }
    });
    return { l, node, parts };
  }
  if (l.type === 'image') {
    const node = el('img', 'position:absolute;z-index:30;left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;' + (l.h == null ? '' : 'height:' + l.h + 'px;') + 'border-radius:' + (l.radius ?? 0) + 'px', stage);
    node.src = l.src;
    return { l, node };
  }
  return null;
}).filter(Boolean);
const scrim = el('div', 'position:absolute;left:0;right:0;bottom:0;z-index:39;pointer-events:none;background:linear-gradient(transparent, ' + S.pal.bg + ')', stage);
const cap = el('div', 'position:absolute;z-index:40;text-align:center;font-weight:700;letter-spacing:-.02em;line-height:1.15;text-wrap:balance;color:' + S.pal.fg + ';font-family:' + S.pal.font + ';text-shadow:0 2px 18px rgba(0,0,0,.45)', stage);
cap.raise = (S.caption && +S.caption.raise) || 0;
cap.style.left = M + 'px';
cap.style.right = M + 'px';
cap.style.bottom = (MY + cap.raise) + 'px';
cap.style.fontSize = Math.round(H * .037) + 'px';
scrim.style.height = Math.round(MY * 2.1 + cap.raise) + 'px';
const veil = el('div', 'position:absolute;inset:0;z-index:45;pointer-events:none;background:' + S.pal.bg + ';opacity:0', stage);
const shutter = el('div', 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:50', stage);
const bands = [S.pal.accent, S.pal.glow || S.pal.accent, S.pal.bg].map((c) => el('div', 'position:absolute;top:-30%;height:160%;width:170%;background:' + c + ';transform:translateX(-140%) skewX(-16deg)', shutter));
function setRich(node, text) {
  const raw = String(text == null ? '' : text);
  if (node.dataset.raw === raw) return;
  node.dataset.raw = raw;
  node.replaceChildren();
  const parts = raw.split('*');
  if (parts.length % 2 === 0) { node.textContent = parts.join(''); return; }
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) { const s = document.createElement('span'); s.style.color = S.pal.accent; s.textContent = part; node.appendChild(s); }
    else node.appendChild(document.createTextNode(part));
  });
}

window.seek = async (t) => {
  const beat = (t % .5) / .5, pulse = Math.pow(1 - beat, 3);
  const punchPeriod = 60 / ((S.music && S.music.bpm) || 120);
  const punchImpulse = Math.pow(1 - ((t % punchPeriod) / punchPeriod), 3);
  if (mode === 'blobs') {
    blobA.style.transform = 'translate(' + (W * .12 + Math.sin(t * .55) * W * .16) + 'px,' + (-H * .14 + Math.cos(t * .42) * H * .1) + 'px) scale(' + (1 + pulse * .07) + ')';
    blobB.style.transform = 'translate(' + (W * .42 + Math.cos(t * .38) * W * .18) + 'px,' + (H * .18 + Math.sin(t * .5) * H * .12) + 'px)';
  }
  if (mode !== 'flat') grid.style.transform = 'translate(' + ((t * 34) % 80) + 'px,' + ((t * 20) % 80) + 'px)';
  const waits = [];
  for (const { sc, root, layers } of built) {
    const on = t >= sc.s && t < sc.e;
    root.style.display = on ? 'block' : 'none';
    if (!on) continue;
    const st = t - sc.s;
    const push = 1 + (sc.push ?? (sc.wipe === 'cut' ? 0 : .035)) * (st / (sc.e - sc.s));
    const hit = sc.punch ? 1 + .04 * punchImpulse : 1;
    const slide = sc.wipe === 'push' && sc.s > 0 ? 'translateX(' + ((1 - out3(clamp(st / .36))) * -100) + '%) ' : '';
    root.style.transform = slide + 'scale(' + (push * hit) + ')';
    if (sc.wipe === 'iris' && sc.s > 0) {
      const k = clamp(st / .4);
      root.style.clipPath = k >= 1 ? 'none' : 'circle(' + (k * 71) + '% at 50% 50%)';
    } else root.style.clipPath = 'none';
    for (const item of layers) {
      const { l, node } = item, at = l.at ?? 0;
      if (l.type === 'clip') {
        const p = outBack((st - at) / .5);
        const vis = st >= at && (l.dur == null || st < at + l.dur);
        node.style.opacity = vis ? (l.dim ?? 1) : 0;
        const tilt = l.tilt ?? 0;
        node.style.transform = l.box === 'full' ? '' : 'perspective(1600px) rotateY(' + (tilt * (1 - clamp((st - at) / 1.2))) + 'deg) translateY(' + (1 - p) * 90 + 'px) scale(' + (.92 + .08 * p) + ')';
        if (!vis) continue;
        const tk = T[l.take], vw = tk.viewport.width, vh = tk.viewport.height, frames = tk.frames;
        const raw = clipTime(l, st);
        const ct = Math.min(frames[frames.length - 1].t, Math.max(frames[0].t, raw));
        const crop = tk.crop || {}, cL = crop.left || 0, cT = crop.top || 0, cR = crop.right || 0, cB = crop.bottom || 0;
        const ox = cL * vw, oy = cT * vh, sw = Math.max(1, vw * (1 - cL - cR)), sh = Math.max(1, vh * (1 - cT - cB));
        let z = l.zoom ?? 1, cx = l.cx ?? ox + sw / 2, cy = l.cy ?? oy + sh / 2;
        if (l.follow) { const c = cursorAt(l.take, ct); if (c) { cx = c[0]; cy = c[1]; } }
        if (l.cam) {
          const cam = blendCam(l.cam, st);
          cx = cam[0]; cy = cam[1]; z = cam[2];
        }
        const K = Math.max(item.w / sw, item.h / sh) * z, iw = vw * K;
        const left = clamp(item.w / 2 - cx * K, item.w - (ox + sw) * K, -ox * K), top = clamp(item.h / 2 - cy * K, item.h - (oy + sh) * K, -oy * K);
        item.img.style.width = iw + 'px'; item.img.style.left = left + 'px'; item.img.style.top = top + 'px';
        item.marks.forEach(({ o, m }) => { m.style.left = (left + o.x * K) + 'px'; m.style.top = (top + o.y * K) + 'px'; m.style.width = (o.w * K) + 'px'; m.style.height = (o.h * K) + 'px'; m.style.fontSize = ((o.size ?? 16) * K) + 'px'; m.style.paddingLeft = (6 * K) + 'px'; });
        if (item.spot) {
          const c = cursorAt(l.take, ct);
          const sx = c ? left + c[0] * K : item.w / 2, sy = c ? top + c[1] * K : item.h / 2;
          const rad = Math.max(item.w, item.h) * .42;
          item.spot.style.background = 'radial-gradient(circle ' + rad + 'px at ' + sx + 'px ' + sy + 'px, rgba(0,0,0,0) 0%, rgba(0,0,0,.62) 100%)';
        }
        const src = (S.takesPrefix || 'takes') + '/' + l.take + '/' + frameAt(l.take, ct);
        if (item.src !== src) { item.src = src; item.img.src = src; waits.push(item.img.decode().catch(() => {})); }
      } else if (l.type === 'text') {
        const exit = l.exit > 0 ? l.exit : 0;
        const until = l.until != null ? l.until : (sc.e - sc.s);
        const gone = exit > 0 ? st >= until : (l.until !== undefined && st >= l.until);
        node.style.visibility = gone ? 'hidden' : 'visible';
        const leave = exit > 0 ? clamp((st - (until - exit)) / exit) : 0;
        item.parts.forEach((part, i) => {
          const d = at + i * (l.stagger ?? (l.anim === 'words' ? .085 : .22)), x = st - d;
          if (leave > 0 && st < until) {
            part.style.opacity = String(1 - leave);
            part.style.transformOrigin = '50% 50%';
            part.style.transform = l.anim === 'mask' ? 'translateY(' + (leave * 112) + '%)' : 'translateY(' + (leave * 46) + 'px)';
          } else if (l.anim === 'slam') {
            const k = clamp(x / .22), s = 1.5 - .5 * outBack(x / .3);
            part.style.opacity = k; part.style.transform = 'scale(' + s + ')';
            part.style.transformOrigin = '50% 60%';
          } else if (l.anim === 'mask') {
            part.style.transform = 'translateY(' + (1 - out3(x / .42)) * 112 + '%)';
          } else {
            part.style.opacity = clamp(x / .16);
            part.style.transform = 'translateY(' + (1 - outBack(x / .34)) * 46 + 'px) rotate(' + (1 - out3(x / .34)) * 4 + 'deg)';
          }
        });
      } else if (l.type === 'lower') {
        const dur = sc.e - sc.s;
        const end = Math.min(l.until != null ? l.until : dur, dur);
        if (st < at || st >= end) { node.style.visibility = 'hidden'; node.style.opacity = '0'; }
        else {
          const inn = clamp((st - at) / .25), out = clamp((st - (end - .25)) / .25), k = Math.min(inn, 1 - out);
          node.style.visibility = 'visible';
          node.style.opacity = String(k);
          node.style.transform = 'translateY(' + ((inn < 1 ? (1 - inn) : out) * 18) + 'px)';
        }
      } else if (l.type === 'sticker') {
        node.style.opacity = st >= at ? '1' : '0';
      } else if (l.type === 'endcard') {
        const p = out3((st - at) / .45);
        node.style.opacity = st >= at ? 1 : 0;
        node.style.transform = 'translateY(' + (1 - p) * 36 + 'px)';
        if (item.mark) {
          const showMark = st - at < .6;
          item.mark.style.display = showMark ? 'block' : 'none';
          item.name.style.display = showMark ? 'none' : '';
          item.line.style.display = showMark ? 'none' : '';
          item.url.style.display = showMark ? 'none' : '';
          item.mark.style.transform = showMark ? 'scale(' + (1.45 - .45 * out3(Math.max(0, st - at) / .6)) + ')' : '';
        }
        if (item.credit) {
          const last = built[built.length - 1].sc;
          item.credit.style.opacity = (sc === last && t >= last.e - 2) ? '.72' : '0';
        }
      } else if (l.type === 'count') {
        const k = out3((st - at) / (l.dur ?? 1.2));
        node.style.opacity = st >= at ? 1 : 0;
        let v = l.from + (l.to - l.from) * k;
        if (l.steps) { let cur = l.from; for (const [when, val] of l.steps) { if (st >= when) { const q = out3((st - when) / .4); v = cur + (val - cur) * q; cur = val; } } }
        const d = l.decimals ?? 0;
        node.textContent = (l.prefix ?? '') + v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }) + (l.suffix ?? '');
        node.style.transform = 'scale(' + (1 + (st >= at + (l.dur ?? 1.2) ? 0 : .02)) + ')';
      } else if (l.type === 'bars') {
        const shown = out3((st - at) / (l.dur ?? 1.6)) * l.n;
        item.bars.forEach((b, i) => { const g = clamp(shown - i); b.style.height = (((i + 1) / l.n) * 100 * g) + '%'; b.style.opacity = g > 0 ? 1 : 0; });
      } else if (l.type === 'image') {
        if (l.cam && item.img) {
          node.style.opacity = st >= at ? 1 : 0;
          const pan = () => {
            const nw = item.img.naturalWidth, nh = item.img.naturalHeight;
            if (!nw || !nh) return;
            if (!item.lockH) {
              item.h = item.w * nh / nw;
              node.style.height = item.h + 'px';
              item.lockH = true;
            }
            const fw = item.w, fh = item.h, cam = blendCam(l.cam, st);
            const cx = cam[0] * nw, cy = cam[1] * nh, z = cam[2];
            const K = Math.max(fw / nw, fh / nh) * z;
            const iw = nw * K, ih = nh * K;
            item.img.style.width = iw + 'px';
            item.img.style.height = ih + 'px';
            item.img.style.left = clamp(fw / 2 - cx * K, fw - iw, 0) + 'px';
            item.img.style.top = clamp(fh / 2 - cy * K, fh - ih, 0) + 'px';
          };
          if (item.img.naturalWidth) pan();
          else waits.push(item.img.decode().then(pan).catch(() => {}));
        } else {
          const p = outBack((st - at) / .45);
          node.style.opacity = st >= at ? 1 : 0;
          node.style.transform = 'scale(' + (.6 + .4 * p) + ') rotate(' + (1 - out3((st - at) / .45)) * -10 + 'deg)';
        }
      } else {
        node.style.opacity = st >= at ? (l.opacity ?? 1) : 0;
      }
    }
  }
  for (const item of overlays) {
    const { l, node } = item;
    const on = t >= l.s && t < l.e;
    node.style.display = on ? 'block' : 'none';
    if (!on) continue;
    const st = t - l.s, at = l.at ?? 0;
    if (l.type === 'text') {
      node.style.visibility = l.until !== undefined && st >= l.until ? 'hidden' : 'visible';
      item.parts.forEach((part, i) => {
        const d = at + i * (l.stagger ?? (l.anim === 'words' ? .085 : .22)), x = st - d;
        if (l.anim === 'slam') {
          const k = clamp(x / .22), s = 1.5 - .5 * outBack(x / .3);
          part.style.opacity = k; part.style.transform = 'scale(' + s + ')';
          part.style.transformOrigin = '50% 60%';
        } else if (l.anim === 'mask') {
          part.style.transform = 'translateY(' + (1 - out3(x / .42)) * 112 + '%)';
        } else {
          part.style.opacity = clamp(x / .16);
          part.style.transform = 'translateY(' + (1 - outBack(x / .34)) * 46 + 'px) rotate(' + (1 - out3(x / .34)) * 4 + 'deg)';
        }
      });
    } else if (l.type === 'image') {
      const p = outBack((st - at) / .45);
      node.style.opacity = st >= at ? 1 : 0;
      node.style.transform = 'scale(' + (.6 + .4 * p) + ') rotate(' + (1 - out3((st - at) / .45)) * -10 + 'deg)';
    }
  }
  let shown = null;
  const burn = S.burnCaptions !== false;
  for (const c of S.captions || []) if (t >= c.s && t < c.e) shown = c;
  if (!burn || !shown) { cap.style.opacity = 0; scrim.style.opacity = 0; }
  else {
    const raise = shown.raise || 0;
    const pill = shown.style === 'pill';
    cap.style.bottom = (MY + raise) + 'px';
    cap.style.background = pill ? S.pal.bg : 'transparent';
    cap.style.borderRadius = pill ? '999px' : '0';
    cap.style.padding = pill ? '.42em .9em' : '0';
    cap.style.boxShadow = pill ? '0 10px 40px rgba(0,0,0,.35)' : 'none';
    if (pill) {
      cap.style.left = '50%'; cap.style.right = 'auto'; cap.style.width = 'max-content'; cap.style.maxWidth = (W - M * 2) + 'px'; cap.style.transform = 'translateX(-50%)';
    } else {
      cap.style.left = M + 'px'; cap.style.right = M + 'px'; cap.style.width = 'auto'; cap.style.maxWidth = 'none'; cap.style.transform = 'none';
    }
    cap.style.opacity = clamp((t - shown.s) / .12);
    scrim.style.height = Math.round(MY * 2.1 + raise) + 'px';
    scrim.style.opacity = pill ? 0 : cap.style.opacity;
    setRich(cap, shown.text);
  }
  let dip = 0;
  for (const { sc } of built) {
    if ((sc.wipe === 'dip' || sc.wipe === 'fade') && sc.s > 0) {
      const span = sc.wipe === 'fade' ? .6 : .28;
      dip = Math.max(dip, 1 - Math.abs(t - sc.s) / span);
    }
  }
  veil.style.opacity = String(Math.max(0, dip));
  let w = 0, active = false;
  for (const { sc } of built) if ((sc.wipe === 'shutter' || sc.wipe === true) && sc.s > 0 && Math.abs(t - sc.s) < .24) { w = (t - sc.s + .24) / .48; active = true; }
  bands.forEach((b, i) => {
    if (!active) { b.style.transform = 'translateX(-140%) skewX(-16deg)'; return; }
    const k = inOut(clamp(w * 1.25 - i * .12));
    b.style.transform = 'translateX(' + (-140 + k * 260) + '%) skewX(-16deg)';
  });
  await Promise.all(waits);
};
window.ready = Promise.all([...new Set([700, 800].map((w) => document.fonts.load(w + ' 40px ' + S.pal.font).catch(() => {})))]).then(() => document.fonts.ready);
`;

const fileUrl = (p) => pathToFileURL(p).href;

function escapeMeta(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\\n').replace(/([=;#])/g, '\\$1');
}

function markerTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const time = value.t ?? value.time ?? value.start;
    if (typeof time === 'number' && Number.isFinite(time)) return time;
  }
  return null;
}

function chapterCues(markers, duration) {
  if (!markers || typeof markers !== 'object') return [];
  const span = Math.max(0, duration);
  const raw = Array.isArray(markers)
    ? markers.map((entry) => {
      const time = markerTime(entry);
      const title = entry && (entry.title || entry.name);
      return time == null || !title ? null : { t: time, title: String(title) };
    })
    : Object.entries(markers).map(([key, value]) => {
      const time = markerTime(value);
      if (time == null) return null;
      const title = value && typeof value === 'object' && (value.title || value.name) ? String(value.title || value.name) : key;
      return { t: time, title };
    });
  const points = raw.filter(Boolean)
    .map((entry) => ({ ...entry, t: Math.min(span, Math.max(0, entry.t)) }))
    .sort((a, b) => a.t - b.t);
  const chapters = [];
  for (let i = 0; i < points.length; i += 1) {
    const start = Math.round(points[i].t * 1000);
    const end = Math.round((i + 1 < points.length ? points[i + 1].t : span) * 1000);
    if (end <= start) continue;
    chapters.push({ start, end, title: points[i].title });
  }
  return chapters;
}

function writeFfmetadata(spec, duration, file) {
  const lines = [';FFMETADATA1'];
  if (typeof spec.title === 'string' && spec.title.trim()) lines.push(`title=${escapeMeta(spec.title.trim())}`);
  if (typeof spec.endcard?.url === 'string' && spec.endcard.url.trim()) lines.push(`comment=${escapeMeta(spec.endcard.url.trim())}`);
  for (const chapter of chapterCues(spec.markers, duration)) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${chapter.start}`, `END=${chapter.end}`, `title=${escapeMeta(chapter.title)}`);
  }
  if (lines.length === 1) return false;
  writeFileSync(file, `${lines.join('\n')}\n`);
  return true;
}

function pageSpec(spec) {
  const stage = FORMATS[spec.format] ?? FORMATS.landscape;
  const copy = structuredClone(spec);
  copy.width = spec.width ?? stage.width;
  copy.height = spec.height ?? stage.height;
  copy.margin = spec.margin ?? stage.margin;
  copy.marginY = spec.marginY ?? stage.marginY;
  copy.background = spec.background ?? 'blobs';
  const raise = Number(spec.caption?.raise);
  copy.caption = { ...(spec.caption && typeof spec.caption === 'object' ? spec.caption : {}), raise: Number.isFinite(raise) ? raise : 0 };
  copy.takesPrefix = spec.out && spec.takes ? relative(spec.out, spec.takes).replaceAll('\\', '/') || '.' : 'takes';
  const root = spec.out ?? '.';
  const localize = (layer) => {
    if (layer.type === 'image' && layer.src && !/^(https?:|file:|data:)/.test(layer.src)) {
      layer.src = fileUrl(isAbsolute(layer.src) ? layer.src : resolve(root, layer.src));
    }
  };
  for (const scene of copy.scenes ?? []) {
    for (const layer of scene.layers ?? []) localize(layer);
  }
  for (const layer of copy.overlays ?? []) localize(layer);
  return copy;
}

function sceneFramesReady(dir, count) {
  if (count < 1) return false;
  for (let i = 0; i < count; i += 1) {
    if (!existsSync(`${dir}/${String(i).padStart(5, '0')}.jpg`)) return false;
  }
  return true;
}

export async function compose(spec, { playwright, mode = 'final', times = [], base = 'brag' } = {}) {
  const { chromium } = await import(fileUrl(playwright));
  const work = `${spec.out}/work`;
  mkdirSync(`${work}/frames`, { recursive: true });
  const drawn = pageSpec(spec);
  const takes = {};
  for (const name of new Set(drawn.scenes.flatMap((s) => s.layers.filter((l) => l.type === 'clip').map((l) => l.take)))) {
    const idx = JSON.parse(readFileSync(`${spec.takes}/${name}/index.json`));
    takes[name] = { viewport: idx.viewport, crop: idx.crop, frames: idx.frames, moves: idx.events.filter((e) => ['move', 'step', 'click', 'down'].includes(e.type)).map((e) => ({ t: e.t, x: e.x, y: e.y })), events: idx.events };
  }
  const pageFile = `${spec.out}/${drawn.id}-${drawn.format}-stage.html`;
  writeFileSync(pageFile, `<!doctype html><meta charset="utf-8">${drawn.pal.fontLink ? `<link rel="stylesheet" href="${drawn.pal.fontLink}">` : ''}<style>html,body{margin:0;width:${drawn.width}px;height:${drawn.height}px;overflow:hidden;background:${drawn.pal.bg}}#stage{position:absolute;inset:0;overflow:hidden}</style><div id="stage"></div><script>window.SPEC=${JSON.stringify(drawn)};window.TAKES=${JSON.stringify(takes)};</script><script>${clipTime.toString()}
${RUNTIME}</script>`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: drawn.width, height: drawn.height } });
  page.on('pageerror', (e) => console.log('page error', e.message));
  await page.goto(fileUrl(pageFile));
  await page.evaluate(() => window.ready);
  const shoot = async (t, path, quality = 93) => {
    await page.evaluate((x) => window.seek(x), t);
    await page.screenshot({ path, type: 'jpeg', quality });
  };
  if (mode === 'stills') {
    mkdirSync(`${work}/stills`, { recursive: true });
    const manifest = [];
    for (let i = 0; i < times.length; i += 1) {
      const name = `${String(i).padStart(2, '0')}.jpg`;
      await shoot(times[i], `${work}/stills/${name}`, 70);
      manifest.push({ t: times[i], file: name });
    }
    writeFileSync(`${work}/stills.json`, JSON.stringify(manifest, null, 2));
    await browser.close();
    return manifest;
  }
  const fps = spec.fps ?? 30;
  const jobs = (spec.scenes ?? []).map((scene) => {
    const hash = sceneKey(spec, scene).slice(0, 16);
    const count = Math.max(0, Math.round((scene.e - scene.s) * fps));
    const dir = `${work}/scenes/${spec.format ?? 'landscape'}/${hash}`;
    return { scene, hash, count, dir };
  });
  let shot = 0;
  let reused = 0;
  for (const job of jobs) {
    if (job.count < 1) continue;
    if (sceneFramesReady(job.dir, job.count)) {
      reused += 1;
      continue;
    }
    mkdirSync(job.dir, { recursive: true });
    for (let f = 0; f < job.count; f += 1) {
      let t = job.scene.s + f / fps;
      if (t >= job.scene.e) t = job.scene.e - 1 / (fps * 2);
      await shoot(t, `${job.dir}/${String(f).padStart(5, '0')}.jpg`);
    }
    shot += 1;
  }
  console.log(`scenes: ${reused} reused, ${shot} shot`);
  rmSync(`${work}/frames`, { recursive: true, force: true });
  mkdirSync(`${work}/frames`, { recursive: true });
  let assembled = 0;
  for (const job of jobs) {
    for (let f = 0; f < job.count; f += 1) {
      copyFileSync(`${job.dir}/${String(f).padStart(5, '0')}.jpg`, `${work}/frames/${String(assembled).padStart(5, '0')}.jpg`);
      assembled += 1;
    }
  }
  await browser.close();
  if (assembled < 1) throw new Error('no scene frames to assemble');
  const posterTime = spec.poster ?? 0;
  let posterFrame = 0;
  let cursor = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    const { scene, count } = jobs[i];
    const holds = count > 0 && posterTime >= scene.s && (posterTime < scene.e || i === jobs.length - 1);
    if (!holds) {
      cursor += count;
      continue;
    }
    posterFrame = cursor + Math.min(count - 1, Math.max(0, Math.round((posterTime - scene.s) * fps)));
    break;
  }
  posterFrame = Math.min(assembled - 1, Math.max(0, posterFrame));
  copyFileSync(`${work}/frames/${String(posterFrame).padStart(5, '0')}.jpg`, `${spec.out}/${base}.jpg`);
  copyFileSync(`${work}/frames/${String(posterFrame).padStart(5, '0')}.jpg`, `${work}/frames/00000.jpg`);
  makeSoundtrack(spec, takes, `${work}/music.wav`);
  const pad = loopHoldPad(spec);
  if (spec.loopHold === true && pad === 0) console.warn('warning: loopHold skipped because the hold would pass 35.5s');
  const duration = spec.duration + pad;
  const meta = `${work}/ffmetadata.txt`;
  const hasMeta = writeFfmetadata(spec, duration, meta);
  const encode = ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', `${work}/frames/%05d.jpg`, '-i', `${work}/music.wav`];
  if (hasMeta) encode.push('-f', 'ffmetadata', '-i', meta);
  if (pad > 0) encode.push('-vf', `tpad=stop_mode=clone:stop_duration=${pad}`, '-af', `apad=pad_dur=${pad}`);
  encode.push('-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '224k');
  if (hasMeta) encode.push('-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '2', '-map_chapters', '2');
  encode.push('-movflags', '+faststart', '-t', String(duration), `${spec.out}/${base}.mp4`);
  execFileSync('ffmpeg', encode);
  rmSync(`${work}/frames`, { recursive: true, force: true });
  return { video: `${spec.out}/${base}.mp4`, poster: `${spec.out}/${base}.jpg` };
}
