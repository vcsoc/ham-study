const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('Welcome actions fit their labels and stay reachable on desktop and phones', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [width, height] of [[1280, 800], [481, 640], [390, 844], [320, 460], [740, 280]]) {
    const page = await browser.newPage({viewport: {width, height}, isMobile: width <= 480, hasTouch: width <= 480});
    await page.addInitScript(() => {
      window.__TAURI__ = {core: {invoke: async command => command === 'speech_supported'}};
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    const dialog = page.getByRole('dialog', {name: 'Welcome to Ham Study'});
    await dialog.waitFor();
    const layout = await dialog.evaluate(el => {
      const outer = el.getBoundingClientRect();
      const buttons = [...el.querySelectorAll('button')].map(button => {
        const box = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(button);
        return {top: box.top, height: box.height, width: box.width, fits: [...range.getClientRects()].every(rect => rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom)};
      });
      return {buttons, fits: outer.left >= 0 && outer.right <= innerWidth && outer.top >= 0 && outer.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1};
    });
    const [decline, accept] = layout.buttons;
    assert.ok(layout.fits && layout.buttons.every(button => button.fits && button.height >= 44), `${width}x${height}: ${JSON.stringify(layout)}`);
    if (width <= 480) { assert.ok(accept.top > decline.top); assert.equal(accept.width, decline.width); }
    else assert.equal(accept.top, decline.top);
    await dialog.getByRole('button', {name: 'Continue without sound'}).click();
    await dialog.waitFor({state: 'detached'});
    await page.close();
  }
});
