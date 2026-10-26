(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const modeButton = document.querySelector('.theme-button');
  const systemMode = () => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const updateMode = () => {
    const current = root.dataset.mode || systemMode();
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

  const tabs = [...document.querySelectorAll('[role="tab"]')];
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
