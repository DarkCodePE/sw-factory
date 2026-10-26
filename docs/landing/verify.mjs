// Local browser checks. Tool dependency lives outside the repository.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.env.HALLMARK_PUPPETEER || '/tmp/fab-landing-tools', 'package.json'));
const puppeteer = require('puppeteer-core');
const url = process.env.LANDING_URL || 'http://127.0.0.1:8769/';
const origin = new URL(url).origin;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, protocolTimeout: 20000 });
const results = [];
const check = (name, value) => { assert.ok(value, name); results.push(name); if(process.env.VERBOSE) console.error(name); };
const errors = [];
const external = [];
async function page() {
  const p = await browser.newPage();
  p.setDefaultTimeout(15000);
  p.setDefaultNavigationTimeout(15000);
  p.on('pageerror', e => errors.push({ url: p.url(), message: String(e), stack: e.stack }));
  await p.setRequestInterception(true);
  p.on('request', r => {
    if (r.url().startsWith('data:') || new URL(r.url()).origin === origin) r.continue();
    else { external.push(r.url()); r.abort(); }
  });
  return p;
}
try {
  await mkdir('site/screenshots', { recursive: true });
  await mkdir('site/.hallmark/shots', {recursive:true});
  const p = await page();
  const contrast = {};
  for (const mode of ['light', 'dark']) {
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await p.evaluateOnNewDocument(() => { try { localStorage.removeItem('fab-theme'); } catch { /* Intermediate browser documents can deny storage. */ } });
    for (const width of [320, 375, 390, 768, 1024, 1280, 1440, 1920]) {
      await p.setViewport({ width, height: width === 1280 ? 800 : width === 1920 ? 1080 : width === 375 ? 812 : width < 500 ? 844 : 900, isMobile: width < 500, hasTouch: width < 500 });
      await p.goto(url, { waitUntil: 'networkidle0' });
      check(`${mode} ${width}: no horizontal overflow`, await p.evaluate(() => {
        const w = document.documentElement.clientWidth;
        return document.documentElement.scrollWidth <= w && [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return e.classList.contains('skip-link') || (r.left >= -1 && r.right <= innerWidth + 1); });
      }));
      if(mode === 'dark' && [375,1280,1440,1920].includes(width)) {
        const embedded = await (await p.$('[data-diagram]')).contentFrame();
        await embedded.waitForFunction(() => document.readyState === 'complete');
        await embedded.evaluate(() => document.fonts.ready);
        if(width === 375 || width === 1440) await p.screenshot({path:`site/.hallmark/shots/index-${width === 1440 ? '1440-full' : '375'}.png`, fullPage:true});
        if(width !== 375) await p.screenshot({path:`site/.hallmark/shots/index-${width}x${width===1280?800:width===1920?1080:900}.png`});
      }
      if (width === 1280) check(`${mode}: hero action above fold`, await p.$eval('#install-npm .copy-button', e => e.getBoundingClientRect().bottom <= 800));
      if (width === 1440 || width === 390) {
        const size = width === 1440 ? 'desktop' : 'phone';
        await p.screenshot({ path: `site/screenshots/fab-${mode}-${size}.png`, fullPage: true });
        await p.screenshot({ path: `site/screenshots/fab-${mode}-${size}-hero.png` });
      }
    }
    check(`${mode}: official logo selected and loaded`, await p.evaluate(mode => {
      const images = [...document.querySelectorAll('.site-header .brand-logo')].filter(e => getComputedStyle(e).display !== 'none');
      return images.length === 1 && images[0].src.endsWith(`fab-logo-${mode}.svg`) && images[0].complete && images[0].naturalWidth > 0;
    }, mode));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url);
    contrast[mode] = await p.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const rgb = c => { ctx.clearRect(0,0,1,1); ctx.fillStyle = c; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data]; };
      const lum = c => c.slice(0,3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s,v,i) => s + v * [.2126,.7152,.0722][i], 0);
      const ratio = (a,b) => (Math.max(lum(a),lum(b)) + .05) / (Math.min(lum(a),lum(b)) + .05);
      const background = e => { while(e) { const c = rgb(getComputedStyle(e).backgroundColor); if(c[3] === 255) return c; e=e.parentElement; } return rgb(getComputedStyle(document.body).backgroundColor); };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const failures = []; let min = 100; let count = 0;
      while(walker.nextNode()) {
        const t = walker.currentNode, e = t.parentElement;
        if (!t.textContent.trim() || ['SCRIPT','STYLE','NOSCRIPT','TITLE','DESC'].includes(e.tagName.toUpperCase()) || !e.getClientRects().length) continue;
        const s = getComputedStyle(e); if(s.visibility === 'hidden') continue;
        const actual = ratio(rgb(s.color),background(e));
        const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && parseFloat(s.fontWeight) >= 700);
        min=Math.min(min,actual); count++;
        if(actual < (large ? 3 : 4.5)) failures.push({ text: t.textContent.trim(), actual });
      }
      const button = document.querySelector('.primary-button');
      const bs = getComputedStyle(button);
      const controlEdge = ratio(rgb(getComputedStyle(document.querySelector('.quiet-button')).borderTopColor),background(document.querySelector('.quiet-button')));
      const focus = ratio(rgb(getComputedStyle(document.documentElement).getPropertyValue('--color-focus')),background(button.parentElement));
      const connector = ratio(rgb(getComputedStyle(document.documentElement).getPropertyValue('--color-connector')),rgb(getComputedStyle(document.querySelector('.flow-section')).backgroundColor));
      return { count, min, failures, controlEdge, focus, connector, buttonText: ratio(rgb(bs.color),rgb(bs.backgroundColor)) };
    });
    check(`${mode}: WCAG AA text contrast`, contrast[mode].failures.length === 0);
    check(`${mode}: control and focus contrast`, contrast[mode].controlEdge >= 3 && contrast[mode].focus >= 3 && contrast[mode].connector >= 3);
  }
  check('Reduced motion shows final merge without playback', await p.evaluate(() => document.querySelector('[data-demo-play]').disabled && document.querySelector('.product-demo').dataset.playing === 'false' && !document.querySelector('[data-frame="10"]').hidden && document.querySelector('[data-frame="10"]').textContent.includes('completado')));
  check('Archify iframe and exploration links exist', await p.evaluate(() => document.querySelector('[data-diagram]').src.includes('diagrams/sdlc-workflow.html') && !!document.querySelector('a[href="./diagrams/architecture.html"]')));
  await p.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
  await p.click('[data-demo-play]');
  await p.evaluate(() => document.activeElement.blur()); await p.mouse.move(1,1);
  await p.waitForFunction(() => Number(document.querySelector('.product-demo').dataset.frame) > 0);
  await p.click('[data-demo-play]');
  const pausedFrame = await p.$eval('.product-demo', e => e.dataset.frame);
  await new Promise(r => setTimeout(r, 900));
  check('Demo pauses and resumes from the same frame', await p.$eval('.product-demo', (e,f) => e.dataset.frame === f && e.dataset.playing === 'false', pausedFrame));
  await p.click('[data-demo-play]');
  await p.evaluate(() => document.activeElement.blur()); await p.mouse.move(1,1);
  await p.waitForFunction(f => Number(document.querySelector('.product-demo').dataset.frame) > Number(f), {}, pausedFrame);
  const demoBox = await (await p.$('.demo-screen')).boundingBox();
  await p.mouse.move(demoBox.x + 20, demoBox.y + 20);
  const hoveredFrame = await p.$eval('.product-demo', e => e.dataset.frame);
  await new Promise(r => setTimeout(r, 1000));
  check('Demo holds on hover', await p.$eval('.product-demo', (e,f) => e.dataset.frame === f && e.dataset.playing === 'false', hoveredFrame));
  await p.mouse.move(1,1);
  await p.waitForFunction(f => Number(document.querySelector('.product-demo').dataset.frame) > Number(f), {}, hoveredFrame);
  await p.focus('.demo-screen');
  const focusedFrame = await p.$eval('.product-demo', e => e.dataset.frame);
  await new Promise(r => setTimeout(r, 1000));
  check('Demo holds on keyboard focus', await p.$eval('.product-demo', (e,f) => e.dataset.frame === f && e.dataset.playing === 'false', focusedFrame));
  await p.evaluate(() => document.activeElement.blur());
  await p.waitForFunction(f => Number(document.querySelector('.product-demo').dataset.frame) > Number(f), {}, focusedFrame);
  await p.click('[data-demo-end]');
  check('Demo result control finishes the session', await p.$eval('.product-demo', e => e.dataset.frame === '10' && e.dataset.playing === 'false'));
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(url);
  check('Internal anchor destinations exist', await p.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].every(a => document.getElementById(a.hash.slice(1)))));
  check('Six capabilities and exactly three future capabilities', await p.evaluate(() => document.querySelectorAll('.capabilities li').length === 6 && [...document.querySelectorAll('.capabilities .availability')].filter(e => e.textContent === 'Próximamente').length === 3));
  await p.focus('#tab-npm'); await p.keyboard.press('ArrowRight');
  check('Keyboard tabs select installer', await p.$eval('#install-script', e => !e.hidden));
  await p.keyboard.press('Home');
  check('Home returns to npm', await p.$eval('#tab-npm', e => document.activeElement === e && e.getAttribute('aria-selected') === 'true'));
  await p.keyboard.press('End');
  check('End selects script', await p.$eval('#tab-script', e => document.activeElement === e && e.getAttribute('aria-selected') === 'true'));
  await p.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } }));
  await p.click('#install-script .copy-button');
  check('Script copies exact command', await p.evaluate(() => window.copied === document.querySelector('#command-script').textContent && document.querySelector('.copy-status').textContent === 'Comando copiado.'));
  await p.click('#tab-npm'); await p.click('#install-npm .copy-button');
  check('npm copies exact command', await p.evaluate(() => window.copied === 'npm install -g @okuanb/fab@next'));
  await p.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; document.execCommand = () => false; });
  await p.click('#install-npm .copy-button');
  check('Clipboard denial gives recovery and focus', await p.evaluate(() => document.querySelector('.copy-status').dataset.state === 'error' && document.activeElement.id === 'command-npm' && !document.querySelector('#install-npm .copy-button').disabled));
  await p.evaluate(() => { document.execCommand = () => true; });
  await p.click('#install-npm .copy-button');
  check('Selection fallback reports success only when copy succeeds', await p.$eval('.copy-status', e => e.dataset.state === 'success'));
  await p.click('.theme-button');
  const selectedMode = await p.$eval('html', e => e.dataset.mode);
  check('Theme persisted', await p.evaluate(m => localStorage.getItem('fab-theme') === m, selectedMode));
  // New page has no initialization hook clearing storage.
  const q = await page(); await q.goto(url);
  check('Theme restored on reload', await q.$eval('html', (e,m) => e.dataset.mode === m, selectedMode));
  await q.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  check('Reduced motion preserves instant state changes', await q.$eval('.primary-button', e => getComputedStyle(e).transitionDuration === '0s'));
  await q.setViewport({width:320,height:844}); await q.evaluate(() => document.documentElement.style.fontSize = '200%');
  check('200% text scaling: text remains within viewport', await q.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const t = walker.currentNode, e = t.parentElement;
      if(!t.textContent.trim() || !e.getClientRects().length || e.closest('.skip-link, script, style, noscript, svg')) continue;
      const range = document.createRange(); range.selectNodeContents(t);
      if([...range.getClientRects()].some(r => r.left < -1 || r.right > innerWidth + 1)) return false;
    }
    return document.documentElement.scrollWidth <= innerWidth;
  }));
  const noStorage = await page(); await noStorage.evaluateOnNewDocument(() => { Object.defineProperty(window, 'localStorage', { get() { throw Error('disabled'); } }); });
  await noStorage.goto(url); await noStorage.click('.theme-button');
  check('Theme works with storage denied', await noStorage.$eval('html', e => ['dark','light'].includes(e.dataset.mode)));
  const noJS = await page(); await noJS.setJavaScriptEnabled(false); await noJS.setViewport({width:375,height:812}); await noJS.goto(url);
  check('Both install commands readable without JS', await noJS.evaluate(() => [...document.querySelectorAll('.command-panel')].every(e => e.getBoundingClientRect().height > 0) && [...document.querySelectorAll('[data-copy]')].every(e => e.disabled)));
  if(errors.length) console.error(JSON.stringify(errors));
  const touch = await page();
  await touch.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await touch.goto(url); await touch.bringToFront();
  const tab = await touch.$('#tab-script'); await tab.scrollIntoView();
  const tabBox = await tab.boundingBox();
  await touch.touchscreen.tap(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  check('Synthesized touch selects installer', await touch.$eval('#install-script', e => !e.hidden));
  check('No console JavaScript errors', errors.length === 0);
  check('No third-party requests', external.length === 0);
  check('Theme forwarded to embedded diagram', await p.$eval('[data-diagram]', e => new URL(e.src).searchParams.get('theme') === (document.documentElement.dataset.mode || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))));
  const typography = await p.evaluate(() => Object.fromEntries(['body','h1','h2','h3'].map(selector => [selector, getComputedStyle(document.querySelector(selector)).fontSize])));
  const visibleWords = await p.evaluate(() => document.body.innerText.trim().split(/\s+/).length);
  console.log(JSON.stringify({ typography, visibleWords, checks: results.length, passed: results, contrast, errors, external, browser: await browser.version() }, null, 2));
} finally { await browser.close(); }
