/* ============================================================
   Studio Lash Admin — app.js
   Frontend vanilla. Conecta com backend Express via fetch().
   ============================================================ */

'use strict';

/* ---------- Util ---------- */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function localDateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtTime(d) { return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(d); }
function fmtDate(d) { return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(d); }
function fmtMoney(v){ return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v); }
function fmtDuration(min) {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min/60), m = min%60;
  return m ? `${h}h ${m}min` : `${h}h`;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

/* ============================================================
   API — camada única de comunicação com o backend
   Ajuste BASE_URL se sua API estiver em outro host/porta.
   ============================================================ */

const Api = (() => {
  const BASE_URL = '/api/admin';
  const TOKEN_KEY = 'studiolash_token';

  function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
  function setToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

  async function request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const opts = { method, headers };
    if (body !== null) opts.body = JSON.stringify(body);

    const res = await fetch(BASE_URL + path, opts);

    if (res.status === 401) {
      clearToken();
      Auth.show();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      let msg = 'Erro no servidor';
      try { const data = await res.json(); msg = data.error || msg; } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    getToken, setToken, clearToken,
    get:    (p)     => request('GET', p),
    post:   (p, b)  => request('POST', p, b),
    put:    (p, b)  => request('PUT', p, b),
    patch:  (p, b)  => request('PATCH', p, b),
    delete: (p)     => request('DELETE', p),
  };
})();

/* ============================================================
   TOAST SYSTEM
   ============================================================ */

const Toast = (() => {
  const container = $('#toast-container');
  const active = new Map();

  function build({ message, type, action, duration, id }) {
    const el = document.createElement('div');
    el.className = `toast ${type ? 'toast-' + type : ''}`;
    el.style.setProperty('--toast-duration', duration + 'ms');
    el.dataset.id = id;

    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = message;
    el.appendChild(msg);

    if (action) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        try { action.onClick(); } catch (e) { console.error(e); }
        dismiss(id);
      });
      el.appendChild(btn);
    }

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Fechar');
    close.innerHTML = '×';
    close.addEventListener('click', () => dismiss(id));
    el.appendChild(close);

    const progress = document.createElement('div');
    progress.className = 'toast-progress';
    el.appendChild(progress);

    return el;
  }

  function dismiss(id) {
    const entry = active.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.el.classList.add('toast-leave');
    setTimeout(() => { entry.el.remove(); active.delete(id); }, 180);
  }

  function show(message, options = {}) {
    const { type = null, action = null, duration = action ? 6000 : 4000 } = options;
    const id = Math.random().toString(36).slice(2);
    const el = build({ message, type, action, duration, id });
    container.appendChild(el);

    const timer = setTimeout(() => dismiss(id), duration);
    active.set(id, { el, timer });

    el.addEventListener('mouseenter', () => {
      const e = active.get(id);
      if (e) {
        clearTimeout(e.timer);
        el.querySelector('.toast-progress').style.animationPlayState = 'paused';
      }
    });
    el.addEventListener('mouseleave', () => {
      const e = active.get(id);
      if (e) {
        e.timer = setTimeout(() => dismiss(id), 1500);
        el.querySelector('.toast-progress').style.animationPlayState = 'running';
      }
    });

    return id;
  }

  return {
    show,
    success: (m, o = {}) => show(m, { ...o, type: 'success' }),
    error:   (m, o = {}) => show(m, { ...o, type: 'error' }),
    dismiss
  };
})();

/* ============================================================
   UNDO STACK
   ============================================================ */

const UndoStack = (() => {
  const stack = [];

  function push(action) {
    stack.push(action);
    Toast.show(action.label, {
      action: { label: 'Desfazer', onClick: () => pop() }
    });
  }

  async function pop() {
    const action = stack.pop();
    if (!action) return;
    try {
      await action.undo();
      Toast.show('Desfeito', { duration: 2000 });
    } catch (e) {
      Toast.error('Não foi possível desfazer');
      console.error(e);
    }
  }

  function clear() { stack.length = 0; }
  return { push, pop, clear, get size() { return stack.length; } };
})();

/* ============================================================
   MODAL
   ============================================================ */

const Modal = (() => {
  let lastFocus = null;

  function trapFocus(modalEl, e) {
    if (e.key !== 'Tab') return;
    const focusable = $$('input, select, textarea, button, [tabindex]:not([tabindex="-1"])', modalEl)
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open(selector, options = {}) {
    const el = typeof selector === 'string' ? $(selector) : selector;
    if (!el) return;
    lastFocus = document.activeElement;
    el.hidden = false;
    el.classList.remove('closing');

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(el); }
      trapFocus(el, e);
    };
    const backdrop = el.querySelector('.modal-backdrop');
    const onBackdrop = () => close(el);

    el._cleanup = () => {
      document.removeEventListener('keydown', onKey);
      backdrop && backdrop.removeEventListener('click', onBackdrop);
      if (options.onClose) options.onClose();
    };
    document.addEventListener('keydown', onKey);
    backdrop && backdrop.addEventListener('click', onBackdrop);

    setTimeout(() => {
      const first = el.querySelector('input, select, textarea, button');
      first && first.focus();
    }, 50);
  }

  async function close(selector) {
    const el = typeof selector === 'string' ? $(selector) : selector;
    if (!el || el.hidden) return;
    el.classList.add('closing');
    await sleep(180);
    el.hidden = true;
    el.classList.remove('closing');
    if (el._cleanup) { el._cleanup(); el._cleanup = null; }
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function confirm({
    title = 'Confirmar',
    message = 'Tem certeza?',
    confirmLabel = 'Confirmar',
    cancelLabel = 'Cancelar',
    danger = false
  } = {}) {
    return new Promise(resolve => {
      const modal = $('#confirm-modal');
      $('#confirm-modal-title').textContent = title;
      $('#confirm-modal-message').textContent = message;
      const okBtn = $('#confirm-ok');
      const cancelBtn = $('#confirm-cancel');
      okBtn.textContent = confirmLabel;
      cancelBtn.textContent = cancelLabel;
      okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

      const cleanup = (result) => {
        okBtn.replaceWith(okBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        close(modal).then(() => resolve(result));
      };

      $('#confirm-ok').addEventListener('click', () => cleanup(true), { once: true });
      $('#confirm-cancel').addEventListener('click', () => cleanup(false), { once: true });
      open(modal, { onClose: () => resolve(false) });
    });
  }

  return { open, close, confirm };
})();

/* ============================================================
   INLINE CONFIRM
   ============================================================ */

const InlineConfirm = {
  show(targetCell, { message, onConfirm }) {
    const original = targetCell.innerHTML;
    const wrap = document.createElement('div');
    wrap.className = 'inline-confirm';
    wrap.innerHTML = `
      <span>${message}</span>
      <button class="yes" type="button">Sim</button>
      <button class="no" type="button">Não</button>
    `;
    targetCell.innerHTML = '';
    targetCell.appendChild(wrap);

    let resolved = false;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      if (val) onConfirm();
      targetCell.innerHTML = original;
    };

    wrap.querySelector('.yes').addEventListener('click', () => finish(true));
    wrap.querySelector('.no').addEventListener('click', () => finish(false));
    setTimeout(() => finish(false), 6000);
  }
};

/* ============================================================
   FORM HELPERS
   ============================================================ */

const Form = {
  setError(fieldId, msg) {
    const field = document.getElementById(fieldId);
    const errEl = document.getElementById(fieldId + '-error');
    if (!field) return;
    field.setAttribute('aria-invalid', 'true');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  },
  clearError(fieldId) {
    const field = document.getElementById(fieldId);
    const errEl = document.getElementById(fieldId + '-error');
    if (field) field.removeAttribute('aria-invalid');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  },
  clearAll(formEl) {
    $$('[aria-invalid]', formEl).forEach(el => el.removeAttribute('aria-invalid'));
    $$('.field-error', formEl).forEach(el => { el.hidden = true; el.textContent = ''; });
  }
};
document.addEventListener('input', e => {
  if (e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) {
    Form.clearError(e.target.id);
  }
});

const Button = {
  setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
  }
};

/* ============================================================
   TABS
   ============================================================ */

const Tabs = (() => {
  function activate(tabName) {
    $$('.tab-btn').forEach(btn => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    $$('.tab-content').forEach(panel => {
      const active = panel.dataset.tab === tabName;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
    document.dispatchEvent(new CustomEvent('tab:activate', { detail: { tab: tabName } }));
  }

  function init() {
    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => activate(btn.dataset.tab));
    });
  }

  return { init, activate };
})();

/* ============================================================
   SHORTCUTS
   ============================================================ */

const Shortcuts = (() => {
  const map = new Map();
  function register(combo, handler) { map.set(combo, handler); }
  function parseEvent(e) {
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push('mod');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey)   parts.push('alt');
    const key = e.key.toLowerCase();
    if (!['control','shift','alt','meta'].includes(key)) parts.push(key);
    return parts.join('+');
  }
  function init() {
    document.addEventListener('keydown', e => {
      const inField = ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName);
      const combo = parseEvent(e);
      const allowInField = ['escape', 'mod+z', 'mod+enter'];
      if (inField && !allowInField.includes(combo)) return;
      const handler = map.get(combo);
      if (handler) { e.preventDefault(); handler(e); }
    });
  }
  return { register, init };
})();

/* ============================================================
   AUTH — agora com API real
   ============================================================ */

const Auth = (() => {
  function show() {
    $('#auth-overlay').hidden = false;
    $('#app-header').hidden = true;
    $('#app-main').hidden = true;
    setTimeout(() => $('#auth-password').focus(), 50);
  }

  function hide() {
    const overlay = $('#auth-overlay');
    overlay.hidden = true;
    $('#app-header').hidden = false;
    $('#app-main').hidden = false;
  }

  async function login(password) {
    try {
      const data = await Api.post('/auth/login', { password });
      if (data && data.token) {
        Api.setToken(data.token);
        return true;
      }
      return false;
    } catch (e) {
      console.error('[AUTH] login error:', e);
      return false;
    }
  }

  function logout() {
    Api.clearToken();
    UndoStack.clear();
    show();
    Toast.show('Sessão encerrada');
  }

  function init() {
    const btn = $('#auth-login');
    const input = $('#auth-password');
    const errEl = $('#auth-error');

    const attempt = async () => {
      const pwd = input.value.trim();
      if (!pwd) {
        errEl.textContent = 'Digite a chave de acesso';
        errEl.hidden = false;
        return;
      }
      Button.setLoading(btn, true);
      errEl.hidden = true;
      const ok = await login(pwd);
      Button.setLoading(btn, false);
      if (ok) {
        hide();
        Toast.success('Bem-vindo de volta');
        App.boot();
      } else {
        errEl.textContent = 'Chave inválida';
        errEl.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        input.select();
      }
    };

    btn.addEventListener('click', attempt, { once: false });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
    $('#logout').addEventListener('click', logout);

    if (Api.getToken()) {
      hide();
      App.boot();
    } else {
      show();
    }
  }

  return { init, show, logout };
})();

/* ============================================================
   SERVICES — agora conectado ao backend
   ============================================================ */

const Services = (() => {
  let items = [];

  async function load() {
    try {
      items = await Api.get('/services');
      render();
    } catch (e) {
      Toast.error('Falha ao carregar serviços');
      console.error(e);
    }
  }

  function renderSkeleton() {
    const el = $('#services-cards');
    el.innerHTML = Array(3).fill(0).map(() => `
      <div class="service-card">
        <div class="service-card-info">
          <div class="skel skel-md" style="height:16px;margin-bottom:8px"></div>
          <div class="skel skel-sm" style="height:12px"></div>
        </div>
        <div class="skel skel-xs" style="height:30px;width:60px;border-radius:6px"></div>
      </div>`).join('');
  }

  function render() {
    const el = $('#services-cards');
    if (!items.length) {
      el.innerHTML = `
        <div class="empty-state-rich" style="padding:48px 0">
          <div class="empty-title">Nenhum serviço cadastrado</div>
          <div class="empty-sub">Toque em "+ Adicionar" para começar.</div>
        </div>`;
      return;
    }
    el.innerHTML = items.map(s => `
      <div class="service-card row-enter" data-id="${s.id}">
        <div class="service-card-info">
          <span class="service-card-name">${escapeHTML(s.name)}</span>
          <div class="service-card-meta">
            <span>${fmtDuration(s.duration)}</span>
            <span class="service-card-dot">·</span>
            <span>${fmtMoney(s.price)}</span>
          </div>
        </div>
        <div class="service-card-actions">
          <button class="btn btn-ghost btn-sm" data-action="edit-service" data-id="${s.id}">Editar</button>
          <button class="btn btn-ghost btn-sm" data-action="delete-service" data-id="${s.id}">Excluir</button>
        </div>
      </div>`).join('');
  }

  function openModal(service = null) {
    Form.clearAll($('#serviceForm'));
    $('#service-id').value = service ? service.id : '';
    $('#service-name').value = service ? service.name : '';
    $('#service-duration').value = service ? service.duration : '';
    $('#service-price').value = service ? service.price : '';
    $('#services-modal-title').textContent = service ? 'Editar serviço' : 'Novo serviço';
    Modal.open('#services-modal');
  }

  function validate() {
    Form.clearAll($('#serviceForm'));
    let ok = true;
    const name = $('#service-name').value.trim();
    const duration = parseInt($('#service-duration').value, 10);
    const price = parseFloat($('#service-price').value);

    if (!name) { Form.setError('service-name', 'Nome obrigatório'); ok = false; }
    if (!duration || duration < 15) { Form.setError('service-duration', 'Mínimo 15 minutos'); ok = false; }
    if (isNaN(price) || price < 0) { Form.setError('service-price', 'Preço inválido'); ok = false; }
    return ok ? { name, duration, price } : null;
  }

  async function save(e) {
    e.preventDefault();
    const data = validate();
    if (!data) return;

    const btn = $('#service-save');
    Button.setLoading(btn, true);

    try {
      const idStr = $('#service-id').value;
      if (idStr) {
        const id = parseInt(idStr, 10);
        const prev = items.find(s => s.id === id);
        const prevSnapshot = { ...prev };
        const updated = await Api.put(`/services/${id}`, data);
        const idx = items.findIndex(s => s.id === id);
        items[idx] = updated;
        render();
        UndoStack.push({
          label: 'Serviço atualizado',
          undo: async () => {
            const restored = await Api.put(`/services/${id}`, prevSnapshot);
            const i = items.findIndex(s => s.id === id);
            items[i] = restored;
            render();
          }
        });
      } else {
        const created = await Api.post('/services', data);
        items.push(created);
        render();
        UndoStack.push({
          label: 'Serviço criado',
          undo: async () => {
            await Api.delete(`/services/${created.id}`);
            items = items.filter(s => s.id !== created.id);
            render();
          }
        });
      }
      Modal.close('#services-modal');
    } catch (err) {
      Toast.error(err.message || 'Erro ao salvar');
      console.error(err);
    } finally {
      Button.setLoading(btn, false);
    }
  }

  async function remove(id) {
    const idx = items.findIndex(s => s.id === id);
    if (idx === -1) return;
    const removed = items[idx];

    // Optimistic update: tira da UI antes da resposta
    items.splice(idx, 1);
    render();

    try {
      await Api.delete(`/services/${id}`);
      UndoStack.push({
        label: `"${removed.name}" excluído`,
        undo: async () => {
          const restored = await Api.post('/services', {
            name: removed.name, duration: removed.duration, price: removed.price
          });
          items.splice(idx, 0, restored);
          render();
        }
      });
    } catch (err) {
      // Rollback se a API falhou
      items.splice(idx, 0, removed);
      render();
      Toast.error('Falha ao excluir');
    }
  }

  function init() {
    $('#service-add').addEventListener('click', () => openModal());
    $('#service-cancel').addEventListener('click', () => Modal.close('#services-modal'));
    $('#serviceForm').addEventListener('submit', save);

    $('#services-cards').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      const action = btn.dataset.action;
      if (action === 'edit-service') {
        const s = items.find(x => x.id === id);
        if (s) openModal(s);
      } else if (action === 'delete-service') {
        InlineConfirm.show(btn.closest('.service-card-actions'), {
          message: 'Excluir?',
          onConfirm: () => remove(id)
        });
      }
    });

    document.addEventListener('tab:activate', (e) => {
      if (e.detail.tab === 'services') {
        renderSkeleton();
        load();
      }
    });
  }

  return { init, load, renderSkeleton };
})();

/* ============================================================
   AGENDA
   ============================================================ */

const Agenda = (() => {
  let items = [];
  let currentDay = new Date();
  currentDay.setHours(0, 0, 0, 0);

  function dayLabel(d) {
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((d - today) / 86400000);
    const base = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }).format(d);
    if (diff === 0) return `Hoje — ${base}`;
    if (diff === 1) return `Amanhã — ${base}`;
    if (diff === -1) return `Ontem — ${base}`;
    return base;
  }

  function updateDayLabel() {
    const el = $('#agenda-day-label');
    if (el) el.textContent = dayLabel(currentDay);
  }

  const STATUS_LABELS = {
    confirmed: 'Confirmado',
    cancelled: 'Cancelado',
    completed: 'Concluído',
    no_show: 'Não compareceu',
  };

  function pillHtml(status) {
    return `<span class="status-badge status-${status}">${escapeHTML(STATUS_LABELS[status] || status)}</span>`;
  }

  function rowActionsHtml(item) {
    const disabled = item.status === 'cancelled' || item.status === 'completed';
    if (disabled) return '';
    return `
      <div class="row-actions">
        <button class="btn btn-ghost btn-sm" data-action="cancel-apt" data-id="${item.id}">Cancelar</button>
        <button class="btn btn-ghost btn-sm" data-action="complete-apt" data-id="${item.id}">Concluir</button>
      </div>`;
  }

  async function load() {
    renderSkeleton();
    updateDayLabel();
    try {
      // Use UTC midnight boundaries so appointments stored in UTC are correctly bucketed
      const startUTC = new Date(Date.UTC(currentDay.getFullYear(), currentDay.getMonth(), currentDay.getDate()));
      const endUTC = new Date(startUTC); endUTC.setUTCDate(endUTC.getUTCDate() + 1);
      const start = startUTC.toISOString();
      const end = endUTC.toISOString();
      items = await Api.get(`/appointments?start=${start}&end=${end}`);
      render();
    } catch (e) {
      Toast.error('Falha ao carregar agendamentos');
      console.error(e);
    }
  }

  function renderSkeleton() {
    const tbody = $('#appointments-tbody');
    tbody.innerHTML = Array(4).fill(0).map(() => `
      <tr>
        ${Array(7).fill('<td><div class="skel"></div></td>').join('')}
      </tr>`).join('');
  }

  function render() {
    const tbody = $('#appointments-tbody');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">
        <div class="empty-state-rich">
          <div class="empty-title">Nenhum agendamento encontrado</div>
          <div class="empty-sub">Tente ajustar o filtro de datas ou status.</div>
        </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(a => {
      const dt = new Date(a.starts_at);
      return `
        <tr data-id="${a.id}" class="row-enter">
          <td class="num">${fmtTime(dt)}</td>
          <td class="num">${fmtDate(dt)}</td>
          <td>${escapeHTML(a.client_name || a.client_phone || '—')}</td>
          <td>${escapeHTML(a.service_name || '—')}</td>
          <td class="num">${fmtDuration(a.duration || a.duration_minutes || 0)}</td>
          <td>${pillHtml(a.status)}</td>
          <td>${rowActionsHtml(a)}</td>
        </tr>`;
    }).join('');
  }

  async function patchStatus(id, newStatus) {
    const idx = items.findIndex(a => a.id === id);
    if (idx === -1) return;
    const prev = items[idx];
    items[idx] = { ...prev, status: newStatus };
    render();
    try {
      await Api.patch(`/appointments/${id}`, { status: newStatus });
      UndoStack.push({
        label: `Agendamento ${newStatus === 'cancelled' ? 'cancelado' : 'concluído'}`,
        undo: async () => {
          await Api.patch(`/appointments/${id}`, { status: prev.status });
          items[idx] = prev;
          render();
        }
      });
    } catch (err) {
      items[idx] = prev;
      render();
      Toast.error('Falha ao atualizar agendamento');
    }
  }

  function init() {
    $('#agenda-prev').addEventListener('click', () => {
      currentDay.setDate(currentDay.getDate() - 1);
      load();
    });
    $('#agenda-next').addEventListener('click', () => {
      currentDay.setDate(currentDay.getDate() + 1);
      load();
    });

    $('#appointments-tbody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (btn.dataset.action === 'cancel-apt') {
        InlineConfirm.show(btn.closest('td'), {
          message: 'Cancelar agendamento?',
          onConfirm: () => patchStatus(id, 'cancelled')
        });
      } else if (btn.dataset.action === 'complete-apt') {
        patchStatus(id, 'completed');
      }
    });

    document.addEventListener('tab:activate', e => {
      if (e.detail.tab === 'agenda') { renderSkeleton(); load(); }
    });
  }

  return { init, load, renderSkeleton };
})();

/* ============================================================
   HOURS
   ============================================================ */

const Hours = (() => {
  let items = [];
  let activeSub = 'expediente';

  const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const DAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  async function load() {
    renderSkeleton();
    try {
      items = await Api.get('/working-hours');
      render();
    } catch (e) {
      Toast.error('Falha ao carregar horários');
      console.error(e);
    }
  }

  function renderSkeleton() {
    const el = $('#hours-cards');
    el.innerHTML = Array(7).fill(0).map(() => `
      <div class="hours-card">
        <div class="hours-card-day"><div class="skel skel-xs"></div></div>
        <div class="hours-card-fields">
          <div class="skel skel-md" style="height:44px;border-radius:8px"></div>
          <div class="skel skel-md" style="height:44px;border-radius:8px"></div>
        </div>
      </div>`).join('');
  }

  const debounceMap = new Map();
  function debounce(key, fn, delay = 500) {
    clearTimeout(debounceMap.get(key));
    debounceMap.set(key, setTimeout(fn, delay));
  }

  async function saveField(id, field, value) {
    try {
      await Api.patch(`/working-hours/${id}`, { [field]: value });
    } catch (e) {
      Toast.error('Falha ao salvar horário');
      console.error(e);
    }
  }

  function cardHtml(h) {
    const isClosed = h.is_closed === 1 || h.is_closed === true;
    const dayName = DAY_NAMES[h.day_of_week] || `Dia ${h.day_of_week}`;
    const dayShort = DAY_SHORT[h.day_of_week] || '';

    const closedToggle = `
      <label class="toggle-row">
        <span class="toggle-label">Fechado</span>
        <span class="toggle-switch">
          <input type="checkbox" data-field="is_closed" data-id="${h.id}" ${isClosed ? 'checked' : ''}>
          <span class="toggle-knob"></span>
        </span>
      </label>`;

    if (activeSub === 'expediente') {
      return `
        <div class="hours-card ${isClosed ? 'hours-card-closed' : ''}" data-id="${h.id}">
          <div class="hours-card-day">
            <span class="hours-day-full">${escapeHTML(dayName)}</span>
            <span class="hours-day-short">${escapeHTML(dayShort)}</span>
            <span class="hours-status-badge ${isClosed ? 'badge-closed' : 'badge-open'}">${isClosed ? 'Fechado' : 'Aberto'}</span>
          </div>
          <div class="hours-card-body">
            ${closedToggle}
            <div class="hours-time-row ${isClosed ? 'is-disabled' : ''}">
              <div class="hours-time-field">
                <label>Abertura</label>
                <input type="time" data-field="open_time" data-id="${h.id}"
                  value="${escapeHTML(h.open_time || '')}" ${isClosed ? 'disabled' : ''}>
              </div>
              <span class="hours-time-sep">—</span>
              <div class="hours-time-field">
                <label>Fechamento</label>
                <input type="time" data-field="close_time" data-id="${h.id}"
                  value="${escapeHTML(h.close_time || '')}" ${isClosed ? 'disabled' : ''}>
              </div>
            </div>
          </div>
        </div>`;
    } else {
      const noBreak = !h.break_start && !h.break_end;
      return `
        <div class="hours-card ${isClosed ? 'hours-card-closed' : ''}" data-id="${h.id}">
          <div class="hours-card-day">
            <span class="hours-day-full">${escapeHTML(dayName)}</span>
            <span class="hours-day-short">${escapeHTML(dayShort)}</span>
          </div>
          <div class="hours-card-body">
            <div class="hours-time-row ${isClosed ? 'is-disabled' : ''}">
              <div class="hours-time-field">
                <label>Início</label>
                <input type="time" data-field="break_start" data-id="${h.id}"
                  value="${escapeHTML(h.break_start || '')}" ${isClosed ? 'disabled' : ''}
                  placeholder="--:--">
              </div>
              <span class="hours-time-sep">—</span>
              <div class="hours-time-field">
                <label>Fim</label>
                <input type="time" data-field="break_end" data-id="${h.id}"
                  value="${escapeHTML(h.break_end || '')}" ${isClosed ? 'disabled' : ''}
                  placeholder="--:--">
              </div>
            </div>
            ${isClosed ? '' : `<p class="hours-break-hint">${noBreak ? 'Sem pausa configurada' : ''}</p>`}
          </div>
        </div>`;
    }
  }

  function render() {
    const el = $('#hours-cards');
    if (!items.length) {
      el.innerHTML = `<p class="empty-state">Nenhum horário configurado</p>`;
      return;
    }
    el.innerHTML = items.map(cardHtml).join('');
  }

  function activateSub(sub) {
    activeSub = sub;
    $$('.hours-subbtn').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
    render();
  }

  function init() {
    $('#hours-cards').addEventListener('change', e => {
      const input = e.target.closest('[data-field]');
      if (!input) return;
      const id = parseInt(input.dataset.id, 10);
      const field = input.dataset.field;
      let value;

      if (field === 'is_closed') {
        value = input.checked ? 1 : 0;
        const card = input.closest('.hours-card');
        card.classList.toggle('hours-card-closed', input.checked);
        $$('input[type="time"]', card).forEach(el => el.disabled = input.checked);
        $$('.hours-time-row', card).forEach(el => el.classList.toggle('is-disabled', input.checked));
        const item = items.find(h => h.id === id);
        if (item) item.is_closed = input.checked ? 1 : 0;
        const badge = card.querySelector('.hours-status-badge');
        if (badge) {
          badge.textContent = input.checked ? 'Fechado' : 'Aberto';
          badge.className = `hours-status-badge ${input.checked ? 'badge-closed' : 'badge-open'}`;
        }
        // When opening a previously-closed day with zeroed times, send default hours to avoid validation error
        if (!input.checked && item && (!item.open_time || item.open_time === '00:00') && (!item.close_time || item.close_time === '00:00')) {
          const defaultOpen = '09:00';
          const defaultClose = '19:00';
          item.open_time = defaultOpen;
          item.close_time = defaultClose;
          $$('input[type="time"]', card).forEach(el => {
            if (el.dataset.field === 'open_time') el.value = defaultOpen;
            if (el.dataset.field === 'close_time') el.value = defaultClose;
          });
          debounce(`hours-${id}-is_closed`, () => Api.patch(`/working-hours/${id}`, { is_closed: 0, open_time: defaultOpen, close_time: defaultClose }), 500);
          return;
        }
      } else if ((field === 'break_start' || field === 'break_end') && !input.value) {
        value = null;
      } else {
        value = input.value;
        const item = items.find(h => h.id === id);
        if (item) item[field] = value;
      }

      debounce(`hours-${id}-${field}`, () => saveField(id, field, value), 500);
    });

    $$('.hours-subbtn').forEach(btn => {
      btn.addEventListener('click', () => activateSub(btn.dataset.sub));
    });

    document.addEventListener('tab:activate', e => {
      if (e.detail.tab === 'hours') { renderSkeleton(); load(); }
    });
  }

  return { init, load, renderSkeleton };
})();

/* ============================================================
   BLOCKS
   ============================================================ */

const Blocks = (() => {
  let items = [];

  async function load() {
    renderSkeleton();
    try {
      items = await Api.get('/blocks');
      render();
    } catch (e) {
      Toast.error('Falha ao carregar bloqueios');
      console.error(e);
    }
  }

  function renderSkeleton() {
    const tbody = $('#blocks-tbody');
    tbody.innerHTML = Array(3).fill(0).map(() => `
      <tr>
        ${Array(4).fill('<td><div class="skel"></div></td>').join('')}
      </tr>`).join('');
  }

  function render() {
    const tbody = $('#blocks-tbody');
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-state">
        <div class="empty-state-rich">
          <div class="empty-title">Nenhum bloqueio ativo</div>
          <div class="empty-sub">Crie um bloqueio para indisponibilizar um período.</div>
        </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(b => {
      const start = new Date(b.starts_at);
      const end   = new Date(b.ends_at);
      return `
        <tr data-id="${b.id}" class="row-enter">
          <td class="num">${fmtDate(start)}</td>
          <td class="num">${fmtTime(start)} – ${fmtTime(end)}</td>
          <td>${escapeHTML(b.reason || '—')}</td>
          <td>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" data-action="delete-block" data-id="${b.id}">Remover</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  function openModal() {
    const form = $('#blockForm');
    form && form.reset();
    Form.clearAll(form);
    Modal.open('#blocks-modal');
  }

  function validate() {
    Form.clearAll($('#blockForm'));
    let ok = true;
    const startDate = $('#block-start-date').value;
    const startTime = $('#block-start-time').value;
    const endDate   = $('#block-end-date').value;
    const endTime   = $('#block-end-time').value;

    if (!startDate || !startTime) { Form.setError('block-start-date', 'Data/hora obrigatória'); ok = false; }
    if (!endDate   || !endTime)   { Form.setError('block-end-date',   'Data/hora obrigatória'); ok = false; }
    if (ok) {
      const s = new Date(`${startDate}T${startTime}`);
      const e = new Date(`${endDate}T${endTime}`);
      if (e <= s) { Form.setError('block-dates', 'Fim deve ser após o início'); ok = false; }
    }
    if (!ok) return null;
    return {
      starts_at: `${startDate}T${startTime}:00-03:00`,
      ends_at:   `${endDate}T${endTime}:00-03:00`,
      reason: $('#block-reason').value.trim() || undefined,
    };
  }

  async function create(e) {
    e.preventDefault();
    const data = validate();
    if (!data) return;

    const btn = $('#block-create');
    Button.setLoading(btn, true);
    try {
      const created = await Api.post('/blocks', data);
      items.push(created);
      items.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      render();
      Modal.close('#blocks-modal');
      UndoStack.push({
        label: 'Bloqueio criado',
        undo: async () => {
          await Api.delete(`/blocks/${created.id}`);
          items = items.filter(b => b.id !== created.id);
          render();
        }
      });
    } catch (err) {
      Toast.error(err.message || 'Falha ao criar bloqueio');
    } finally {
      Button.setLoading(btn, false);
    }
  }

  async function remove(id) {
    const idx = items.findIndex(b => b.id === id);
    if (idx === -1) return;
    const removed = items[idx];
    items.splice(idx, 1);
    render();
    try {
      await Api.delete(`/blocks/${id}`);
      UndoStack.push({
        label: 'Bloqueio removido',
        undo: async () => {
          const restored = await Api.post('/blocks', {
            starts_at: removed.starts_at,
            ends_at:   removed.ends_at,
            reason:    removed.reason,
          });
          items.splice(idx, 0, restored);
          render();
        }
      });
    } catch (err) {
      items.splice(idx, 0, removed);
      render();
      Toast.error('Falha ao remover bloqueio');
    }
  }

  function init() {
    $('#block-add').addEventListener('click', openModal);
    $('#block-cancel').addEventListener('click', () => Modal.close('#blocks-modal'));
    $('#blockForm').addEventListener('submit', create);

    $('#blocks-tbody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = parseInt(btn.dataset.id, 10);
      if (btn.dataset.action === 'delete-block') {
        InlineConfirm.show(btn.closest('td'), {
          message: 'Remover bloqueio?',
          onConfirm: () => remove(id)
        });
      }
    });

    document.addEventListener('tab:activate', e => {
      if (e.detail.tab === 'blocks') { renderSkeleton(); load(); }
    });
  }

  return { init, load, renderSkeleton };
})();

/* ============================================================
   ESCALATIONS
   ============================================================ */

const Escalations = (() => {
  let items = [];

  async function load() {
    renderSkeleton();
    try {
      items = await Api.get('/escalations');
      render();
    } catch (e) {
      Toast.error('Falha ao carregar escalações');
      console.error(e);
    }
  }

  function renderSkeleton() {
    const tbody = $('#escalations-tbody');
    tbody.innerHTML = Array(3).fill(0).map(() => `
      <tr>
        ${Array(5).fill('<td><div class="skel"></div></td>').join('')}
      </tr>`).join('');
  }

  function render() {
    const tbody = $('#escalations-tbody');
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">
        <div class="empty-state-rich">
          <div class="empty-title">Nenhuma escalação pendente</div>
          <div class="empty-sub">Tudo em ordem por enquanto.</div>
        </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(e => {
      const dt = e.starts_at ? new Date(e.starts_at) : null;
      return `
        <tr data-id="${e.id}" class="row-enter">
          <td>
            <div class="cell-main">${escapeHTML(e.client_name || '—')}</div>
            <div class="cell-sub">${escapeHTML(e.client_phone || '')}</div>
          </td>
          <td>${escapeHTML(e.service_name || '—')}</td>
          <td class="num">${dt ? `${fmtDate(dt)} ${fmtTime(dt)}` : '—'}</td>
          <td>${escapeHTML(e.notes || '—')}</td>
          <td>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" data-action="resolve-esc" data-id="${e.id}" data-action-type="approve">Aprovar</button>
              <button class="btn btn-ghost btn-sm" data-action="resolve-esc" data-id="${e.id}" data-action-type="deny">Negar</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  async function resolve(id, action) {
    const idx = items.findIndex(e => e.id === id);
    if (idx === -1) return;
    const prev = items[idx];
    items.splice(idx, 1);
    render();
    try {
      await Api.patch(`/escalations/${id}`, { action });
      Toast.success(`Escalação ${action === 'approve' ? 'aprovada' : 'negada'}`);
      UndoStack.push({
        label: `Escalação ${action === 'approve' ? 'aprovada' : 'negada'}`,
        undo: async () => {
          items.splice(idx, 0, prev);
          render();
          Toast.show('Revertido localmente — não é possível desfazer no servidor', { duration: 4000 });
        }
      });
    } catch (err) {
      items.splice(idx, 0, prev);
      render();
      Toast.error('Falha ao resolver escalação');
    }
  }

  function init() {
    $('#escalations-tbody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.dataset.action !== 'resolve-esc') return;
      const id = parseInt(btn.dataset.id, 10);
      const actionType = btn.dataset.actionType;
      InlineConfirm.show(btn.closest('td'), {
        message: `${actionType === 'approve' ? 'Aprovar' : 'Negar'} escalação?`,
        onConfirm: () => resolve(id, actionType)
      });
    });

    document.addEventListener('tab:activate', e => {
      if (e.detail.tab === 'escalations') { renderSkeleton(); load(); }
    });
  }

  return { init, load, renderSkeleton };
})();

/* ============================================================
   APP — orquestração
   ============================================================ */

const App = {
  boot() {
    Tabs.activate('agenda');
    Agenda.load();
  },

  async clearCustomerData() {
    const ok = await Modal.confirm({
      title: 'Limpar dados de clientes',
      message: 'Isso apaga clientes, conversas, mensagens processadas e agendamentos. Servicos, horarios e bloqueios serao mantidos.',
      confirmLabel: 'Limpar dados',
      cancelLabel: 'Cancelar',
      danger: true
    });
    if (!ok) return;

    const btn = $('#clear-customer-data');
    Button.setLoading(btn, true);
    try {
      const result = await Api.delete('/customer-data');
      UndoStack.clear();
      await Agenda.load();
      const deleted = result && result.deleted ? result.deleted : {};
      const total = Object.values(deleted).reduce((sum, n) => sum + Number(n || 0), 0);
      Toast.success(`Dados limpos (${total} registros)`);
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      Toast.error(err.message || 'Falha ao limpar dados');
      console.error(err);
    } finally {
      Button.setLoading(btn, false);
    }
  }
};

/* ============================================================
   BOOT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
  /* ── History ──────────────────────────────────────────────────────────────── */
  const History = (() => {
    let currentStatus = '';

    const STATUS_LABEL = {
      confirmed: { text: 'Confirmado', cls: 'badge-confirmed' },
      completed: { text: 'Concluido',  cls: 'badge-completed' },
      cancelled: { text: 'Cancelado',  cls: 'badge-cancelled' },
      no_show:   { text: 'Falta',      cls: 'badge-noshow'    },
    };

    function renderSkeleton() {
      $('#history-tbody').innerHTML = Array(5).fill(0).map(() =>
        `<tr>${Array(4).fill('<td><div class="skel"></div></td>').join('')}</tr>`
      ).join('');
    }

    async function load() {
      renderSkeleton();
      try {
        const qs = currentStatus ? `?status=${currentStatus}` : '';
        const rows = await Api.get(`/history${qs}`);
        render(rows);
      } catch {
        Toast.error('Falha ao carregar histórico');
      }
    }

    function render(rows) {
      const tbody = $('#history-tbody');
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Nenhum agendamento encontrado.</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map(r => {
        const dt = r.starts_at ? new Date(r.starts_at) : null;
        const s = STATUS_LABEL[r.status] ?? { text: r.status, cls: '' };
        return `<tr>
          <td>
            <div class="cell-main">${escapeHTML(r.client_name || '—')}</div>
            <div class="cell-sub">${escapeHTML(r.client_phone || '')}</div>
          </td>
          <td>${escapeHTML(r.service_name || '—')}</td>
          <td class="num">${dt ? `${fmtDate(dt)} ${fmtTime(dt)}` : '—'}</td>
          <td><span class="badge ${s.cls}">${s.text}</span></td>
        </tr>`;
      }).join('');
    }

    function init() {
      $$('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          $$('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentStatus = btn.dataset.status;
          load();
        });
      });

      document.addEventListener('tab:activate', e => {
        if (e.detail.tab === 'history') load();
      });
    }

    return { init };
  })();

  Tabs.init();
  Shortcuts.init();
  Services.init();
  Agenda.init();
  Hours.init();
  Blocks.init();
  Escalations.init();
  History.init();
  $('#clear-customer-data').addEventListener('click', () => App.clearCustomerData());

  Shortcuts.register('mod+z', () => UndoStack.pop());
  Shortcuts.register('escape', () => {
    $$('.modal').forEach(m => { if (!m.hidden) Modal.close(m); });
  });

  ['agenda','services','hours','blocks','escalations','history'].forEach((tab, i) => {
    Shortcuts.register((i+1).toString(), () => Tabs.activate(tab));
  });

  if (Api.getToken()) App.boot();

  console.log('%cStudio Lash Admin', 'color:#2A5BD7;font-weight:500');
});
