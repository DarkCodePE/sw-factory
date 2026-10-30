// Illustrative state playback only. No commands or provider requests run here.
(() => {
  const host = document.querySelector('.module-explorer');
  if (!host) return;
  const tabs = [...host.querySelectorAll('[role="tab"]')];
  const panels = [...host.querySelectorAll('[data-module]')];
  const controls = document.querySelector('.module-playback');
  const play = controls.querySelector('[data-module-play]');
  const status = controls.querySelector('.module-state');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let selected = 0, step = 3, playing = false, visible = false, timer;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  function draw() {
    panels.forEach((panel, index) => {
      panel.hidden = index !== selected;
      panel.dataset.step = String(step);
      panel.dataset.playing = String(index === selected && playing && visible && !document.hidden && !motion.matches);
      panel.querySelectorAll('[data-step-label]').forEach((label, n) => { label.hidden = n !== step; });
    });
    play.textContent = playing ? 'Pausar pasos' : step === 3 ? 'Repetir pasos' : 'Reanudar pasos';
    play.disabled = motion.matches;
    status.setAttribute('aria-live', playing ? 'off' : 'polite');
    status.textContent = `${tabs[selected].textContent.trim()}: ${panels[selected].querySelector(`[data-step-label="${step}"]`).textContent}. Esquema ilustrativo.`;
  }
  function schedule() {
    stop(); draw();
    if (!playing || !visible || document.hidden || motion.matches) return;
    timer = setTimeout(() => { if (step < 3) step++; else playing = false; schedule(); }, 1400);
  }
  function finish() { playing = false; step = 3; schedule(); }
  function select(index, focus = false) {
    selected = index; step = 3; playing = false;
    tabs.forEach((tab, n) => { tab.setAttribute('aria-selected', String(n === index)); tab.tabIndex = n === index ? 0 : -1; });
    if (focus) tabs[index].focus({ preventScroll: true });
    schedule();
  }
  host.classList.add('is-interactive');
  host.querySelector('.module-tabs').hidden = false;
  controls.hidden = false;
  panels.forEach((panel, index) => {
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tabs[index].id); panel.tabIndex = 0;
    panel.querySelectorAll('.scenario-controls').forEach(group => { group.hidden = false; });
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      let next;
      if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % tabs.length;
      if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); select(next, true); }
    });
  });
  play.addEventListener('click', () => { if (motion.matches) return; if (step === 3) step = 0; playing = !playing; schedule(); });
  controls.querySelector('[data-module-next]').addEventListener('click', () => { playing = false; step = (step + 1) % 4; schedule(); });
  controls.querySelector('[data-module-end]').addEventListener('click', finish);
  panels.forEach(panel => panel.querySelectorAll('[data-gate], [data-platform]').forEach(button => button.addEventListener('click', () => {
    const key = button.hasAttribute('data-gate') ? 'gate' : 'platform';
    panel.dataset[key === 'gate' ? 'result' : 'platform'] = button.dataset[key];
    panel.querySelectorAll(`[data-${key}]`).forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    if (key === 'gate') panel.querySelector('.module-cli pre').textContent = button.dataset.gate === 'fail'
      ? 'error (invalid_transition): validadores en fail: qa; usa --force para fusionar igualmente' : 'change 951e7eb3 completado';
    finish();
  })));
  document.querySelectorAll('[data-open-module]').forEach(link => link.addEventListener('click', () => {
    select(panels.findIndex(p => p.dataset.module === link.dataset.openModule));
    panels[selected].focus({ preventScroll: true });
  }));
  motion.addEventListener('change', finish);
  document.addEventListener('visibilitychange', schedule);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; schedule(); }, { threshold: .1 }).observe(host);
  select(0);
})();
