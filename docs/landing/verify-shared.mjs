// Browser proofs against the static Pages artifact. Tooling stays outside production.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.env.HALLMARK_PUPPETEER||'/tmp/fab-landing-tools','package.json'));
const puppeteer=require('puppeteer-core');
export async function verify({interactive=false}={}) {
 const base=process.env.LANDING_URL||'http://127.0.0.1:8775/sw-factory/';
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,protocolTimeout:30000});
 const errors=[],external=[],failed=[],passed=[];
 const check=(name,ok)=>{assert.ok(ok,name);passed.push(name);if(process.env.VERBOSE)console.error(name)};
 const page=await browser.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 page.on('response',r=>{if(r.status()>=400)failed.push(r.url())});
 await page.setRequestInterception(true);
 page.on('request',r=>{if(r.url().startsWith('data:')||new URL(r.url()).origin===new URL(base).origin)r.continue();else{external.push(r.url());r.abort()}});
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const running=()=>page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length);
 try {
  await mkdir('site/screenshots',{recursive:true});
  await page.evaluateOnNewDocument(()=>{try{localStorage.removeItem('fab-theme')}catch{}});
  const destinations=new Set();
  for(const route of ['','fabrica/','agente/'])for(const theme of ['light','dark'])for(const width of [390,1440]){
   const label=`${route||'portada'} ${theme} ${width}`;
   await page.setViewport({width,height:900,isMobile:width<500,hasTouch:width<500});
   await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]);
   await page.goto(new URL(route,base).href,{waitUntil:'networkidle0'});
   check(`${label}: no horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('main *, .site-header *, .site-footer *')].filter(e=>e.getClientRects().length&&!e.closest('.skip-link,.command-track, .hero-field')).every(e=>{const r=e.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1})));
   check(`${label}: reduced motion stops all animations`,await running()===0);
   check(`${label}: beaver logo loads in selected theme`,await page.evaluate(theme=>{const logo=[...document.querySelectorAll('.site-header .brand-logo')].filter(e=>e.getBoundingClientRect().width);return logo.length===1&&logo[0].complete&&logo[0].naturalWidth>0&&logo[0].src.endsWith(`fab-logo-${theme}.svg`)},theme));
   const contrast=await page.evaluate(textContrast);
   if(contrast.length) console.error(contrast);
   check(`${label}: WCAG AA text contrast`,contrast.length===0);
   check(`${label}: one main heading and unique IDs`,await page.evaluate(()=>document.querySelectorAll('h1').length===1&&new Set([...document.querySelectorAll('[id]')].map(e=>e.id)).size===document.querySelectorAll('[id]').length));
   check(`${label}: shared navigation and current product`,await page.evaluate(route=>document.querySelectorAll('.site-nav a').length===12&&(!route||document.querySelectorAll('.site-nav a[aria-current="page"]').length===2),route));
   check(`${label}: environment spans viewport`,await page.$eval('.ambient',e=>{const r=e.getBoundingClientRect();return getComputedStyle(e).position==='fixed'&&r.height===innerHeight}));
   if(width===390){await page.click('.nav-mobile-summary');check(`${label}: menu touch rows`,await page.$$eval('.nav-mobile-dropdown a',a=>a.every(e=>e.getBoundingClientRect().height>=44)));await page.click('.nav-mobile-summary')}
   else{await page.focus('.nav-dropdown-trigger');await page.keyboard.press('Enter');check(`${label}: products opens by keyboard`,await page.$eval('.nav-dropdown-item',e=>e.open));await page.keyboard.press('Escape');check(`${label}: escape closes products`,await page.$eval('.nav-dropdown-item',e=>!e.open&&document.activeElement===e.querySelector('summary')))}
   await page.focus('#tab-npm');await page.keyboard.press('ArrowRight');check(`${label}: installer keyboard tabs`,await page.$eval('#install-script',e=>!e.hidden));await page.keyboard.press('Home');
   // Check every diagram panel, not just the initially selected one.
   if(route==='fabrica/')for(const id of ['jira','triage','investigation','implementation','validators','merge','sandbox','workers']){
    await page.click('#module-tab-'+id);
    check(`${label} ${id}: text inside SVG nodes`,await page.$eval('#module-'+id,p=>[...p.querySelectorAll('g.module-node')].every(node=>{const rect=node.querySelector('rect').getBoundingClientRect();return [...node.querySelectorAll('text')].every(t=>{const b=t.getBoundingClientRect();return !b.width||(b.left>=rect.left-1.5&&b.right<=rect.right+1.5&&b.top>=rect.top-1.5&&b.bottom<=rect.bottom+1.5)})})));
   }
   await page.evaluate(()=>scrollTo(0,0));
   await page.screenshot({path:`site/screenshots/products-${route.replace('/','')||'index'}-${theme}-${width}.png`,fullPage:true});
   (await page.$$eval('a[href]',a=>a.map(e=>e.href))).filter(h=>new URL(h).origin===new URL(base).origin).forEach(h=>destinations.add(h));
   check(`${label}: no prohibited claims`,!/(rollback atómico|socket unix|--no-approval\b|0\.0s overhead|cero telemetría|autónoma|Local Offline)/i.test(await page.$eval('body',e=>e.textContent)));
   await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
   await delay(150);
   check(`${label}: motion resumes`,await running()>0);
   await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))});
   await delay(100);check(`${label}: hidden tab stops every animation`,await running()===0);
   const field=await page.$('.hero-field');
   if(field){const frames=await field.evaluate(e=>e.dataset.frames);await delay(120);check(`${label}: hidden field loop cancelled`,await field.evaluate((e,n)=>e.dataset.frames===n,frames))}
   await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});
  }
  // Resolve links through HTTP and parse fragment targets without executing redirects.
  for(const href of destinations){const u=new URL(href);check(`link ${u.pathname}${u.hash}`,await page.evaluate(async href=>{const u=new URL(href);const r=await fetch(u);if(!r.ok)return false;if(!u.hash)return true;const doc=new DOMParser().parseFromString(await r.text(),'text/html');return !!doc.getElementById(decodeURIComponent(u.hash.slice(1)))},href))}
  for(const hash of ['fabrica','agente','sandbox','modelos','capacidades','flujo','modulos','planes','proximamente','arquitectura','router-auto','router-omni','seguimiento']){
   await page.goto(base+'#'+hash,{waitUntil:'networkidle0'});
   check(`legacy #${hash} resolves`,await page.evaluate(()=>!!document.getElementById(decodeURIComponent(location.hash.slice(1)))));
   if(!['arquitectura'].includes(hash))check(`legacy #${hash} reaches product`,page.url().includes('/fabrica/')||page.url().includes('/agente/'));
  }
  await page.goto(base+'#empezar');check('legacy #empezar reaches visible CTA',await page.$eval('#empezar',e=>e.getBoundingClientRect().height>0));
  if(interactive)await interactions(page,check,base,delay);
  for(const route of ['','fabrica/','agente/']){
   await page.setViewport({width:320,height:900});await page.goto(new URL(route,base).href);
   await page.evaluate(()=>document.documentElement.style.fontSize='200%');
   check(`${route||'portada'}: 200% text fits at 320`,await page.evaluate(()=>{if(document.documentElement.scrollWidth>innerWidth)return false;const walker=document.createTreeWalker(document.querySelector('main'),NodeFilter.SHOW_TEXT);while(walker.nextNode()){const t=walker.currentNode,e=t.parentElement;if(!t.textContent.trim()||!e.getClientRects().length||e.closest('script,style,noscript,svg,.command-track'))continue;const r=document.createRange();r.selectNodeContents(t);if([...r.getClientRects()].some(b=>b.left<-1||b.right>innerWidth+1))return false}return true}));
   await page.setJavaScriptEnabled(false);await page.goto(new URL(route,base).href);
   check(`${route||'portada'}: commands readable without JS`,await page.$$eval('.command-panel',panels=>panels.every(p=>p.getBoundingClientRect().height>0)));
   if(route==='fabrica/')check('all eight module explanations without JS',await page.$$eval('[data-module]',a=>a.length===8&&a.every(e=>e.getBoundingClientRect().height>0)));
   await page.setJavaScriptEnabled(true);
  }
  check('no console or JavaScript errors',errors.length===0);check('no missing resources',failed.length===0);check('no external requests',external.length===0);
  console.log(JSON.stringify({checks:passed.length,passed,errors,failed,external,browser:await browser.version()},null,2));
 } finally{await browser.close()}
}
async function interactions(page,check,base,delay){
 await page.setViewport({width:1440,height:900});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
 await page.goto(base);
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text}}}));
 await page.click('[data-copy="command-npm"]');check('copy uses exact npm command',await page.evaluate(()=>window.copied==='npm install -g @okuanb/fab@next'));
 await page.click('#tab-script');await page.click('[data-copy="command-script"]');check('copy uses exact installer command',await page.evaluate(()=>window.copied===document.querySelector('#command-script').textContent));
 await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('denied')};document.execCommand=()=>false});await page.click('[data-copy="command-script"]');check('copy denial gives recovery and focus',await page.evaluate(()=>document.querySelector('.copy-status').dataset.state==='error'&&document.activeElement.id==='command-script'));
 await page.click('.theme-button');check('theme preference saved',await page.evaluate(()=>localStorage.getItem('fab-theme')===document.documentElement.dataset.mode));
 await page.click('[data-demo-end]');check('session final result matches capture',await page.$eval('.product-demo',e=>e.dataset.frame==='10'&&e.dataset.playing==='false'));
 await page.click('[data-demo-play]');await page.evaluate(()=>document.activeElement.blur());await page.mouse.move(1,1);await page.waitForFunction(()=>Number(document.querySelector('.product-demo').dataset.frame)>0);
 await page.click('[data-demo-play]');const frame=await page.$eval('.product-demo',e=>e.dataset.frame);await delay(900);check('session pause preserves frame',await page.$eval('.product-demo',(e,n)=>e.dataset.frame===n,frame));
 const marquee=await page.$('.command-marquee');await marquee.scrollIntoView();await marquee.hover();check('marquee holds on hover',await page.$eval('.command-track',e=>getComputedStyle(e).animationPlayState==='paused'));await page.focus('.command-marquee');await page.mouse.move(1,1);check('marquee holds on focus',await page.$eval('.command-track',e=>getComputedStyle(e).animationPlayState==='paused'));
 await page.goto(new URL('fabrica/',base).href);await (await page.$('.module-explorer')).scrollIntoView();await page.waitForFunction(()=>document.querySelector('[data-module]:not([hidden])').dataset.playing==='true');
 check('module tour starts when visible',true);
 await page.waitForFunction(()=>document.querySelector('#module-tab-triage').getAttribute('aria-selected')==='true',{timeout:10000});check('module tour advances to next module',true);
 await page.click('#module-tab-merge');await page.click('[data-gate="fail"]');check('merge failure preserves source error',await page.$eval('#module-merge',e=>e.dataset.result==='fail'&&e.querySelector('.module-cli pre').textContent.includes('error (invalid_transition)')));
 await page.click('[data-gate="pass"]');check('merge pass matches captured result',await page.$eval('#module-merge',e=>e.querySelector('.module-cli pre').textContent==='change 951e7eb3 completado'));
 await page.click('#module-tab-sandbox');await page.click('[data-platform="macos"]');check('macOS has no Linux isolation claim',await page.$eval('#module-sandbox',e=>getComputedStyle(e.querySelector('.linux-label')).display==='none'&&e.dataset.platform==='macos'));
 await page.focus('#module-tab-jira');await page.keyboard.press('ArrowDown');check('module ArrowDown selects triage',await page.$eval('#module-tab-triage',e=>e.getAttribute('aria-selected')==='true'&&document.activeElement===e));await page.keyboard.press('End');check('module End selects workers',await page.$eval('#module-tab-workers',e=>e.getAttribute('aria-selected')==='true'));
 await page.click('#module-tab-jira');await page.click('[data-module-play]');await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await delay(150);check('offscreen modules suspend',await page.$eval('#module-jira',e=>e.dataset.playing==='false'));
 await page.click('.architecture-detail summary');const embedded=await (await page.$('[data-diagram]')).contentFrame();await embedded.waitForFunction(()=>document.readyState==='complete');check('architecture embed works under Pages prefix',embedded.url().includes('/sw-factory/diagrams/sdlc-workflow.html'));
 await page.goto(new URL('agente/',base).href);check('router details retain optional Jev and operative costs',await page.evaluate(()=>document.querySelector('#router-auto').textContent.includes('Jev es opcional')&&document.querySelector('#router-auto').textContent.includes('relativeCost')&&document.querySelector('#router-omni').textContent.includes('no una tarifa verificada')));
}

function textContrast(){
 const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
 const rgb=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]};
 const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
 const bg=e=>{while(e){const c=rgb(getComputedStyle(e).backgroundColor);if(c[3]===255)return c;e=e.parentElement}return rgb(getComputedStyle(document.body).backgroundColor)};
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),failures=[];
 while(walker.nextNode()){
  const t=walker.currentNode,e=t.parentElement;
  if(!t.textContent.trim()||['SCRIPT','STYLE','NOSCRIPT','TITLE','DESC'].includes(e.tagName.toUpperCase())||!e.getClientRects().length||e.closest('[aria-hidden="true"]'))continue;
  const style=getComputedStyle(e);if(style.visibility==='hidden')continue;
  const actual=ratio(rgb(e instanceof SVGElement?style.fill:style.color),bg(e));
  const large=parseFloat(style.fontSize)>=24||(parseFloat(style.fontSize)>=18.66&&parseFloat(style.fontWeight)>=700);
  if(actual<(large?3:4.5))failures.push({text:t.textContent.trim(),actual});
 }
 return failures;
}
