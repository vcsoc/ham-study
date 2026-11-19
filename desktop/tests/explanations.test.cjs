const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const ui = process.env.HAM_STUDY_PRIVATE_UI;

test('private explanations are complete and render in study and saved results offline', {skip: !ui}, async t => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const app = pathToFileURL(path.join(ui, 'index.html')).href;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({offline: true, viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  const network = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto(app);
  const audit = await page.evaluate(() => {
    const bank = JSON.parse(document.querySelector('#question-data').textContent);
    const entries = window.HamStudyPrivateExplanations;
    const container = document.createElement('template');
    let unsafe = 0;
    for (const entry of Object.values(entries)) {
      container.innerHTML = entry.html;
      if (!container.content.textContent.trim() || container.content.querySelector('a, img, script, iframe, [href], [src], [style]')) unsafe++;
    }
    return {total: bank.length, copied: Object.keys(entries).length, missing: bank.filter(q => !entries[q.id]).map(q => q.id), unsafe, remapped: entries['B-008-002-011'].sourceId};
  });
  assert.deepEqual(audit, {total: 984, copied: 983, missing: ['B-003-019-008'], unsafe: 0, remapped: 'B-003-019-008'});
  const row = id => page.locator('#study-page section > ol > li').filter({has: page.locator('.question-id', {hasText: id})});
  const age = row('B-001-004-001');
  const details = age.locator('details.question-explanation');
  const answer = age.locator('summary.answer');
  assert.match(await answer.innerText(), /There are no age limits/);
  assert.equal(await age.getByText('There are no age limits', {exact: true}).count(), 1);
  await age.locator('.question').click();
  await details.locator('.explanation-body').waitFor();
  assert.match(await details.innerText(), /References[\s\S]*https:\/\/ised-isde\.canada\.ca/);
  assert.equal(await details.getByRole('link').count(), 0);
  await details.locator('summary').press('Enter');
  assert.equal(await details.getAttribute('open'), null);
  await age.locator('.answer strong').click();
  assert.equal(await details.getAttribute('open'), '');
  await age.locator('.answer strong').click();
  assert.equal(await details.getAttribute('open'), null);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await row('B-003-019-008').locator('summary').click();
  assert.match(await row('B-003-019-008').locator('details').innerText(), /Ham Study note/);

  await page.goto(app + '#simulator');
  await page.locator('#start-test').click();
  const first = page.locator('fieldset.sim-question').first();
  await first.locator('label').filter({hasText: 'The Radiocommunication Act'}).click();
  const ageTest = page.locator('fieldset.sim-question').filter({has: page.locator('legend', {hasText: 'B-001-004-001'})});
  await ageTest.locator('label').filter({hasText: '18 years or older'}).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Finish test'}).click();
  const results = page.locator('.results-answers > .sim-question');
  assert.equal(await results.count(), 100);
  assert.equal(await results.first().locator('details').count(), 0);
  assert.equal(await results.locator('details[open]').count(), 99);
  const ageResult = results.filter({has: page.locator('.sim-meta', {hasText: 'B-001-004-001'})});
  const resultAnswer = ageResult.locator('summary');
  assert.match(await resultAnswer.innerText(), /Correct answer: There are no age limits/);
  assert.match(await ageResult.innerText(), /Incorrect[\s\S]*Source: CLARES/);
  await resultAnswer.click();
  assert.equal(await ageResult.locator('details').getAttribute('open'), null);
  await page.locator('#save-result').click();
  await page.locator('#back-tests').click();
  await page.getByRole('button', {name: 'Review', exact: true}).click();
  assert.equal(await results.locator('details[open]').count(), 99);
  assert.deepEqual(network, []);
});
