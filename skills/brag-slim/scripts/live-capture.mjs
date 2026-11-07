// Records a real browser session as high-resolution frames, with a visible cursor and a log of
// every action, so a video can show the product in use instead of still screenshots.
//
//   const rec = await openRecorder({ playwright: 'path/to/playwright/index.mjs' });
//   const take = await rec.take('solve', { allow: (url) => url.hostname === 'example.com' });
//   await take.page.goto('https://example.com');
//   await take.start();
//   await take.click('button.go');
//   await take.stop();
//
// Output: <outDir>/<name>/NNNNNN.jpg and index.json
// ({ viewport, scale, frames: [{ f, t }], events, crop? }).
// A new recording sets each frame t to its index divided by 30 and quantizes event times
// onto that grid. importTake builds the same folder from a video file. probeAudio returns
// an audio file's duration and does not mix. Pass an allow() filter so a take cannot reach
// backends, analytics or third parties it does not need.
import { pathToFileURL } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const FRAME_RATE = 30;

export const VIEWPORTS = {
  landscape: { width: 1280, height: 720 },
  vertical: { width: 540, height: 960 },
  square: { width: 720, height: 720 },
};

export function writeContactSheet(takeDir, dest = join(takeDir, 'contact.jpg')) {
  const idx = JSON.parse(readFileSync(join(takeDir, 'index.json'), 'utf8'));
  const frames = idx.frames ?? [];
  if (!frames.length) return null;
  const n = Math.min(12, frames.length);
  const picks = Array.from({ length: n }, (_, i) => frames[Math.min(frames.length - 1, Math.round((i * (frames.length - 1)) / Math.max(1, n - 1)))]);
  const sheetDir = join(takeDir, '_sheet');
  mkdirSync(sheetDir, { recursive: true });
  picks.forEach((frame, i) => copyFileSync(join(takeDir, frame.f), join(sheetDir, `${String(i).padStart(2, '0')}.jpg`)));
  const cols = Math.min(4, n);
  const rows = Math.ceil(n / cols);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-start_number', '0', '-i', join(sheetDir, '%02d.jpg'), '-frames:v', String(n), '-filter_complex', `tile=${cols}x${rows}:padding=6:color=0x111111`, dest]);
  rmSync(sheetDir, { recursive: true, force: true });
  return dest;
}

function probeJson(file, args) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', file], { encoding: 'utf8' }));
}

function cropRecord(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const side = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { top: side(crop.top), right: side(crop.right), bottom: side(crop.bottom), left: side(crop.left) };
}

function stampClock(frames, events) {
  frames.forEach((frame, index) => { frame.t = index / FRAME_RATE; });
  for (const event of events) event.t = Math.round(event.t * FRAME_RATE) / FRAME_RATE;
}

export function importTake(file, outDir, name) {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const stream = probeJson(file, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height']).streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!width || !height) throw new Error(`no video stream in ${file}`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `fps=${FRAME_RATE}`, '-q:v', '3', join(dir, '%06d.jpg')]);
  const frames = readdirSync(dir).filter((entry) => entry.toLowerCase().endsWith('.jpg')).sort().map((f, index) => ({ f, t: index / FRAME_RATE }));
  if (!frames.length) throw new Error(`no frames decoded from ${file}`);
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ viewport: { width, height }, scale: 1, frames, events: [] }));
  return { frames: frames.length, duration: frames.at(-1)?.t ?? 0 };
}

export function probeAudio(file) {
  const duration = Number(probeJson(file, ['-show_entries', 'format=duration']).format?.duration);
  if (!Number.isFinite(duration)) throw new Error(`no duration for ${file}`);
  return { duration };
}

const CURSOR = `
(() => {
  if (window.__bragCursor) return;
  window.__bragCursor = true;
  const add = () => {
    const c = document.createElement('div');
    c.id = '__brag_cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transition:transform 90ms ease-out;transform-origin:4px 3px;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45))';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 11-7 1.2L8.3 21z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    c.style.left = (window.__bragX ?? -60) + 'px';
    c.style.top = (window.__bragY ?? -60) + 'px';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      c.style.transform = 'scale(.82)';
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;width:18px;height:18px;border-radius:50%;border:3px solid rgba(255,190,40,.95);z-index:2147483646;pointer-events:none;transform:translate(-50%,-50%);left:' + e.clientX + 'px;top:' + e.clientY + 'px';
      document.documentElement.appendChild(r);
      r.animate([{ width: '18px', height: '18px', opacity: 1 }, { width: '84px', height: '84px', opacity: 0 }], { duration: 480, easing: 'ease-out' }).onfinish = () => r.remove();
    }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
})();`;

const smooth = (x) => x * x * (3 - 2 * x);

export async function openRecorder({ playwright, outDir, format = 'landscape', viewport, scale = 2, channel = 'chrome' }) {
  const vp = viewport ?? VIEWPORTS[format] ?? VIEWPORTS.landscape;
  const url = isAbsolute(playwright) ? pathToFileURL(playwright).href : playwright;
  const { chromium } = await import(url);
  const browser = await chromium.launch({ channel, headless: true });
  return {
    close: () => browser.close(),
    format,
    viewport: vp,
    async take(name, { allow, crop } = {}) {
      const dir = `${outDir}/${name}`;
      mkdirSync(dir, { recursive: true });
      const context = await browser.newContext({ viewport: vp, deviceScaleFactor: scale });
      if (allow) await context.route('**/*', (route) => (allow(new URL(route.request().url())) ? route.continue() : route.abort()));
      await context.addInitScript(CURSOR);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const frames = [], events = [];
      let t0 = 0, n = 0, x = vp.width / 2, y = vp.height / 2, on = false;
      const now = () => (Date.now() - t0) / 1000;
      const mark = (type, extra = {}) => { if (on) events.push({ t: now(), type, x: Math.round(x), y: Math.round(y), ...extra }); };
      cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (!on) return;
        n += 1;
        const f = `${String(n).padStart(6, '0')}.jpg`;
        frames.push({ f, t: 0 });
        writeFileSync(`${dir}/${f}`, Buffer.from(data, 'base64'));
      });
      const take = {
        page, context, mark,
        async start() {
          t0 = Date.now();
          on = true;
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: vp.width * scale, maxHeight: vp.height * scale, everyNthFrame: 1 });
          await page.mouse.move(x, y);
        },
        async stop() {
          await page.waitForTimeout(300);
          on = false;
          await cdp.send('Page.stopScreencast').catch(() => {});
          stampClock(frames, events);
          const index = { viewport: vp, scale, frames, events };
          const recordedCrop = cropRecord(crop);
          if (recordedCrop) index.crop = recordedCrop;
          writeFileSync(`${dir}/index.json`, JSON.stringify(index));
          await context.close();
          return { frames: frames.length, duration: frames.at(-1)?.t ?? 0 };
        },
        wait: (ms) => page.waitForTimeout(ms),
        async move(tx, ty, ms = 450) {
          const fromX = x, fromY = y, steps = Math.max(2, Math.round(ms / 16));
          for (let i = 1; i <= steps; i += 1) {
            const k = smooth(i / steps);
            x = fromX + (tx - fromX) * k;
            y = fromY + (ty - fromY) * k;
            await page.mouse.move(x, y);
            mark('move');
            await page.waitForTimeout(ms / steps);
          }
        },
        async centre(target) {
          const loc = typeof target === 'string' ? page.locator(target).first() : target;
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(120);
          const box = await loc.boundingBox();
          if (!box) throw new Error(`no box for ${target}`);
          return [box.x + box.width / 2, box.y + box.height / 2];
        },
        async click(target, ms = 450) {
          const [cx, cy] = await take.centre(target);
          await take.move(cx, cy, ms);
          await page.waitForTimeout(90);
          mark('click');
          await page.mouse.down();
          await page.waitForTimeout(60);
          await page.mouse.up();
        },
        async drag(points, msPerPoint = 120) {
          await take.move(points[0][0], points[0][1], 350);
          mark('down');
          await page.mouse.down();
          for (const [px, py] of points.slice(1)) {
            await take.move(px, py, msPerPoint);
            mark('step');
          }
          await page.mouse.up();
          mark('up');
        },
        async type(text, delay = 70) {
          for (const ch of text) {
            mark('key');
            await page.keyboard.type(ch);
            await page.waitForTimeout(delay);
          }
        },
        async press(key) { mark('key'); await page.keyboard.press(key); },
      };
      return take;
    },
  };
}
