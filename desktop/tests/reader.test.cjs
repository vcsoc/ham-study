// Run with PLAYWRIGHT_MODULE=/path/to/playwright node --test tests/reader.test.cjs.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const piperVoices = require('../src-tauri/speech/piper-voices.json').map(v => ({id: `piper-${v.speaker}`, name: `${v.name} (${v.gender}) - Piper ${v.speaker + 1}`}));
const kokoroVoices = require('../src-tauri/speech/kokoro-voices.json').map(v => ({id: `kokoro-${v.code}`, name: `${v.name} (${v.gender}; ${v.language}) - ${v.code}`}));

function wav(seconds = 0.2) {
  const samples = Math.round(22050 * seconds), b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b.toString('base64');
}
async function fixture(page, options = {}) {
  await page.addInitScript(({encoded, options, catalogues}) => {
    window.metrics = {requests: [], configurations: [], starts: [], ends: [], cancelled: 0, engineLists: 0, downloads: 0, prunes: []};
    window.testSpeech = {autoEngine: 'kokoro', failKokoro: false, downloaded: {kokoro: true, piper: true}, offline: false, ...options};
    if (!options.welcome && !localStorage.getItem('ham-study-speech-consent-v1')) localStorage.setItem('ham-study-speech-consent-v1', 'enabled');
    if (!options.welcome && !localStorage.getItem('ham-reader-settings')) localStorage.setItem('ham-reader-settings', JSON.stringify({engine: 'auto', ...options.saved}));
    let queue = Promise.resolve();
    window.__TAURI__ = {core: {invoke: (command, args) => {
      if (command === 'speech_supported') return Promise.resolve(true);
      if (command === 'speech_cancel') { window.metrics.cancelled = Math.max(window.metrics.cancelled, args.generation); return Promise.resolve(); }
      if (command === 'speech_prune_cache') {
        if (window.testSpeech.failPrune) return Promise.reject(new Error('Cache cleanup failed'));
        if (args.engine !== window.testSpeech.activeEngine || args.voices.length !== 2 || args.voices.some(id => !catalogues[args.engine].some(voice => voice.id === id))) return Promise.reject(new Error('Invalid retained engine or voices'));
        window.metrics.prunes.push(args);
        const removed = [];
        for (const engine of ['kokoro', 'piper']) {
          if (engine !== args.engine && window.testSpeech.downloaded[engine]) {
            window.testSpeech.downloaded[engine] = false;
            removed.push(engine);
          }
        }
        return Promise.resolve({removed});
      }
      if (command === 'speech_engines') {
        window.metrics.engineLists++;
        return Promise.resolve([
          {id: 'auto', name: 'Auto (speed-tested)', downloaded: true},
          {id: 'kokoro', name: 'Kokoro', downloaded: window.testSpeech.downloaded.kokoro},
          {id: 'piper', name: 'Piper', downloaded: window.testSpeech.downloaded.piper}
        ]);
      }
      if (command === 'speech_progress') return Promise.resolve({phase: 'starting', label: 'Loading downloaded offline speech'});
      if (command === 'speech_configure') {
        window.metrics.configurations.push(args);
        const engine = args.engine === 'auto' ? window.testSpeech.autoEngine : args.engine;
        return new Promise(resolve => setTimeout(resolve, engine === 'kokoro' ? 120 : 40)).then(() => {
          if (args.generation < window.metrics.cancelled) throw new Error('cancelled');
          if (engine === 'kokoro' && window.testSpeech.failKokoro) throw new Error('Kokoro download failed');
          if (!window.testSpeech.downloaded[engine]) {
            if (window.testSpeech.offline) throw new Error('This model is not downloaded for offline use.');
            window.metrics.downloads++;
            window.testSpeech.downloaded[engine] = true;
          }
          window.testSpeech.activeEngine = engine;
          return {engine, reason: args.engine === 'auto' ? 'Auto selected ' + engine + ' after a speed check.' : 'Using local ' + engine + ' speech.',
            voices: catalogues[engine]};
        });
      }
      if (command === 'app_version') return Promise.resolve('test');
      if (command === 'synthesize_word') {
        window.metrics.requests.push({...args, time: performance.now()});
        const result = queue.then(() => new Promise(resolve => setTimeout(resolve, 35))).then(() => {
          if (args.generation < window.metrics.cancelled) throw new Error('cancelled');
          if (!args.voice.startsWith(args.engine + '-')) throw new Error('wrong voice for engine');
          return encoded;
        });
        queue = result.catch(() => {});
        return result;
      }
      return Promise.resolve();
    }}};
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.testPlayer = this;
      window.metrics.starts.push(performance.now());
      this.addEventListener('ended', () => window.metrics.ends.push(performance.now()), {once: true});
      return play.call(this);
    };
  }, {encoded: wav(options.audioSeconds || 0.2), options, catalogues: {piper: piperVoices, kokoro: kokoroVoices}});
  await page.goto(url);
  if (!options.welcome) await page.waitForFunction(() => !document.getElementById('reader-play').disabled);
}
async function openSettings(page) {
  await page.locator('.reader-settings').evaluate(element => { element.open = true; });
}
async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((control, value) => {
    control.value = String(value);
    control.dispatchEvent(new Event('input'));
  }, value);
}
async function readyEngine(page, engine) {
  await page.waitForFunction(engine => {
    const voices = document.getElementById('question-voice');
    return !voices.disabled && voices.value.startsWith(engine + '-');
  }, engine);
}

test('Welcome downloads only after consent, and opting out can be reversed in settings', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const optIn of [true, false]) {
    const page = await browser.newPage({viewport: {width: optIn ? 1200 : 390, height: 780}});
    await fixture(page, {welcome: true, downloaded: {piper: false, kokoro: false}});
    const dialog = page.getByRole('dialog', {name: 'Welcome to Ham Study'});
    await dialog.waitFor();
    assert.equal(await page.locator('#speech-engine').inputValue(), 'piper');
    assert.equal(await page.evaluate(() => window.metrics.configurations.length), 0);
    await dialog.getByRole('button', {name: optIn ? 'Download Piper' : 'Continue without sound'}).click();
    if (!optIn) {
      assert.equal(await page.locator('#speech-engine').inputValue(), 'off');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#engine-info').textContent.includes('Read-aloud is off'));
      assert.equal(await dialog.count(), 0);
      assert.equal(await page.evaluate(() => window.metrics.downloads), 0);
      await openSettings(page);
      await page.locator('#speech-engine').selectOption('piper');
    }
    await readyEngine(page, 'piper');
    assert.equal(await page.evaluate(() => window.metrics.downloads), 1);
    assert.equal(await page.evaluate(() => window.metrics.configurations[0].engine), 'piper');
    await openSettings(page);
    await page.locator('#speech-engine').selectOption('off');
    assert.ok(await page.locator('#reader-play').isDisabled());
    await page.close();
  }
});

test('preloads ahead, respects default delays, pauses, stops and restarts cleanly', async () => {
  const browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await fixture(page);
    await page.locator('#reader-play').click();
    await page.waitForFunction(() => window.metrics.ends.length >= 8);
    const metrics = await page.evaluate(() => window.metrics);
    assert.ok(metrics.requests.filter(r => r.time < metrics.starts[0]).length >= 4);
    const gaps = metrics.ends.slice(0, 7).map((end, i) => Math.max(0, metrics.starts[i + 1] - end));
    assert.ok(gaps.every(gap => gap >= 230 && gap < 400), 'default transition gaps around 250ms: ' + gaps.join(', '));
    await page.locator('#reader-pause').click();
    const count = await page.evaluate(() => window.metrics.starts.length);
    await delay(350);
    assert.equal(await page.evaluate(() => window.metrics.starts.length), count);
    await page.locator('#reader-pause').click();
    await page.waitForFunction(n => window.metrics.ends.length > n, metrics.ends.length);
    await page.locator('#reader-stop').click();
    assert.equal(await page.locator('.reading-word').count(), 0);
    assert.equal(await page.locator('.question-preparation').count(), 0);
    const stopped = await page.evaluate(() => window.metrics.starts.length);
    await delay(300);
    assert.equal(await page.evaluate(() => window.metrics.starts.length), stopped);
    await page.locator('#reader-play').click();
    await page.waitForFunction(n => window.metrics.starts.length > n, stopped);
    const beforeJump = await page.evaluate(() => window.metrics.requests.length);
    const target = page.locator('#study-page ol.study-questions > li').nth(20);
    await target.evaluate(row => window.HamStudyGroups.reveal(row));
    const expected = await target.locator('.question').innerText();
    await target.locator('.question').dblclick();
    await page.waitForFunction(({before, text}) => window.metrics.requests.slice(before).some(r => r.text === text), {before: beforeJump, text: expected});
    await page.locator('#reader-stop').click();
    const afterJump = await page.evaluate(() => window.metrics.starts.length);
    await delay(350);
    assert.equal(await page.evaluate(() => window.metrics.starts.length), afterJump);
    assert.deepEqual(errors, []);
    console.log('Maximum fixture-audio transition gap: ' + Math.max(...gaps).toFixed(1) + 'ms');
  } finally { await browser.close(); }
});

test('double-click starts the clicked passage or toggles that passage without restarting', async () => {
  const browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await fixture(page, {audioSeconds: 3});
    const rows = page.locator('#study-page section ol > li');
    const first = rows.nth(0), other = rows.nth(3);
    await first.locator('.question').dblclick();
    await page.waitForFunction(() => document.querySelector('#study-page .question .reading-word'));
    const readingGeneration = await page.evaluate(() => {
      window.savedPlayer = window.testPlayer;
      return window.metrics.cancelled;
    });
    await first.locator('.question').dblclick();
    assert.equal(await page.locator('#reader-pause').innerText(), 'Resume');
    assert.ok(await page.evaluate(() => window.testPlayer.paused));
    const pausedTime = await page.evaluate(() => window.testPlayer.currentTime);
    await delay(180);
    assert.equal(await page.evaluate(() => window.testPlayer.currentTime), pausedTime);
    await first.locator('.question').dblclick();
    assert.equal(await page.locator('#reader-pause').innerText(), 'Pause');
    assert.ok(await page.evaluate(() => window.testPlayer === window.savedPlayer && !window.testPlayer.paused));
    assert.equal(await page.evaluate(() => window.metrics.cancelled), readingGeneration, 'resume must not restart synthesis');
    await first.locator('.answer').dblclick();
    await page.waitForFunction(() => document.querySelector('#study-page .answer .reading-word'));
    assert.ok(await page.evaluate(() => window.metrics.cancelled > 0 && window.testPlayer !== window.savedPlayer));
    assert.equal(await first.locator('.question .reading-word').count(), 0, 'clicking the answer skips the question');
    const answerGeneration = await page.evaluate(() => window.metrics.cancelled);
    await first.locator('.answer').dblclick();
    assert.equal(await page.locator('#reader-pause').innerText(), 'Resume');
    await first.locator('.answer').dblclick();
    assert.equal(await page.locator('#reader-pause').innerText(), 'Pause');
    assert.equal(await page.evaluate(() => window.metrics.cancelled), answerGeneration);
    await first.locator('.answer').dblclick();
    await other.locator('.question').dblclick();
    await page.waitForFunction(() => {
      const row = document.querySelectorAll('#study-page section ol > li')[3];
      return row.querySelector('.question .reading-word') && !window.testPlayer.paused;
    });
    assert.equal(await page.locator('#reader-pause').innerText(), 'Pause', 'a different passage starts even when paused');
    await page.locator('#reader-stop').click();
    await other.locator('.answer').dblclick();
    await page.waitForFunction(() => document.querySelectorAll('#study-page section ol > li')[3].querySelector('.answer .reading-word'));
    assert.equal(await other.locator('.question .reading-word').count(), 0);
    await page.locator('#reader-stop').click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('engine selection replaces both catalogues, cancels playback, and remembers per-engine voices', async () => {
  const browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    await fixture(page);
    await openSettings(page);
    for (const select of ['#question-voice', '#answer-voice']) {
      assert.deepEqual(await page.locator(select + ' option').evaluateAll(options => options.map(o => ({id: o.value, name: o.textContent}))), kokoroVoices);
    }
    assert.match(await page.locator('#engine-info').innerText(), /54 voices available/);
    assert.match(await page.locator('#question-voice option[value="kokoro-af_bella"]').innerText(), /Bella.*female/i);
    assert.match(await page.locator('#answer-voice option[value="kokoro-am_adam"]').innerText(), /Adam.*male/i);
    await page.selectOption('#question-voice', 'kokoro-af_nicole');
    await page.selectOption('#answer-voice', 'kokoro-am_adam');
    await page.locator('#reader-play').click();
    await page.waitForFunction(() => window.metrics.starts.length > 0);
    await page.selectOption('#speech-engine', 'piper');
    assert.ok(await page.locator('#reader-play').isDisabled());
    await readyEngine(page, 'piper');
    for (const select of ['#question-voice', '#answer-voice']) {
      assert.deepEqual(await page.locator(select + ' option').evaluateAll(options => options.map(o => ({id: o.value, name: o.textContent}))), piperVoices);
    }
    assert.match(await page.locator('#engine-info').innerText(), /904 voices available/);
    assert.equal(await page.locator('#question-voice option').first().innerText(), 'Ashley Candland (Female) - Piper 1');
    assert.equal(await page.locator('#answer-voice option').nth(2).innerText(), 'Brett W. Downey (Male) - Piper 3');
    assert.equal(await page.locator('#reader-stop').isDisabled(), true);
    assert.ok((await page.locator('#answer-voice option').evaluateAll(options => options.map(o => o.value))).every(id => id.startsWith('piper-')));
    await page.selectOption('#question-voice', 'piper-3');
    await page.selectOption('#answer-voice', 'piper-7');
    await page.selectOption('#speech-engine', 'kokoro');
    await readyEngine(page, 'kokoro');
    assert.equal(await page.locator('#question-voice').inputValue(), 'kokoro-af_nicole');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'kokoro-am_adam');
    await page.selectOption('#speech-engine', 'piper');
    await readyEngine(page, 'piper');
    assert.equal(await page.locator('#question-voice').inputValue(), 'piper-3');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'piper-7');
    await page.reload();
    await readyEngine(page, 'piper');
    assert.equal(await page.locator('#speech-engine').inputValue(), 'piper');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'piper-7');
  } finally { await browser.close(); }
});

test('refresh prunes other downloaded engines but preserves the active shared pack and selected voices offline', async () => {
  const browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    await fixture(page, {offline: true, saved: {engine: 'kokoro'}});
    await openSettings(page);
    await page.selectOption('#question-voice', 'kokoro-af_bella');
    await page.selectOption('#answer-voice', 'kokoro-em_santa');
    await page.locator('#reader-play').click();
    await page.waitForFunction(() => window.metrics.starts.length > 0);
    await page.evaluate(() => {
      document.querySelector('#speech-engine option[value="piper"]').remove();
      document.querySelector('#question-voice option[value="kokoro-af_alloy"]').remove();
      document.querySelector('#answer-voice option[value="kokoro-am_adam"]').remove();
    });
    const scans = await page.evaluate(() => window.metrics.engineLists);
    await page.locator('#speech-refresh').click();
    assert.ok(await page.locator('#speech-refresh').isDisabled());
    await page.waitForFunction(() => !document.getElementById('speech-refresh').disabled);
    assert.equal(await page.evaluate(() => window.metrics.engineLists), scans + 1);
    assert.equal(await page.evaluate(() => window.metrics.configurations.at(-1).refresh), true);
    assert.equal(await page.locator('#speech-engine option').count(), 4);
    assert.match(await page.locator('#speech-engine option[value="piper"]').innerText(), /download on first use/);
    assert.deepEqual(await page.evaluate(() => window.metrics.prunes[0].voices), ['kokoro-af_bella', 'kokoro-em_santa']);
    assert.equal(await page.evaluate(() => window.testSpeech.downloaded.kokoro), true);
    assert.equal(await page.evaluate(() => window.testSpeech.downloaded.piper), false);
    assert.equal(await page.locator('#reader-stop').isDisabled(), true);
    for (const selector of ['#question-voice', '#answer-voice']) {
      assert.deepEqual(await page.locator(selector + ' option').evaluateAll(options => options.map(o => ({id: o.value, name: o.textContent}))), kokoroVoices);
    }
    assert.equal(await page.locator('#question-voice').inputValue(), 'kokoro-af_bella');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'kokoro-em_santa');
    assert.equal(await page.evaluate(() => window.metrics.downloads), 0);
    await page.reload();
    await readyEngine(page, 'kokoro');
    assert.equal(await page.evaluate(() => window.metrics.downloads), 0);
    assert.equal(await page.locator('#answer-voice').inputValue(), 'kokoro-em_santa');
  } finally { await browser.close(); }
});

test('refresh retains generated audio for selected voices and drops audio for unselected voices', async () => {
  const browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    await fixture(page, {audioSeconds: 3, saved: {engine: 'kokoro'}});
    await openSettings(page);
    const question = page.locator('#study-page section ol > li').first().locator('.question');
    const text = await question.innerText();
    await question.dblclick();
    await page.waitForFunction(() => window.metrics.starts.length > 0);
    await page.locator('#reader-stop').click();
    await page.selectOption('#question-voice', 'kokoro-af_bella');
    await page.selectOption('#answer-voice', 'kokoro-em_santa');
    await question.dblclick();
    await page.waitForFunction(() => window.metrics.starts.length >= 2);
    await page.locator('#reader-stop').click();
    await page.locator('#speech-refresh').click();
    await page.waitForFunction(() => !document.getElementById('speech-refresh').disabled);
    const before = await page.evaluate(() => ({requests: window.metrics.requests.length, starts: window.metrics.starts.length}));
    await question.dblclick();
    await page.waitForFunction(count => window.metrics.starts.length > count, before.starts);
    assert.ok(!await page.evaluate(({before, text}) => window.metrics.requests.slice(before).some(r => r.voice === 'kokoro-af_bella' && r.text === text), {before: before.requests, text}), 'selected-voice audio should still be cached');
    await page.locator('#reader-stop').click();
    await page.selectOption('#question-voice', 'kokoro-af_alloy');
    const prior = await page.evaluate(() => window.metrics.requests.length);
    await question.dblclick();
    await page.waitForFunction(({prior, text}) => window.metrics.requests.slice(prior).some(r => r.voice === 'kokoro-af_alloy' && r.text === text), {prior, text});
    await page.locator('#reader-stop').click();
  } finally { await browser.close(); }
});

test('refresh preserves the engine resolved by Auto instead of downloading another engine', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await fixture(page, {autoEngine: 'piper', offline: true});
    await openSettings(page);
    await page.selectOption('#question-voice', 'piper-3');
    await page.selectOption('#answer-voice', 'piper-7');
    await page.evaluate(() => { window.testSpeech.autoEngine = 'kokoro'; });
    await page.locator('#speech-refresh').click();
    await page.waitForFunction(() => !document.getElementById('speech-refresh').disabled);
    assert.equal(await page.locator('#speech-engine').inputValue(), 'auto');
    assert.equal(await page.evaluate(() => window.metrics.prunes[0].engine), 'piper');
    assert.equal(await page.evaluate(() => window.metrics.configurations.at(-1).engine), 'piper');
    assert.equal(await page.evaluate(() => window.testSpeech.downloaded.kokoro), false);
    assert.equal(await page.locator('#question-voice').inputValue(), 'piper-3');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'piper-7');
    assert.equal(await page.locator('#question-voice option').count(), 904);
    assert.equal(await page.evaluate(() => window.metrics.downloads), 0);
  } finally { await browser.close(); }
});

test('legacy Kokoro choices migrate by name and the final multilingual voice persists', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await fixture(page, {saved: {engine: 'kokoro', voices: {kokoro: {questionVoice: 'kokoro-1', answerVoice: 'kokoro-5'}}}});
    assert.equal(await page.locator('#question-voice').inputValue(), 'kokoro-af_bella');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'kokoro-am_adam');
    await openSettings(page);
    await page.selectOption('#question-voice', 'kokoro-em_santa');
    await page.selectOption('#answer-voice', 'kokoro-zm_yunyang');
    await page.reload();
    await readyEngine(page, 'kokoro');
    assert.equal(await page.locator('#question-voice').inputValue(), 'kokoro-em_santa');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'kokoro-zm_yunyang');
    assert.equal(await page.locator('#question-voice option').count(), 54);
    assert.equal(await page.locator('#answer-voice option').count(), 54);
  } finally { await browser.close(); }
});

test('audio configuration survives a full browser restart and is applied to playback', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ham-reader-persistence-'));
  let context;
  const options = {headless: true, args: ['--autoplay-policy=no-user-gesture-required']};
  try {
    context = await chromium.launchPersistentContext(profile, options);
    let page = context.pages()[0];
    await fixture(page);
    await openSettings(page);
    await page.selectOption('#question-voice', 'kokoro-af_bella');
    await page.selectOption('#answer-voice', 'kokoro-am_adam');
    await page.selectOption('#speech-engine', 'piper');
    await readyEngine(page, 'piper');
    await page.selectOption('#question-voice', 'piper-3');
    await page.selectOption('#answer-voice', 'piper-7');
    await page.locator('#reader-volume').evaluate(control => {
      control.value = '0.35';
      control.dispatchEvent(new Event('input'));
    });
    await page.locator('#reader-speed').evaluate(control => {
      control.value = '1.65';
      control.dispatchEvent(new Event('input'));
    });
    await setRange(page, '#question-answer-delay', 750);
    await setRange(page, '#next-question-delay', 1250);
    await context.close();
    context = await chromium.launchPersistentContext(profile, options);
    page = context.pages()[0];
    await fixture(page);
    await readyEngine(page, 'piper');
    assert.equal(await page.locator('#speech-engine').inputValue(), 'piper');
    assert.equal(await page.locator('#question-voice').inputValue(), 'piper-3');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'piper-7');
    assert.equal(await page.locator('#reader-volume').inputValue(), '0.35');
    assert.equal(await page.locator('#reader-speed').inputValue(), '1.65');
    assert.equal(await page.locator('#question-answer-delay').inputValue(), '750');
    assert.equal(await page.locator('#next-question-delay').inputValue(), '1250');
    assert.equal(await page.locator('#question-answer-delay-value').textContent(), '750 ms');
    assert.equal(await page.locator('#next-question-delay-value').textContent(), '1.25 s');
    assert.equal(await page.evaluate(() => window.metrics.configurations[0].engine), 'piper');
    await page.locator('#reader-play').click();
    await page.waitForFunction(() => window.metrics.starts.length > 0);
    assert.equal(await page.evaluate(() => window.metrics.requests[0].voice), 'piper-3');
    assert.equal(await page.evaluate(() => window.metrics.requests[1].voice), 'piper-7');
    assert.equal(await page.evaluate(() => window.testPlayer.volume), 0.35);
    assert.equal(await page.evaluate(() => window.testPlayer.playbackRate), 1.65);
    await page.locator('#reader-stop').click();
    await openSettings(page);
    await page.selectOption('#speech-engine', 'kokoro');
    await readyEngine(page, 'kokoro');
    assert.equal(await page.locator('#question-voice').inputValue(), 'kokoro-af_bella');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'kokoro-am_adam');
  } finally {
    if (context) await context.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});

test('separate transition delays apply only between passages and reset to 250ms', async () => {
  const browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    await fixture(page);
    await openSettings(page);
    for (const selector of ['#question-answer-delay', '#next-question-delay']) {
      assert.deepEqual(await page.locator(selector).evaluate(e => [e.min, e.max, e.step, e.value]), ['250', '15000', '250', '250']);
    }
    await setRange(page, '#question-answer-delay', 250);
    await setRange(page, '#next-question-delay', 750);
    await page.locator('#reader-play').click();
    await page.waitForFunction(() => window.metrics.starts.length >= 4);
    await page.locator('#reader-stop').click();
    const metrics = await page.evaluate(() => window.metrics);
    const gaps = metrics.ends.slice(0, 3).map((end, i) => metrics.starts[i + 1] - end);
    assert.ok(gaps[0] >= 230 && gaps[0] < 550, 'question-to-answer gap: ' + gaps[0]);
    assert.ok(gaps[1] >= 730 && gaps[1] < 1050, 'answer-to-question gap: ' + gaps[1]);
    assert.ok(gaps[2] >= 230 && gaps[2] < 550, 'second question-to-answer gap: ' + gaps[2]);
    await openSettings(page);
    for (const selector of ['#question-answer-delay', '#next-question-delay']) {
      await page.locator(selector).dispatchEvent('dblclick');
      assert.equal(await page.locator(selector).inputValue(), '250');
    }
    console.log('Configured transition gaps: ' + gaps.map(g => g.toFixed(1)).join(', ') + 'ms');
  } finally { await browser.close(); }
});

test('transition waits pause, respond to slider changes, and cancel on stop or passage jumps', async () => {
  const browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const page = await browser.newPage();
    await fixture(page, {saved: {questionAnswerDelayMs: 1000, nextQuestionDelayMs: 15000}});
    await page.locator('#reader-play').click();
    await page.waitForFunction(() => window.metrics.ends.length === 1);
    await page.locator('#reader-pause').click();
    await delay(500);
    assert.equal(await page.evaluate(() => window.metrics.starts.length), 1);
    const resumed = await page.evaluate(() => performance.now());
    await page.locator('#reader-pause').click();
    await page.waitForFunction(() => window.metrics.starts.length === 2);
    assert.ok(await page.evaluate(resumed => window.metrics.starts[1] - resumed > 650, resumed), 'paused time must not consume the delay');
    await page.waitForFunction(() => window.metrics.ends.length === 2);
    await openSettings(page);
    await setRange(page, '#next-question-delay', 250);
    await page.waitForFunction(() => window.metrics.starts.length === 3);
    await page.waitForFunction(() => window.metrics.ends.length === 3);
    await page.locator('#reader-stop').click();
    await delay(1000);
    assert.equal(await page.evaluate(() => window.metrics.starts.length), 3, 'stopping cancels the pending question-to-answer delay');
    await setRange(page, '#question-answer-delay', 15000);
    await page.locator('#reader-play').click();
    await page.waitForFunction(() => window.metrics.ends.length === 4);
    const answer = page.locator('#study-page section ol > li').nth(3).locator('.answer');
    await answer.dblclick();
    await page.waitForFunction(() => window.metrics.starts.length === 5);
    assert.ok(await page.locator('#study-page section ol > li').nth(3).evaluate(row => row.classList.contains('selected-question')));
    await page.locator('#reader-stop').click();
  } finally { await browser.close(); }
});

test('saved delays migrate to bounded 250ms steps', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const [questionAnswerDelayMs, nextQuestionDelayMs, expected] of [
      [0.5, 325.5, ['250', '250']],
      [1100, 14999.5, ['1000', '15000']],
      [-500, 20000, ['250', '15000']]
    ]) {
      const page = await browser.newPage();
      await fixture(page, {saved: {questionAnswerDelayMs, nextQuestionDelayMs}});
      assert.equal(await page.locator('#question-answer-delay').inputValue(), expected[0]);
      assert.equal(await page.locator('#next-question-delay').inputValue(), expected[1]);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ham-reader-settings')));
      assert.equal(saved.questionAnswerDelayMs, expected[0]);
      assert.equal(saved.nextQuestionDelayMs, expected[1]);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('reader settings help is a compact, dismissible tooltip on desktop and touch screens', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const mobile of [false, true]) {
      const page = await browser.newPage({viewport: mobile ? {width: 390, height: 700} : {width: 1440, height: 900}, hasTouch: mobile});
      await fixture(page);
      await openSettings(page);
      const button = page.getByRole('button', {name: 'Reader settings help'});
      const tooltip = page.getByRole('tooltip');
      assert.equal(await tooltip.count(), 0, 'explanatory text does not occupy the panel by default');
      await button.focus();
      assert.ok(await tooltip.isVisible());
      assert.equal(await button.getAttribute('aria-expanded'), 'true');
      assert.match(await tooltip.textContent(), /Auto reuses downloaded packs first/);
      await page.keyboard.press('Escape');
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      if (mobile) await button.tap(); else await button.click();
      assert.ok(await tooltip.isVisible());
      const box = await tooltip.boundingBox();
      const viewport = page.viewportSize();
      await page.screenshot({path: path.join(os.tmpdir(), mobile ? 'ham-reader-settings-mobile.png' : 'ham-reader-settings-desktop.png')});
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, 'tooltip stays within the viewport: ' + JSON.stringify({box, viewport}));
      if (mobile) await button.tap(); else await button.click();
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      if (!mobile) {
        await page.locator('#reader-volume').focus();
        await page.mouse.move(10, 300);
        await button.hover();
        assert.ok(await tooltip.isVisible());
        await tooltip.hover();
        await delay(200);
        assert.ok(await tooltip.isVisible(), 'hovering the tooltip keeps it readable');
        await page.mouse.move(10, 300);
        await page.waitForFunction(() => document.getElementById('voice-help').hidden);
      }
      await button.click();
      await page.locator('#theme-toggle').click();
      assert.equal(await button.getAttribute('aria-expanded'), 'false', 'outside click dismisses the tooltip');
      await page.screenshot({path: path.join(os.tmpdir(), mobile ? 'ham-reader-controls-mobile.png' : 'ham-reader-controls-desktop.png')});
      assert.ok(await page.locator('.settings-panel').evaluate(panel => {
        const bounds = panel.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
      }), 'settings panel fits the viewport');
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Auto fallback catalogues, setup errors, retries, and rapid engine switches are safe on mobile', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 700}});
    await fixture(page, {autoEngine: 'piper', saved: {questionVoice: 'kathleen', answerVoice: 'default'}});
    await readyEngine(page, 'piper');
    assert.equal(await page.locator('#question-voice').inputValue(), 'piper-1');
    assert.equal(await page.locator('#answer-voice').inputValue(), 'piper-0');
    await openSettings(page);
    await page.evaluate(() => { window.testSpeech.failKokoro = true; });
    await page.selectOption('#speech-engine', 'kokoro');
    await page.waitForFunction(() => !document.getElementById('speech-retry').hidden);
    assert.ok(await page.locator('#reader-play').isDisabled());
    assert.ok(await page.locator('#answer-voice').isDisabled());
    await page.evaluate(() => { window.testSpeech.failKokoro = false; });
    await page.locator('#speech-retry').click();
    await readyEngine(page, 'kokoro');
    await page.evaluate(() => {
      const control = document.getElementById('speech-engine');
      for (const value of ['piper', 'kokoro', 'piper']) {
        control.value = value;
        control.dispatchEvent(new Event('change'));
      }
    });
    await readyEngine(page, 'piper');
    await delay(250);
    assert.equal(await page.locator('#speech-engine').inputValue(), 'piper');
    assert.ok((await page.locator('#question-voice').inputValue()).startsWith('piper-'));
    assert.ok(await page.locator('.settings-panel').evaluate(e => e.clientHeight < innerHeight));
    assert.ok(await page.locator('.settings-panel').evaluate(e => getComputedStyle(e).overflowY === 'auto'));
  } finally { await browser.close(); }
});
