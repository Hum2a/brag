// Composes a spec into a finished video. Every frame is a pure function of time.
//
//   await compose(spec, { playwright, mode: 'stills' | 'final', times, base })
//
// spec comes from spec.mjs (prepareSpec): width, height, margin, format, tone, captions,
// endcard, scenes. Clip layers play takes from live-capture. Image layers use local files.
// Tones pick the wipe (shutter, dip, cut, fade), type entrance, and background.
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { makeSoundtrack } from './live-sound.mjs';
import { FORMATS } from './spec.mjs';

const RUNTIME = String.raw`
const S = window.SPEC, T = window.TAKES;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const out3 = (x) => 1 - Math.pow(1 - clamp(x), 3);
const outBack = (x) => { x = clamp(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const inOut = (x) => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const el = (tag, css, parent) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (parent) parent.appendChild(e); return e; };
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
const built = S.scenes.map((sc) => {
  const root = el('div', 'position:absolute;inset:0;display:none;transform-origin:50% 50%', stage);
  const layers = sc.layers.map((l) => {
    if (l.type === 'clip') {
      const [x, y, w, h] = l.box === 'full' ? [0, 0, W, H] : l.box;
      const frame = el('div', 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;overflow:hidden;background:#fff;border-radius:' + (l.box === 'full' ? 0 : (l.radius ?? 26)) + 'px;' + (l.box === 'full' ? '' : 'box-shadow:0 34px 110px rgba(0,0,0,.6)'), root);
      const img = el('img', 'position:absolute;left:0;top:0;max-width:none', frame);
      const marks = (l.overlays ?? []).map((o) => { const m = el('div', 'position:absolute;display:flex;align-items:center;white-space:nowrap;font:800 16px ' + S.pal.font + ';letter-spacing:-.02em;color:' + (o.color ?? '#fff') + ';background:' + (o.fill ?? 'transparent'), frame); m.textContent = o.text ?? ''; return { o, m }; });
      return { l, node: frame, img, w, h, marks };
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
      const node = el('img', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;border-radius:' + (l.radius ?? 0) + 'px', root);
      node.src = l.src;
      return { l, node };
    }
    if (l.type === 'endcard') {
      const card = S.endcard || {};
      const node = el('div', 'position:absolute;left:' + M + 'px;right:' + M + 'px;top:' + MY + 'px;bottom:' + MY + 'px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:.35em', root);
      const name = el('div', 'font:800 ' + Math.round(H * .086) + 'px/1.02 ' + S.pal.font + ';letter-spacing:-.035em;color:' + S.pal.fg, node);
      name.textContent = l.name || card.name || '';
      const line = el('div', 'font:600 ' + Math.round(H * .034) + 'px/1.25 ' + S.pal.font + ';color:' + S.pal.fg + ';max-width:18em', node);
      line.textContent = l.line || card.line || '';
      const url = el('div', 'font:700 ' + Math.round(H * .026) + 'px/1.2 ' + S.pal.font + ';letter-spacing:.01em;color:' + S.pal.accent + ';margin-top:.4em', node);
      url.textContent = l.url || card.url || '';
      return { l, node, name, line, url };
    }
    const node = el('div', 'position:absolute;left:' + l.x + 'px;top:' + l.y + 'px;width:' + l.w + 'px;height:' + l.h + 'px;border-radius:' + (l.radius ?? 0) + 'px;background:' + l.fill, root);
    return { l, node };
  });
  return { sc, root, layers };
});
const scrim = el('div', 'position:absolute;left:0;right:0;bottom:0;z-index:39;pointer-events:none;background:linear-gradient(transparent, ' + S.pal.bg + ')', stage);
scrim.style.height = Math.round(MY * 2.1) + 'px';
const cap = el('div', 'position:absolute;z-index:40;text-align:center;font-weight:700;letter-spacing:-.02em;line-height:1.15;text-wrap:balance;color:' + S.pal.fg + ';font-family:' + S.pal.font + ';text-shadow:0 2px 18px rgba(0,0,0,.45)', stage);
cap.style.left = M + 'px';
cap.style.right = M + 'px';
cap.style.bottom = MY + 'px';
cap.style.fontSize = Math.round(H * .037) + 'px';
const veil = el('div', 'position:absolute;inset:0;z-index:45;pointer-events:none;background:' + S.pal.bg + ';opacity:0', stage);
const shutter = el('div', 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:50', stage);
const bands = [S.pal.accent, S.pal.glow || S.pal.accent, S.pal.bg].map((c) => el('div', 'position:absolute;top:-30%;height:160%;width:170%;background:' + c + ';transform:translateX(-140%) skewX(-16deg)', shutter));

window.seek = async (t) => {
  const beat = (t % .5) / .5, pulse = Math.pow(1 - beat, 3);
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
    root.style.transform = 'scale(' + push + ')';
    for (const item of layers) {
      const { l, node } = item, at = l.at ?? 0;
      if (l.type === 'clip') {
        const p = outBack((st - at) / .5);
        const vis = st >= at;
        node.style.opacity = vis ? (l.dim ?? 1) : 0;
        const tilt = l.tilt ?? 0;
        node.style.transform = l.box === 'full' ? '' : 'perspective(1600px) rotateY(' + (tilt * (1 - clamp((st - at) / 1.2))) + 'deg) translateY(' + (1 - p) * 90 + 'px) scale(' + (.92 + .08 * p) + ')';
        if (!vis) continue;
        const ct = (l.from ?? 0) + (st - at) * (l.speed ?? 1), tk = T[l.take], vw = tk.viewport.width, vh = tk.viewport.height;
        let z = l.zoom ?? 1, cx = l.cx ?? vw / 2, cy = l.cy ?? vh / 2;
        if (l.follow) { const c = cursorAt(l.take, ct); if (c) { cx = c[0]; cy = c[1]; } }
        if (l.cam) {
          let a = l.cam[0], b = l.cam[l.cam.length - 1];
          for (let i = 0; i < l.cam.length - 1; i += 1) if (st >= l.cam[i][0] && st <= l.cam[i + 1][0]) { a = l.cam[i]; b = l.cam[i + 1]; }
          const k = b[0] === a[0] ? 1 : inOut((st - a[0]) / (b[0] - a[0]));
          const mix = (u, v) => u + (v - u) * k;
          if (st <= l.cam[0][0]) { a = b = l.cam[0]; }
          cx = mix(a[1], b[1]); cy = mix(a[2], b[2]); z = mix(a[3], b[3]);
        }
        const K = Math.max(item.w / vw, item.h / vh) * z, iw = vw * K, ih = vh * K;
        const left = clamp(item.w / 2 - cx * K, item.w - iw, 0), top = clamp(item.h / 2 - cy * K, item.h - ih, 0);
        item.img.style.width = iw + 'px'; item.img.style.left = left + 'px'; item.img.style.top = top + 'px';
        item.marks.forEach(({ o, m }) => { m.style.left = (left + o.x * K) + 'px'; m.style.top = (top + o.y * K) + 'px'; m.style.width = (o.w * K) + 'px'; m.style.height = (o.h * K) + 'px'; m.style.fontSize = ((o.size ?? 16) * K) + 'px'; m.style.paddingLeft = (6 * K) + 'px'; });
        const src = (S.takesPrefix || 'takes') + '/' + l.take + '/' + frameAt(l.take, ct);
        if (item.src !== src) { item.src = src; item.img.src = src; waits.push(item.img.decode().catch(() => {})); }
      } else if (l.type === 'text') {
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
      } else if (l.type === 'endcard') {
        const p = out3((st - at) / .45);
        node.style.opacity = st >= at ? 1 : 0;
        node.style.transform = 'translateY(' + (1 - p) * 36 + 'px)';
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
        const p = outBack((st - at) / .45);
        node.style.opacity = st >= at ? 1 : 0;
        node.style.transform = 'scale(' + (.6 + .4 * p) + ') rotate(' + (1 - out3((st - at) / .45)) * -10 + 'deg)';
      } else {
        node.style.opacity = st >= at ? (l.opacity ?? 1) : 0;
      }
    }
  }
  let shown = null;
  for (const c of S.captions || []) if (t >= c.s && t < c.e) shown = c;
  if (!shown) { cap.style.opacity = 0; scrim.style.opacity = 0; }
  else { cap.style.opacity = clamp((t - shown.s) / .12); scrim.style.opacity = cap.style.opacity; cap.textContent = shown.text; }
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

function pageSpec(spec) {
  const stage = FORMATS[spec.format] ?? FORMATS.landscape;
  const copy = structuredClone(spec);
  copy.width = spec.width ?? stage.width;
  copy.height = spec.height ?? stage.height;
  copy.margin = spec.margin ?? stage.margin;
  copy.marginY = spec.marginY ?? stage.marginY;
  copy.background = spec.background ?? 'blobs';
  copy.takesPrefix = spec.out && spec.takes ? relative(spec.out, spec.takes).replaceAll('\\', '/') || '.' : 'takes';
  const root = spec.out ?? '.';
  for (const scene of copy.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      if (layer.type === 'image' && layer.src && !/^(https?:|file:|data:)/.test(layer.src)) {
        layer.src = fileUrl(isAbsolute(layer.src) ? layer.src : resolve(root, layer.src));
      }
    }
  }
  return copy;
}

export async function compose(spec, { playwright, mode = 'final', times = [], base = 'brag' } = {}) {
  const { chromium } = await import(fileUrl(playwright));
  const work = `${spec.out}/work`;
  mkdirSync(`${work}/frames`, { recursive: true });
  const drawn = pageSpec(spec);
  const takes = {};
  for (const name of new Set(drawn.scenes.flatMap((s) => s.layers.filter((l) => l.type === 'clip').map((l) => l.take)))) {
    const idx = JSON.parse(readFileSync(`${spec.takes}/${name}/index.json`));
    takes[name] = { viewport: idx.viewport, frames: idx.frames, moves: idx.events.filter((e) => ['move', 'step', 'click', 'down'].includes(e.type)).map((e) => ({ t: e.t, x: e.x, y: e.y })), events: idx.events };
  }
  const pageFile = `${spec.out}/${drawn.id}-${drawn.format}-stage.html`;
  writeFileSync(pageFile, `<!doctype html><meta charset="utf-8">${drawn.pal.fontLink ? `<link rel="stylesheet" href="${drawn.pal.fontLink}">` : ''}<style>html,body{margin:0;width:${drawn.width}px;height:${drawn.height}px;overflow:hidden;background:${drawn.pal.bg}}#stage{position:absolute;inset:0;overflow:hidden}</style><div id="stage"></div><script>window.SPEC=${JSON.stringify(drawn)};window.TAKES=${JSON.stringify(takes)};</script><script>${RUNTIME}</script>`);
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
  const total = Math.round(spec.duration * fps);
  const posterFrame = Math.min(total - 1, Math.max(0, Math.round((spec.poster ?? 0) * fps)));
  for (let f = 0; f < total; f += 1) await shoot(f / fps, `${work}/frames/${String(f).padStart(5, '0')}.jpg`);
  await browser.close();
  copyFileSync(`${work}/frames/${String(posterFrame).padStart(5, '0')}.jpg`, `${spec.out}/${base}.jpg`);
  copyFileSync(`${work}/frames/${String(posterFrame).padStart(5, '0')}.jpg`, `${work}/frames/00000.jpg`);
  makeSoundtrack(spec, takes, `${work}/music.wav`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', `${work}/frames/%05d.jpg`, '-i', `${work}/music.wav`, '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '224k', '-movflags', '+faststart', '-t', String(spec.duration), `${spec.out}/${base}.mp4`]);
  rmSync(`${work}/frames`, { recursive: true, force: true });
  return { video: `${spec.out}/${base}.mp4`, poster: `${spec.out}/${base}.jpg` };
}
