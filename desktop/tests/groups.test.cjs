const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = process.env.HAM_STUDY_PRIVATE_UI || path.resolve(__dirname, '../ui');

for (const width of [390, 1250]) {
  test(`categories and sections stay in sync at ${width}px`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({offline: true, viewport: {width, height: 830}, reducedMotion: 'reduce'});
    await page.goto(pathToFileURL(path.join(ui, 'index.html')).href);
    assert.equal(await page.locator('.study-category').count(), 8);
    assert.equal(await page.locator('.study-section').count(), 100);
    const ids = await page.locator('ol.study-questions > li > .question-id').allTextContents();
    assert.equal(ids.length, 984);
    assert.equal(new Set(ids).size, 984);
    const nav = id => page.locator(`.study-nav button[aria-controls="${id}"]`);
    const category = page.locator('#B-005');
    const section = page.locator('#section-B-005-007');
    const title = section.locator(':scope > summary');
    const question = section.locator('ol.study-questions > li').filter({has: page.locator('.question-id', {hasText: 'B-005-007-003'})});
    if (process.env.HAM_STUDY_PRIVATE_UI) {
      assert.match(await category.locator(':scope > summary').innerText(), /Basic Electronics and Theory/);
      assert.equal(await page.locator('#section-B-003-019 .question-id').getByText('B-008-002-011', {exact: true}).count(), 1);
    }
    assert.equal(await nav('B-005').getAttribute('aria-expanded'), 'false');
    await nav('B-005').click();
    assert.equal(await nav('B-005').getAttribute('aria-expanded'), 'true');
    assert.ok(await title.isVisible());
    await title.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-controls="section-B-005-007"]').getAttribute('aria-expanded') === 'true');
    assert.ok(await question.isVisible());
    await nav('section-B-005-007').click();
    assert.equal(await nav('section-B-005-007').getAttribute('aria-expanded'), 'false');
    assert.ok(!(await question.isVisible()));
    await nav('section-B-005-007').click();
    assert.ok(await question.isVisible());
    await category.locator(':scope > summary').click();
    await page.waitForFunction(() => document.querySelector('[aria-controls="B-005"]').getAttribute('aria-expanded') === 'false');
    assert.ok(!(await nav('section-B-005-007').isVisible()));
    assert.ok(!(await question.isVisible()));
    await page.locator('#question-search').fill('B-005-007-003');
    await page.locator('#question-search').press('Enter');
    await question.waitFor({state: 'visible'});
    assert.equal(await section.getAttribute('open'), '');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
}
