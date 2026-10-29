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
      check(`${mode} ${width}: factory lifecycle and coding runtime are separate sections`, await page.evaluate(() => document.querySelectorAll('#fabrica .factory-flow > li').length === 4 && document.querySelector('#agente .runtime-command').textContent === 'fab exec' && !document.querySelector('#fabrica #agente')));
      check(`${mode} ${width}: new reading sections stay within viewport`, await page.evaluate(() => [...document.querySelectorAll('#fabrica *, #agente *, #sandbox *, #modelos *, #planes *')].filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; })));
      check(`${mode} ${width}: one selected tab and visible panel`, await page.evaluate(() => document.querySelectorAll('.module-tab[aria-selected="true"]').length === 1 && [...document.querySelectorAll('[data-module]')].filter(p => !p.hidden).length === 1));
      check(`${mode} ${width}: reduced motion is final and replay disabled`, await page.evaluate(() => document.querySelector('[data-module-play]').disabled && document.querySelector('[data-module]:not([hidden])').dataset.step === '3'));
      check(`${mode} ${width}: zero running animations with prefers-reduced-motion`, await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length === 0));
      check(`${mode} ${width}: mascot slot is mounted, decorative and visible`, await page.evaluate(() => {
        const slot = document.querySelector('.mascot-slot[data-mascot-state="mounted"][aria-hidden="true"]');
        if (!slot) return false;
        const mascot = slot.querySelector('svg, img');
        if (!mascot) return false;
        const cs = getComputedStyle(slot);
        const r = slot.getBoundingClientRect();
        return cs.display !== 'none' && r.width > 0 && r.height > 0;
      }));
      check(`${mode} ${width}: all text elements fit within their node rects`, await page.evaluate(() => {
        const nodes = document.querySelectorAll('g.module-node');
        for (const node of nodes) {
          const rect = node.querySelector('rect');
          if (!rect) continue;
          const rectBox = rect.getBoundingClientRect();
          const texts = node.querySelectorAll('text');
          for (const text of texts) {
            if (getComputedStyle(text).display === 'none') continue;
            const textBox = text.getBoundingClientRect();
            if (textBox.width === 0 || textBox.height === 0) continue;
            if (textBox.right > rectBox.right + 1.5 || textBox.left < rectBox.left - 1.5) return false;
          }
        }
        return true;
      }));
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
  await page.click('#module-tab-jira'); await page.click('[data-module-play]');
  await page.waitForFunction(() => document.getElementById('module-jira').dataset.step !== '0');
  const stepHiddenBefore = await page.$eval('#module-jira', p => p.dataset.step);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const stepHiddenAfter = await page.$eval('#module-jira', p => p.dataset.step);
  check('Hidden tab halts running animations and prevents step advance', await page.evaluate((before, after) => {
    const running = document.getAnimations().filter(a => a.playState === 'running').length;
    return before === after && running === 0;
  }, stepHiddenBefore, stepHiddenAfter));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('Mascot slot is mounted, decorative and visible in both themes', await page.evaluate(() => {
    const slot = document.querySelector('.mascot-slot[data-mascot-state="mounted"][aria-hidden="true"]');
    if (!slot) return false;
    const mascot = slot.querySelector('svg, img');
    if (!mascot) return false;
    const cs = getComputedStyle(slot);
    return cs.display !== 'none' && slot.getBoundingClientRect().width > 0;
  }));
  await page.click('.architecture-detail summary');
  const frame = await (await page.$('[data-diagram]')).contentFrame(); await frame.waitForFunction(() => document.readyState === 'complete');
  check('Archify interactive workflow loads under Pages prefix', frame.url().includes('/sw-factory/diagrams/sdlc-workflow.html'));
  const noExcludedNames = text => !/\b(?:Factory|Droid|Warp|PI|TrueForge)\b/i.test(text);
  check('Public page and workflow omit excluded reference brands', noExcludedNames(await page.$eval('body', e => e.innerText)) && noExcludedNames(await frame.$eval('body', e => e.innerText)));
  check('All internal links have destinations', await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].every(a => document.getElementById(a.hash.slice(1)))));
  check('Model routes explain Jev, relative cost and operational costTier', await page.evaluate(() => document.querySelector('#router-auto').textContent.includes('Jev') && document.querySelector('#router-auto').textContent.includes('relativeCost') && document.querySelector('#router-omni').textContent.includes('no una tarifa verificada')));
  check('No free pricing or token promise', !/\bgratis\b|gratuidad/i.test(await page.$eval('body', e => e.innerText)));
  const architecture = await browser.newPage();
  try {
    await architecture.goto(new URL('diagrams/architecture.html', url).href);
    check('Architecture does not advertise excluded workers', noExcludedNames(await architecture.$eval('body', e => e.innerText)));
  } finally { await architecture.close(); }
  for (const zoom of [1, 2]) {
    await page.setViewport({ width: 320, height: 844 });
    await page.evaluate(zoom => { document.documentElement.style.fontSize = `${zoom * 100}%`; }, zoom);
    check(`320px at ${zoom * 100}% text: new sections remain readable`, await page.evaluate(() => [...document.querySelectorAll('#fabrica *, #agente *, #sandbox *, #modelos *, #planes *')].filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; })));
  }
  await page.setJavaScriptEnabled(false); await page.goto(url);
  check('Factory, agent and routing explanations remain readable without JavaScript', await page.evaluate(() => ['fabrica', 'agente', 'router-auto', 'router-omni'].every(id => document.getElementById(id).getBoundingClientRect().height > 0)));
  const js = (await readFile('site/app.js')).length + (await readFile('site/modules.js')).length;
  check('Combined served JavaScript stays below 10 KB', js < 10000);
  if (errors.length || failedRequests.length || external.length) console.error(JSON.stringify({errors,failedRequests,external}));
  check('No JavaScript errors, missing assets or third-party requests', errors.length === 0 && failedRequests.length === 0 && external.length === 0);
  console.log(JSON.stringify({ checks: passed.length, passed, jsBytes: js, errors, failedRequests, external, browser: await browser.version() }, null, 2));
} finally { await browser.close(); }
