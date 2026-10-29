/**
 * Wire a role="tablist" to its panels. The HTML already contains the buttons,
 * panels and aria-controls relationships; this only handles state and focus.
 *
 * @param {HTMLElement} tablist
 * @param {Record<string, HTMLElement>} panels
 * @param {(name: string) => void} [onActivate]
 */
export function setupTabs(tablist, panels, onActivate) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  if (tabs.length === 0) return { activate: () => {} };

  function activate(name, focus = false) {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const [panelName, panel] of Object.entries(panels)) {
      panel.hidden = panelName !== name;
    }
    onActivate?.(name);
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    activate(tab.dataset.tab);
  });

  tablist.addEventListener('keydown', (event) => {
    const current = event.target.closest('[role="tab"]');
    if (!current) return;
    const index = tabs.indexOf(current);
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next == null) return;
    event.preventDefault();
    activate(tabs[next].dataset.tab, true);
  });

  const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab
    ?? tabs[0].dataset.tab;
  activate(initial);

  return { activate };
}
