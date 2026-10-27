// Local browser evidence for the v2 module explorer. No production service calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
const require = createRequire('/tmp/fab-landing-tools/package.json');
const puppeteer = require('puppeteer-core');
const url = process.env.LANDING_URL || 'http://127.0.0.1:8772/sw-factory/';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const passed = [], errors = [], failedRequests = [], external = [];
const check = (name, value) => { assert.ok(value, name); passed.push(name); };
const page = await browser.newPage();
page.on('pageerror', error => errors.push(String(error)));
page.on('response', response => { if (response.status() >= 400) failedRequests.push(response.url()); });
await page.setRequestInterception(true);
page.on('request', request => { if (request.url().startsWith(new URL(url).origin) || request.url().startsWith('data:')) request.continue(); else { external.push(request.url()); request.abort(); } });
try {
  await mkdir('site/screenshots', { recursive: true });
  for (const mode of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluateOnNewDocument(() => { try { localStorage.removeItem('fab-theme'); } catch {} });
    for (const width of [390, 1440]) {
      await page.setViewport({ width, height: width < 500 ? 844 : 900, isMobile: width < 500, hasTouch: width < 500 });
      await page.goto(url, { waitUntil: 'networkidle0' });
      check(`${mode} ${width}: one selected tab and visible panel`, await page.evaluate(() => document.querySelectorAll('.module-tab[aria-selected="true"]').length === 1 && [...document.querySelectorAll('[data-module]')].filter(p => !p.hidden).length === 1));
      check(`${mode} ${width}: reduced motion is final and replay disabled`, await page.evaluate(() => document.querySelector('[data-module-play]').disabled && document.querySelector('[data-module]:not([hidden])').dataset.step === '3'));
      await page.focus('.module-tab'); await page.keyboard.press('ArrowDown');
      check('ArrowDown selects triage', await page.$eval('.module-tab[aria-selected="true"]', e => e.id === 'module-tab-triage' && document.activeElement === e));
      await page.keyboard.press('End'); check('End selects workers', await page.$eval('.module-tab[aria-selected="true"]', e => e.id === 'module-tab-workers'));
      await page.keyboard.press('Home'); check('Home returns to Jira', await page.$eval('.module-tab[aria-selected="true"]', e => e.id === 'module-tab-jira'));
      for (const id of ['jira','triage','investigation','implementation','validators','merge','sandbox','workers']) {
        await page.click(`#module-tab-${id}`);
        check(`${mode} ${width} ${id}: selection and bounds`, await page.evaluate(id => {
          const p = document.getElementById('module-' + id), svg = p.querySelector('svg').getBoundingClientRect();
          return !p.hidden && p.getAttribute('aria-labelledby') === 'module-tab-' + id && svg.left >= 0 && svg.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
        }, id));
        if (id === 'merge') {
          await page.click('[data-gate="fail"]'); check('Blocked merge retains source error and scenario state', await page.$eval('#module-merge', p => p.dataset.result === 'fail' && p.textContent.includes('error (invalid_transition)')));
          await page.screenshot({path:`site/screenshots/v2-${mode}-${width}-merge-fail.png`});
          if (width < 500) check('Mobile merge FAIL result is readable HTML', await page.$eval('.scene-result-fail', e => getComputedStyle(e).display !== 'none' && parseFloat(getComputedStyle(e).fontSize) >= 16));
          await page.click('[data-gate="pass"]'); check('Allowed merge changes scenario and captured output', await page.$eval('#module-merge', p => p.dataset.result === 'pass' && p.querySelector('.module-cli pre').textContent === 'change 951e7eb3 completado'));
        }
        if (id === 'sandbox') {
          await page.click('[data-platform="macos"]'); check('macOS does not advertise bubblewrap', await page.$eval('#module-sandbox', p => p.dataset.platform === 'macos' && getComputedStyle(p.querySelector('.linux-label')).display === 'none'));
          if (width < 500) check('Mobile sandbox labels retain environment, files and network', await page.$eval('.scene-legend', e => getComputedStyle(e).display === 'grid' && e.textContent.includes('Permisos del usuario local') && e.textContent.includes('Política de Execute')));
          await page.click('[data-platform="linux"]');
        }
        await (await page.$('.module-explorer')).screenshot({ path: `site/screenshots/v2-${mode}-${width}-${id}.png` });
      }
      await page.click('#module-tab-jira');
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `site/screenshots/fab-${mode}-${width === 1440 ? 'desktop' : 'phone'}.png`, fullPage: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `site/screenshots/fab-${mode}-${width === 1440 ? 'desktop' : 'phone'}-hero.png` });
    }
  }
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.setViewport({ width: 1440, height: 900 }); await page.goto(url);
  await page.click('#module-tab-jira'); await page.click('[data-module-play]');
  await page.waitForFunction(() => document.getElementById('module-jira').dataset.step !== '0');
  await page.click('[data-module-play]');
  const step = await page.$eval('#module-jira', p => p.dataset.step);
  await new Promise(resolve => setTimeout(resolve, 1500));
  check('Module playback pauses without advancing', await page.$eval('#module-jira', (p, step) => p.dataset.step === step && p.dataset.playing === 'false', step));
  await page.click('[data-module-next]'); check('Next step is deterministic', await page.$eval('#module-jira', (p, step) => Number(p.dataset.step) === (Number(step) + 1) % 4, step));
  await page.click('[data-module-end]'); check('Final state stops playback', await page.$eval('#module-jira', p => p.dataset.step === '3' && p.dataset.playing === 'false'));
  await page.click('[data-module-play]'); await page.evaluate(() => scrollTo(0, 0)); await new Promise(resolve => setTimeout(resolve, 100));
  check('Offscreen module animation is suspended', await page.$eval('#module-jira', p => p.dataset.playing === 'false'));
  check('Mascot slot is reserved with no image or chosen concept', await page.evaluate(() => document.querySelector('[data-mascot-state="reserved"]') && document.querySelector('[data-mascot-state] img') === null && document.querySelector('#fab-mascot-template')));
  await page.click('.architecture-detail summary');
  const frame = await (await page.$('[data-diagram]')).contentFrame(); await frame.waitForFunction(() => document.readyState === 'complete');
  check('Archify interactive workflow loads under Pages prefix', frame.url().includes('/sw-factory/diagrams/sdlc-workflow.html'));
  const js = (await readFile('site/app.js')).length + (await readFile('site/modules.js')).length;
  check('Combined served JavaScript stays below 10 KB', js < 10000);
  if (errors.length || failedRequests.length || external.length) console.error(JSON.stringify({errors,failedRequests,external}));
  check('No JavaScript errors, missing assets or third-party requests', errors.length === 0 && failedRequests.length === 0 && external.length === 0);
  console.log(JSON.stringify({ checks: passed.length, passed, jsBytes: js, errors, failedRequests, external, browser: await browser.version() }, null, 2));
} finally { await browser.close(); }
