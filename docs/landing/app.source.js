(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const modeButton = document.querySelector('.theme-button');
  const systemMode = () => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const updateMode = () => {
    const current = root.dataset.mode || systemMode();
    document.querySelectorAll('[data-diagram]').forEach(frame => {
      const target = new URL(frame.getAttribute('src'), location.href);
      if (target.searchParams.get('theme') !== current) { target.searchParams.set('theme', current); frame.src = target.href; }
    });
    const label = current === 'dark' ? 'Tema claro' : 'Tema oscuro';
    modeButton.querySelector('span').textContent = label;
    modeButton.setAttribute('aria-label', `Cambiar al ${label.toLowerCase()}`);
  };
  updateMode();
  modeButton.hidden = false;
  modeButton.addEventListener('click', () => {
    root.dataset.mode = (root.dataset.mode || systemMode()) === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('fab-theme', root.dataset.mode); } catch { /* The control still works without storage. */ }
    updateMode();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateMode);

  const tabs = [...document.querySelectorAll('.install-tabs [role="tab"]')];
  const panels = [...document.querySelectorAll('.command-panel')];
  const status = document.querySelector('.copy-status');
  function selectTab(tab, focus = false) {
    tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panels.forEach(panel => { panel.hidden = panel.id !== tab.getAttribute('aria-controls'); });
    status.textContent = '';
    if (focus) tab.focus({ preventScroll: true });
  }
  document.querySelector('.install-tabs').hidden = false;
  panels.forEach((panel, index) => {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabs[index].id);
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let target;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') target = tabs[(index + 1) % tabs.length];
      if (event.key === 'Home') target = tabs[0];
      if (event.key === 'End') target = tabs.at(-1);
      if (target) { event.preventDefault(); selectTab(target, true); }
    });
  });
  selectTab(tabs[0]);

  document.querySelectorAll('[data-copy]').forEach(button => {
    button.disabled = false;
    button.addEventListener('click', async () => {
      const code = document.getElementById(button.dataset.copy);
      const label = button.querySelector('span');
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      status.textContent = '';
      label.textContent = 'Copiar';
      try {
        let copied = false;
        if (navigator.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(code.textContent); copied = true; } catch { /* Try the selection fallback. */ }
        }
        if (!copied) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(code);
          selection.removeAllRanges(); selection.addRange(range);
          copied = document.execCommand('copy');
          if (copied) selection.removeAllRanges();
        }
        if (!copied) throw new Error('Clipboard unavailable');
        label.textContent = 'Copiado';
        status.dataset.state = 'success';
        status.textContent = 'Comando copiado.';
      } catch {
        status.dataset.state = 'error';
        status.textContent = 'No se pudo copiar. Selecciona el comando.';
        code.focus({ preventScroll: true });
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        setTimeout(() => { label.textContent = 'Copiar'; }, 2000);
      }
    });
  });
})();

// A replay of captured CLI output. This controller never runs shell commands.
(() => {
  const demo = document.querySelector('.product-demo');
  if (!demo) return;
  const frames = [...demo.querySelectorAll('[data-frame]')];
  const screen = demo.querySelector('.demo-screen');
  const play = demo.querySelector('[data-demo-play]');
  const end = demo.querySelector('[data-demo-end]');
  const state = demo.querySelector('.demo-state');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let index = frames.length - 1;
  let running = false;
  let visible = false;
  let timer;
  let started = false;
  let pointerHeld = false;
  let focusHeld = false;
  function cancel() { clearTimeout(timer); timer = undefined; }
  function draw() {
    frames.forEach((frame, i) => {
      const history = 2;
      frame.hidden = index === frames.length - 1 && !running ? ![6, 9, 10].includes(i) : i > index || i < index - history + 1;
      frame.classList.toggle('is-current', running && i === index && !motion.matches);
    });
    demo.classList.toggle('is-summary', index === frames.length - 1 && !running);
    screen.scrollTop = index === frames.length - 1 && !running ? 0 : screen.scrollHeight;
    demo.dataset.frame = String(index);
    demo.dataset.playing = String(running && visible && !document.hidden && !pointerHeld && !focusHeld);
    play.disabled = motion.matches;
    play.textContent = running ? 'Pausar' : index === frames.length - 1 ? 'Repetir' : 'Reanudar';
    state.textContent = motion.matches ? 'Resultado final.' : running && (pointerHeld || focusHeld) ? 'En pausa mientras lees.' : running ? 'Reproduciendo sesión.' : index === frames.length - 1 ? 'Sesión finalizada.' : 'Reproducción en pausa.';
  }
  function schedule() {
    cancel();
    if (!running || !visible || document.hidden || motion.matches || pointerHeld || focusHeld) return;
    // Slow down at the failed verdict/blocked merge, then at the successful verdict.
    const delay = [5, 6, 9].includes(index) ? 2400 : 700;
    timer = setTimeout(() => {
      if (index < frames.length - 1) index++;
      else running = false;
      draw(); schedule();
    }, delay);
  }
  function finish() { cancel(); index = frames.length - 1; running = false; draw(); }
  play.hidden = false; end.hidden = false;
  play.addEventListener('click', () => {
    if (motion.matches) return;
    if (index === frames.length - 1) index = 0;
    running = !running; draw(); schedule();
  });
  end.addEventListener('click', finish);
  motion.addEventListener('change', () => { if (motion.matches) finish(); else draw(); });
  document.addEventListener('visibilitychange', () => { draw(); schedule(); });
  demo.addEventListener('pointerenter', () => { pointerHeld = true; draw(); schedule(); });
  demo.addEventListener('pointerleave', () => { pointerHeld = false; draw(); schedule(); });
  demo.addEventListener('focusin', () => { focusHeld = true; draw(); schedule(); });
  demo.addEventListener('focusout', () => setTimeout(() => { focusHeld = demo.contains(document.activeElement); draw(); schedule(); }, 0));
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible && !started && !motion.matches) { started = true; index = 0; running = true; draw(); }
    draw(); schedule();
  }, { threshold: .15 }).observe(demo);
  finish();
})();

// Browsers keep document.activeElement on the iframe while its controls own focus.
// Mirror that browsing-context focus so keyboard users can see the outer boundary.
(() => {
  const frames = [...document.querySelectorAll('[data-diagram]')];
  const sync = () => frames.forEach(frame => frame.classList.toggle('is-focused', document.activeElement === frame));
  window.addEventListener('blur', () => setTimeout(sync, 0));
  window.addEventListener('focus', sync);
  document.addEventListener('focusin', sync);
})();
;(()=>{let S=document.querySelectorAll('.hero-relation, .sandbox-summary-figure, .models-overview-figure, .plans-overview-figure');let M=matchMedia('(prefers-reduced-motion: reduce)'),U=(e,a)=>{e.dataset.sceneActive=String(a);let s=e.querySelector('svg');if(s)s.dataset.sceneActive=String(a)},O=new IntersectionObserver(E=>E.forEach(e=>U(e.target,e.isIntersecting&&!document.hidden&&!M.matches)),{threshold:0.1});S.forEach(e=>O.observe(e));let R=()=>S.forEach(e=>U(e,!document.hidden&&!M.matches&&e.getBoundingClientRect().top<innerHeight&&e.getBoundingClientRect().bottom>0));document.addEventListener('visibilitychange',R);M.addEventListener('change',R)})();

// Decorative field: precomputed cables, 30 draws/second, no loop while inactive.
(() => {
 const canvas=document.querySelector('.hero-field'), hero=canvas?.parentElement;

 const ctx=canvas.getContext('2d'), receiver=document.querySelector('[data-field-receiver]');
 const motion=matchMedia('(prefers-reduced-motion: reduce)');
 let paths=[],width=0,height=0,visible=false,raf=0,last=0,frames=0;
 function draw(time=0){
  ctx.clearRect(0,0,width,height);
  const dark=(document.documentElement.dataset.mode || (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark';
  ctx.fillStyle=dark?'#14b8a6':'#087c70';
  let glow=0;
  paths.forEach((points,i)=>{
   ctx.globalAlpha=dark?.2:.13;
   points.forEach(([x,y])=>{ctx.beginPath();ctx.arc(x,y,1,0,Math.PI*2);ctx.fill()});
   const phase=motion.matches?.65:((time/6500+i/paths.length)%1);
   const point=points[Math.floor(phase*(points.length-1))];
   ctx.globalAlpha=dark?.65:.45;
   ctx.beginPath();ctx.arc(point[0],point[1],2.5,0,Math.PI*2);ctx.fill();
   if(!motion.matches)glow=Math.max(glow,Math.max(0,(phase-.94)/.06));
  });
  receiver.style.setProperty('--receive',glow);
  canvas.dataset.frames=++frames;
 }
 function tick(time){raf=0;if(time-last>=1000/30){draw(time);last=time}raf=requestAnimationFrame(tick)}
 function sync(){
  cancelAnimationFrame(raf);raf=0;
  const active=visible&&!document.hidden&&!motion.matches;
  canvas.dataset.state=motion.matches?'reduced':active?'running':'paused';
  if(active)raf=requestAnimationFrame(tick);
  else receiver.style.setProperty('--receive','0');
 }
 function resize(){
  const box=hero.getBoundingClientRect(),target=receiver.getBoundingClientRect();
  width=box.width;height=box.height;
  const dpr=Math.min(devicePixelRatio||1,2);canvas.dataset.pixelRatio=dpr;
  canvas.width=width*dpr;canvas.height=height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  const ex=target.left-box.left+target.width/2,ey=target.top-box.top+target.height/2;
  paths=Array.from({length:8},(_,i)=>Array.from({length:65},(_,j)=>{
   const t=j/64,u=1-t,sx=width*i/7;
   return [u*u*sx+2*u*t*(sx-width*.18)+t*t*ex,u*u*20+2*u*t*(ey+90)+t*t*ey];
  }));
  draw();sync();
 }
 new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync()}).observe(hero);
 new ResizeObserver(resize).observe(hero);
 document.addEventListener('visibilitychange',sync);
 motion.addEventListener('change',resize);
 new MutationObserver(resize).observe(document.documentElement,{attributes:true,attributeFilter:['data-mode']});

 matchMedia('(prefers-color-scheme: dark)').addEventListener('change',resize);
 resize();
})();
