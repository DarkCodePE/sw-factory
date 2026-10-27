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
  matchMedia('(max-width: 48rem)').addEventListener('change', draw);
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
