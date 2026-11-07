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
// Output: <outDir>/<name>/NNNNNN.jpg and index.json ({ frames: [{ f, t }], events: [...] }),
// with times in seconds from take.start(). Pass an allow() filter so a take cannot reach backends,
// analytics or third parties it does not need.
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

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

export async function openRecorder({ playwright, outDir, viewport = { width: 1280, height: 720 }, scale = 2, channel = 'chrome' }) {
  const url = isAbsolute(playwright) ? pathToFileURL(playwright).href : playwright;
  const { chromium } = await import(url);
  const browser = await chromium.launch({ channel, headless: true });
  return {
    close: () => browser.close(),
    async take(name, { allow } = {}) {
      const dir = `${outDir}/${name}`;
      mkdirSync(dir, { recursive: true });
      const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
      if (allow) await context.route('**/*', (route) => (allow(new URL(route.request().url())) ? route.continue() : route.abort()));
      await context.addInitScript(CURSOR);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const frames = [], events = [];
      let t0 = 0, n = 0, x = viewport.width / 2, y = viewport.height / 2, on = false;
      const now = () => (Date.now() - t0) / 1000;
      const mark = (type, extra = {}) => { if (on) events.push({ t: +now().toFixed(3), type, x: Math.round(x), y: Math.round(y), ...extra }); };
      cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (!on) return;
        n += 1;
        const f = `${String(n).padStart(6, '0')}.jpg`;
        frames.push({ f, t: +now().toFixed(3) });
        writeFileSync(`${dir}/${f}`, Buffer.from(data, 'base64'));
      });
      const take = {
        page, context, mark,
        async start() {
          t0 = Date.now();
          on = true;
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: viewport.width * scale, maxHeight: viewport.height * scale, everyNthFrame: 1 });
          await page.mouse.move(x, y);
        },
        async stop() {
          await page.waitForTimeout(300);
          on = false;
          await cdp.send('Page.stopScreencast').catch(() => {});
          writeFileSync(`${dir}/index.json`, JSON.stringify({ viewport, scale, frames, events }));
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
