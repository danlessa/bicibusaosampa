// Screen furniture shared by the whole app: the two sheets (menu and layers), the
// toast, and the "new version" banner of the service worker.
//
// On phones the sheets sit at the bottom of the screen; dragging the grip changes their
// height, and dragging it almost all the way down closes the sheet. On wider screens
// they float as cards. Only one sheet is open at a time on phones.

const phone = matchMedia('(max-width: 640px)');
const MIN_HEIGHT = 140; // px; below CLOSE_HEIGHT a drag closes the sheet
const CLOSE_HEIGHT = 90;
const TOP_GAP = 72; // px kept free above a phone sheet

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// ---------------------------------------------------------------- toast

let toastTimer;
/** A short message at the top; `action` ({ label, run }) adds a button, e.g. "Desfazer". */
export function toast(message, { ms = 2600, action = null } = {}) {
  const el = document.getElementById('toast');
  el.replaceChildren(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      el.classList.remove('show');
      action.run();
    }, { once: true });
    el.append(button);
  }
  el.classList.toggle('actionable', !!action);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(ms, 5000) : ms);
}

// ---------------------------------------------------------------- sheets

const sheets = new Map(); // id -> { el, button }

export function isSheetOpen(id) {
  return !sheets.get(id)?.el.classList.contains('collapsed');
}

export function setSheetOpen(id, open) {
  const sheet = sheets.get(id);
  if (!sheet) return;
  sheet.el.classList.toggle('collapsed', !open);
  sheet.button.setAttribute('aria-pressed', String(open));
  if (open && phone.matches) {
    for (const [other] of sheets) if (other !== id) setSheetOpen(other, false);
  }
  if (id === 'panel') remember('panelCollapsed', open ? '' : '1');
  // Keyboard and screen-reader users land in a sheet they open.
  if (open && sheet.opened) sheet.el.focus({ preventScroll: true });
  document.body.classList.toggle('sheet-open', [...sheets.keys()].some(isSheetOpen));
  window.dispatchEvent(new CustomEvent('sheetchange'));
}

function wireGrip(grip, id) {
  const box = grip.parentElement;
  grip.addEventListener('pointerdown', (e) => {
    if (!phone.matches) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch {}
    const startY = e.clientY;
    const startH = box.getBoundingClientRect().height;
    box.classList.add('dragging');
    const move = (ev) => {
      const h = Math.min(window.innerHeight - TOP_GAP, startH + (startY - ev.clientY));
      box.style.height = `${Math.max(CLOSE_HEIGHT - 20, h)}px`;
      box.style.maxHeight = 'none';
    };
    const stop = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', stop);
      grip.removeEventListener('pointercancel', stop);
      box.classList.remove('dragging');
      const h = box.getBoundingClientRect().height;
      if (h < CLOSE_HEIGHT) {
        box.style.height = '';
        box.style.maxHeight = '';
        setSheetOpen(id, false);
      } else {
        box.style.height = `${Math.max(MIN_HEIGHT, h)}px`;
        remember(`sheetHeight:${id}`, String(Math.round(Math.max(MIN_HEIGHT, h))));
      }
      // A tap on the grip (no drag) toggles between the default and a tall sheet.
      if (Math.abs(ev.clientY - startY) < 4) {
        const tall = window.innerHeight - TOP_GAP;
        box.style.maxHeight = 'none';
        box.style.height = `${h > tall * 0.75 ? Math.round(window.innerHeight * 0.45) : tall}px`;
      }
      window.dispatchEvent(new CustomEvent('sheetchange'));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  });
}

export function initSheets() {
  for (const [id, buttonId] of [['panel', 'panel-toggle'], ['layers-panel', 'layers-toggle']]) {
    const el = document.getElementById(id);
    const button = document.getElementById(buttonId);
    sheets.set(id, { el, button });
    button.addEventListener('click', () => {
      const open = !isSheetOpen(id);
      sheets.get(id).opened = open; // focus only when the user opens it
      setSheetOpen(id, open);
      sheets.get(id).opened = false;
      if (!open) button.focus();
    });
    const grip = el.querySelector('.grip');
    if (grip) wireGrip(grip, id);
    try {
      const h = Number(localStorage.getItem(`sheetHeight:${id}`));
      if (h && phone.matches) {
        el.style.height = `${Math.min(window.innerHeight - TOP_GAP, h)}px`;
        el.style.maxHeight = 'none';
      }
    } catch {}
  }
  // Escape closes the sheet on top (search lists handle their own Escape first).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const open = [...sheets.keys()].filter(isSheetOpen);
    const id = open.find((k) => sheets.get(k).el.contains(document.activeElement)) ?? open.at(-1);
    if (!id) return;
    setSheetOpen(id, false);
    sheets.get(id).button.focus();
  });
  // Phones: the menu starts at a low "peek" height (unless the user resized it) and
  // grows to its normal size on first use.
  const menu = document.getElementById('panel');
  if (phone.matches && !menu.style.height) {
    menu.classList.add('peek');
    const grow = () => menu.classList.remove('peek');
    menu.addEventListener('focusin', grow, { once: true });
    menu.addEventListener('pointerdown', (e) => { if (!e.target.closest('.grip')) grow(); }, { once: true });
    window.addEventListener('plan-results', grow, { once: true });
  }
  let collapsed = null;
  try { collapsed = localStorage.getItem('panelCollapsed'); } catch {}
  setSheetOpen('panel', collapsed !== '1');
  setSheetOpen('layers-panel', false);
  // Keep a dragged height within the screen after rotating the phone.
  window.addEventListener('resize', () => {
    for (const { el } of sheets.values()) {
      if (!phone.matches) { el.style.height = ''; el.style.maxHeight = ''; continue; }
      const h = parseFloat(el.style.height);
      if (h > window.innerHeight - TOP_GAP) el.style.height = `${Math.max(MIN_HEIGHT, window.innerHeight - TOP_GAP)}px`;
    }
  });
}

/** Height of the screen covered by open sheets at the bottom (phones) or their right edge (wide screens). */
export function sheetInsets() {
  let bottom = 0, left = 0;
  for (const [id, { el }] of sheets) {
    if (!isSheetOpen(id)) continue;
    const r = el.getBoundingClientRect();
    if (phone.matches) bottom = Math.max(bottom, window.innerHeight - r.top);
    else if (r.left < window.innerWidth / 2) left = Math.max(left, r.right);
  }
  return { bottom, left };
}

// ---------------------------------------------------------------- updates (PWA)

// The service worker (/sw.js, served by functions/sw.js.js with the deployed commit as
// its version) takes over as soon as a new deploy is installed; we then offer a reload
// instead of swapping code under the user's feet. Checks again whenever the app comes
// back to the foreground, which matters for an installed PWA that stays suspended.
export function initUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((err) => console.warn('service worker unavailable', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) document.getElementById('update-banner').hidden = false;
  });
  document.getElementById('update-banner').addEventListener('click', () => location.reload());
}
