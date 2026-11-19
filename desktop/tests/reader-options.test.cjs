const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('reads only explicitly expanded explanations with the answer voice and supports reader hotkeys', async t => {
  const browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1326, height: 830}, reducedMotion: 'reduce'});
  await page.addInitScript(() => {
    window.HamStudyPrivateExplanations = {'B-001-001-001': {sourceId: 'B-001-001-001', reviewed: true, html: '<p>This is an offline fixture explanation.</p><h2>References</h2><p>https://example.invalid</p>'}};
    window.spoken = [];
    const voices = [{id: 'kokoro-question', name: 'Question'}, {id: 'kokoro-answer', name: 'Answer'}];
    window.__TAURI__ = {core: {invoke: async (cmd, args) => {
      if (cmd === 'speech_supported') return true;
      if (cmd === 'speech_engines') return [{id: 'kokoro', name: 'Kokoro'}];
      if (cmd === 'speech_configure') return {engine: 'kokoro', reason: 'Mock', voices};
      if (cmd === 'speech_voices') return voices;
      if (cmd === 'synthesize_word') return btoa(JSON.stringify(args));
    }}};
    window.Audio = class {
      constructor(src) { this.src = src; }
      load() {}
      removeAttribute() { this.src = ''; }
      pause() { clearTimeout(this.testTimer); }
      play() {
        if (!this.testStarted) { window.spoken.push(JSON.parse(atob(this.src.split(',')[1]))); this.testStarted = true; }
        this.testTimer = setTimeout(() => this.onended?.(), 200);
        return Promise.resolve();
      }
    };
  });
  await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
  await page.waitForFunction(() => !document.querySelector('#reader-play').disabled);
  const options = page.locator('.reader-settings');
  await options.evaluate(el => { el.open = true; });
  const voice = async (selector, preferred, fallback) => {
    const control = page.locator(selector);
    const value = await control.locator(`option[value="${preferred}"]`).count() ? preferred : fallback;
    await control.selectOption(value);
    return value;
  };
  await voice('#question-voice', 'kokoro-question', 'john');
  const answerVoice = await voice('#answer-voice', 'kokoro-answer', 'bryce');
  await options.evaluate(el => { el.open = false; });
  const answer = page.locator('.study-questions > li').first().locator('summary.answer');
  await answer.click();
  await page.locator('#reader-play').click();
  await page.waitForFunction(() => window.spoken.some(x => x.text.includes('offline fixture')));
  const spoken = await page.evaluate(() => window.spoken.slice(0, 3));
  assert.match(spoken[0].text, /assigns the authority/);
  assert.deepEqual(spoken.slice(1).map(x => [x.text, x.voice]), [['The Radiocommunication Act', answerVoice], ['This is an offline fixture explanation.', answerVoice]]);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#reader-pause').textContent(), 'Resume');
  await page.keyboard.press('ArrowDown');
  assert.match(await page.locator('.selected-question .question-id').textContent(), /B-001-001-002/);
  assert.equal(await page.locator('#reader-pause').textContent(), 'Resume');
  await page.keyboard.press('ArrowUp');
  assert.match(await page.locator('.selected-question .question-id').textContent(), /B-001-001-001/);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#reader-pause').textContent(), 'Pause');
  await page.locator('#reader-stop').click();
  await options.evaluate(el => { el.open = true; });
  await page.locator('#reader-explanations').uncheck();
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#reader-play').disabled);
  assert.equal(await page.locator('#reader-explanations').isChecked(), false);
  await answer.click();
  await page.locator('#reader-play').click();
  await page.waitForFunction(() => window.spoken.length >= 3);
  assert.ok(!(await page.evaluate(() => window.spoken.some(x => x.text.includes('offline fixture')))));
});
