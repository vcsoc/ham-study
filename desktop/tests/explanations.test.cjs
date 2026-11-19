const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const app = pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href;
const source = 'https://www.clares.ca/en/annotated-test-banks/basic-canadian-amateur-radio#question-';

test('study explanations and incorrect-result review use the same question IDs', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true });
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto(app);
  const rendered = await page.locator('#study-page section ol > li').evaluateAll(rows => rows.map(row => ({
    id: row.querySelector('.question-id').textContent.trim(),
    links: [...row.querySelectorAll('.question-explanation a')].map(a => a.href),
    note: row.querySelector('.question-explanation').textContent
  })));
  assert.equal(rendered.length, 984);
  assert.equal(new Set(rendered.map(row => row.id)).size, 984);
  for (const row of rendered) {
    if (row.id === 'B-003-019-008') {
      assert.equal(row.links.length, 0);
      assert.match(row.note, /common reference/);
    } else {
      const sourceId = row.id === 'B-008-002-011' ? 'B-003-019-008' : row.id;
      assert.ok(row.links.includes(source + sourceId), row.id);
    }
  }
  const row = page.locator('#study-page section ol > li').filter({has: page.locator('.question-id', {hasText: 'B-001-004-001'})});
  const details = row.locator('details.question-explanation');
  await row.locator('.question').click();
  assert.equal(await details.getAttribute('open'), '');
  assert.match(await details.innerText(), /no minimum or maximum age/);
  assert.equal(await details.getByRole('link', {name: /on CLARES/}).getAttribute('href'), source + 'B-001-004-001');
  await details.locator('summary').press('Enter');
  assert.equal(await details.getAttribute('open'), null);
  await row.locator('.answer strong').click();
  assert.equal(await details.getAttribute('open'), '');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.goto(app + '#simulator');
  await page.locator('#start-test').click();
  const first = page.locator('fieldset.sim-question').first();
  await first.locator('label').filter({hasText: 'The Radiocommunication Act'}).click();
  const age = page.locator('fieldset.sim-question').filter({has: page.locator('legend', {hasText: 'B-001-004-001'})});
  await age.locator('label').filter({hasText: '18 years or older'}).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name:'Finish test'}).click();
  const results = page.locator('.results-answers > .sim-question');
  assert.equal(await results.count(), 100);
  assert.equal(await results.first().locator('details').count(), 0);
  assert.equal(await results.locator('details[open]').count(), 99);
  const ageResult = results.filter({has: page.locator('.sim-meta', {hasText: 'B-001-004-001'})});
  assert.match(await ageResult.innerText(), /Incorrect[\s\S]*no minimum or maximum age/);
  await page.locator('#save-result').click();
  await page.locator('#back-tests').click();
  await page.getByRole('button', {name:'Review', exact:true}).click();
  assert.equal(await results.locator('details[open]').count(), 99);
});
