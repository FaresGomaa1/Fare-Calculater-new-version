/*
 * README — Fare Calculator (حاسبة الأجرة)
 * ------------------------------------------------------------------
 * Front-end only. No build step. Everything lives in one IIFE (no globals).
 *
 * Structure (top to bottom):
 *   1. CONFIG & DOM      constants, element lookups
 *   2. STATE & STORAGE   in-memory state, localStorage load/save
 *   3. CALCULATE         pure money maths + status + summary totals
 *   4. FORMAT            digits (Arabic/English), money, date/time
 *   5. RENDER            table rows (via <template>), summary, preview, UI
 *   6. FEEDBACK          toasts (with undo), sound / vibration
 *   7. ACTIONS           add / edit / delete / clear / toggle done / undo
 *   8. EXPORT & PRINT    CSV (UTF-8 BOM) and print view
 *   9. EVENTS            all listeners are wired in one place
 *  10. INIT              boot sequence + service-worker registration
 *
 * Money rules
 *   required  = fare × people
 *   change    = paid − required        (>0 owed back, 0 exact, <0 shortage)
 *   collected = min(paid, required)    (what the fare actually brought in)
 *   remaining = sum of positive change on rows NOT yet marked "تم"
 *
 * Security: user-provided values are only ever written with textContent /
 * value / dataset — never innerHTML.
 */
(function () {
  'use strict';

  /* =================================================================
   * 1. CONFIG & DOM
   * ================================================================= */
  const STORAGE_KEY = 'fareCalc:v1';
  const DEFAULT_CURRENCY = 'ج.م';
  const UNDO_MS = 8000;
  const MAX_OPS = 2000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = {
    html: document.documentElement,
    form: $('#fareForm'),
    fare: $('#fare'),
    total: $('#total'),
    people: $('#people'),
    errors: { fare: $('#fareError'), total: $('#totalError'), people: $('#peopleError') },
    peopleMinus: $('#peopleMinus'),
    peoplePlus: $('#peoplePlus'),
    quick: $('#quickAmounts'),
    previewRequired: $('#previewRequired'),
    previewChange: $('#previewChange'),
    submitBtn: $('#submitBtn'),
    submitIcon: $('#submitIcon'),
    submitLabel: $('#submitLabel'),
    cancelEdit: $('#cancelEditBtn'),
    clearBtn: $('#clearBtn'),
    clearModal: $('#clearModal'),
    clearCount: $('#clearCount'),
    confirmClear: $('#confirmClear'),
    body: $('#opsBody'),
    tableWrap: $('#tableWrap'),
    empty: $('#emptyState'),
    emptyText: $('#emptyText'),
    footPeople: $('#footPeople'),
    footChange: $('#footChange'),
    rowTpl: $('#rowTemplate'),
    toastTpl: $('#toastTemplate'),
    toastHost: $('#toastHost'),
    themeToggle: $('#themeToggle'),
    themeIcon: $('#themeIcon'),
    soundToggle: $('#soundToggle'),
    soundIcon: $('#soundIcon'),
    exportBtn: $('#exportBtn'),
    printBtn: $('#printBtn'),
    printStamp: $('#printStamp'),
    currencyInput: $('#currencyInput'),
    themeMeta: $('meta[name="theme-color"]'),
    summary: $$('[data-summary]'),
  };

  /* =================================================================
   * 2. STATE & STORAGE
   * ================================================================= */
  const state = {
    ops: [],            // [{id, fare, people, paid, done, ts}]
    fare: '',           // last fare value (kept between operations)
    theme: 'auto',      // 'auto' | 'light' | 'dark'
    muted: false,
    digits: 'en',       // 'en' | 'ar'
    currency: DEFAULT_CURRENCY,
    filter: 'all',      // 'all' | 'open' | 'done'
    editingId: null,
  };

  let undoSnapshot = null;   // copy of ops before last delete / clear
  let undoTimer = null;
  const shown = {};          // last displayed summary values (for count-up)

  const Storage = {
    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return;
        if (Array.isArray(raw.ops)) state.ops = raw.ops.filter(isValidOp).slice(0, MAX_OPS);
        if (typeof raw.fare === 'string' || typeof raw.fare === 'number') state.fare = String(raw.fare);
        if (['auto', 'light', 'dark'].includes(raw.theme)) state.theme = raw.theme;
        if (typeof raw.muted === 'boolean') state.muted = raw.muted;
        if (['en', 'ar'].includes(raw.digits)) state.digits = raw.digits;
        if (typeof raw.currency === 'string' && raw.currency.trim()) state.currency = raw.currency.trim().slice(0, 10);
        if (['all', 'open', 'done'].includes(raw.filter)) state.filter = raw.filter;
      } catch (e) { /* corrupted or blocked storage: start fresh */ }
    },
    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          ops: state.ops, fare: state.fare, theme: state.theme, muted: state.muted,
          digits: state.digits, currency: state.currency, filter: state.filter,
        }));
      } catch (e) { /* storage full / private mode: ignore */ }
    },
  };

  function isValidOp(o) {
    return o && typeof o.id === 'string' && Number.isFinite(o.fare) && Number.isFinite(o.paid)
      && Number.isInteger(o.people) && o.people >= 1 && typeof o.ts === 'string';
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* =================================================================
   * 3. CALCULATE
   * ================================================================= */
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  function calcOp(op) {
    const required = round2(op.fare * op.people);
    const change = round2(op.paid - required);
    const status = change > 0 ? 'owed' : change === 0 ? 'paid' : 'short';
    return { required, change, status, collected: Math.min(op.paid, required) };
  }

  function calcSummary(ops) {
    const s = { entries: ops.length, people: 0, remaining: 0, required: 0, collected: 0 };
    for (const op of ops) {
      const c = calcOp(op);
      s.people += op.people;
      s.required += c.required;
      s.collected += c.collected;
      if (!op.done && c.change > 0) s.remaining += c.change;
    }
    s.required = round2(s.required);
    s.collected = round2(s.collected);
    s.remaining = round2(s.remaining);
    return s;
  }

  const visibleOps = () => state.ops.filter((o) =>
    state.filter === 'all' ? true : state.filter === 'done' ? o.done : !o.done);

  /* =================================================================
   * 4. FORMAT
   * ================================================================= */
  const locale = () => (state.digits === 'ar' ? 'ar-EG' : 'en-US');
  const nf = () => new Intl.NumberFormat(locale(), { maximumFractionDigits: 2, useGrouping: true });
  const fmtNum = (n) => nf().format(n);
  const fmtMoney = (n) => `${fmtNum(n)} ${state.currency}`;
  const fmtSigned = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtMoney(Math.abs(n));

  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(state.digits === 'ar' ? 'ar-EG' : 'en-GB', {
      dateStyle: 'short', timeStyle: 'short',
    }).format(d);
  }

  const STATUS = {
    owed: { text: 'باقي للراجع', icon: 'fa-arrow-rotate-left', cls: 'is-owed' },
    paid: { text: 'مدفوع بالكامل', icon: 'fa-circle-check', cls: 'is-paid' },
    short: { text: 'ناقص', icon: 'fa-circle-exclamation', cls: 'is-short' },
  };

  /* =================================================================
   * 5. RENDER
   * ================================================================= */
  function buildRow(op) {
    const c = calcOp(op);
    const row = el.rowTpl.content.firstElementChild.cloneNode(true);
    row.dataset.id = op.id;
    row.classList.toggle('is-done', !!op.done);
    row.classList.toggle('is-editing', op.id === state.editingId);

    const paid = $('.op-paid', row);
    paid.value = String(op.paid);
    paid.textContent = fmtMoney(op.paid);

    $('.op-detail', row).textContent =
      `${fmtNum(op.fare)} × ${fmtNum(op.people)} = ${fmtMoney(c.required)}`;

    const time = $('.op-time', row);
    time.dateTime = op.ts;
    time.textContent = fmtDateTime(op.ts);

    const ppl = $('.op-people', row);
    ppl.value = String(op.people);
    ppl.textContent = fmtNum(op.people);

    const chg = $('.op-change', row);
    chg.value = String(c.change);
    chg.textContent = c.status === 'paid' ? fmtMoney(0) : fmtMoney(Math.abs(c.change));
    if (c.status === 'short') chg.textContent = `− ${chg.textContent}`;

    const st = STATUS[c.status];
    const badge = $('.op-status', row);
    badge.classList.add(st.cls);
    $('.op-status-icon', row).classList.add(st.icon);
    $('.op-status-text', row).textContent = st.text;

    // "تم؟" switch — unique id so the label is bound natively.
    const cb = $('.op-done', row);
    const lbl = $('.op-done-label', row);
    cb.id = `done-${op.id}`;
    cb.checked = !!op.done;
    lbl.htmlFor = cb.id;
    lbl.textContent = op.done ? 'تم' : 'لم يتم';

    // Mobile card labels (CSS ::before reads data-label).
    const labels = ['الأشخاص', 'الباقي', 'الحالة', 'تم؟'];
    $$('td', row).slice(0, 4).forEach((td, i) => { td.dataset.label = labels[i]; });

    // Strike through the text of settled rows with <del>.
    if (op.done) {
      [paid, ppl, chg].forEach((node) => {
        const del = document.createElement('del');
        del.textContent = node.textContent;
        node.textContent = '';
        node.appendChild(del);
      });
    }

    // Accessible names for icon-only buttons.
    const summaryText = `عملية ${fmtMoney(op.paid)} لـ ${fmtNum(op.people)} أشخاص`;
    const edit = $('[data-action="edit"]', row);
    const del = $('[data-action="delete"]', row);
    edit.setAttribute('aria-label', `تعديل ${summaryText}`);
    del.setAttribute('aria-label', `حذف ${summaryText}`);
    edit.title = 'تعديل';
    del.title = 'حذف';
    return row;
  }

  function renderTable() {
    const list = visibleOps();
    el.body.replaceChildren(...list.map(buildRow));

    const hasAny = state.ops.length > 0;
    el.tableWrap.hidden = list.length === 0;
    el.empty.hidden = list.length !== 0;
    el.emptyText.textContent = hasAny ? 'لا توجد عمليات في هذا التصفية' : 'لم تُسجل عمليات بعد';

    const people = list.reduce((n, o) => n + o.people, 0);
    const change = round2(list.reduce((n, o) => n + calcOp(o).change, 0));
    el.footPeople.value = String(people);
    el.footPeople.textContent = fmtNum(people);
    el.footChange.value = String(change);
    el.footChange.textContent = fmtSigned(change);
  }

  /** Animated count-up; jumps straight to the value if motion is reduced. */
  function setSummaryValue(node, target) {
    const kind = node.dataset.kind;
    const key = node.dataset.summary;
    const render = (n) => { node.textContent = kind === 'money' ? fmtMoney(n) : fmtNum(Math.round(n)); };
    const from = shown[key] ?? 0;
    shown[key] = target;
    node.value = String(target);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from === target) { render(target); return; }

    const start = performance.now();
    const dur = 600;
    cancelAnimationFrame(node._raf);
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      render(from + (target - from) * eased);
      if (t < 1) node._raf = requestAnimationFrame(tick);
      else render(target);
    };
    node._raf = requestAnimationFrame(tick);
  }

  function renderSummary() {
    const s = calcSummary(state.ops);
    el.summary.forEach((node) => setSummaryValue(node, s[node.dataset.summary]));
  }

  function renderPreview() {
    const fare = parseFloat(el.fare.value);
    const total = parseFloat(el.total.value);
    const people = parseInt(el.people.value, 10);
    const out = el.previewChange;
    out.classList.remove('is-pos', 'is-neg');

    const okFare = Number.isFinite(fare) && fare >= 0;
    const okPeople = Number.isInteger(people) && people >= 1;
    el.previewRequired.textContent = okFare && okPeople ? fmtMoney(round2(fare * people)) : '—';

    if (okFare && okPeople && Number.isFinite(total)) {
      const change = round2(total - fare * people);
      out.textContent = change === 0 ? `${fmtMoney(0)} — مدفوع بالكامل`
        : change > 0 ? `${fmtMoney(change)} — باقي للراجع`
        : `${fmtMoney(Math.abs(change))} — ناقص`;
      out.classList.add(change < 0 ? 'is-neg' : 'is-pos');
    } else {
      out.textContent = '—';
    }
  }

  function renderStatic() {
    $$('[data-currency]').forEach((n) => { n.textContent = state.currency; });
    $$('[data-amount]', el.quick).forEach((b) => {
      b.textContent = fmtNum(Number(b.dataset.amount));
      b.setAttribute('aria-label', `تعبئة المبلغ ${fmtMoney(Number(b.dataset.amount))}`);
    });
    el.clearBtn.disabled = state.ops.length === 0;
    $(`input[name="digits"][value="${state.digits}"]`).checked = true;
    $(`input[name="filter"][value="${state.filter}"]`).checked = true;
    el.currencyInput.value = state.currency;
    renderSound();
    renderTheme();
  }

  function renderEditMode() {
    const editing = state.editingId !== null;
    el.submitLabel.textContent = editing ? 'حفظ التعديل' : 'إضافة';
    el.submitIcon.className = `fa-solid ${editing ? 'fa-floppy-disk' : 'fa-plus'}`;
    el.cancelEdit.hidden = !editing;
  }

  function renderAll() {
    renderStatic();
    renderEditMode();
    renderTable();
    renderSummary();
    renderPreview();
  }

  /* ---------- Theme & sound toggles ---------- */
  const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = () => state.theme === 'dark' || (state.theme === 'auto' && prefersDark());

  function renderTheme() {
    const dark = isDark();
    el.html.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    el.themeIcon.className = `fa-solid ${dark ? 'fa-sun' : 'fa-moon'}`;
    el.themeToggle.setAttribute('aria-label', dark ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن');
    el.themeToggle.setAttribute('aria-pressed', String(dark));
    if (el.themeMeta) el.themeMeta.setAttribute('content', dark ? '#0f141b' : '#0d6efd');
  }

  function renderSound() {
    el.soundIcon.className = `fa-solid ${state.muted ? 'fa-volume-xmark' : 'fa-volume-high'}`;
    el.soundToggle.setAttribute('aria-label', state.muted ? 'تشغيل الصوت والاهتزاز' : 'كتم الصوت والاهتزاز');
    el.soundToggle.setAttribute('aria-pressed', String(!state.muted));
  }

  /* ---------- Validation UI ---------- */
  function setError(field, message) {
    const input = el[field];
    const box = el.errors[field];
    const help = $(`#${field}Help`);
    input.classList.toggle('is-invalid', !!message);
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      box.textContent = message;
      box.classList.add('d-block');
      input.setAttribute('aria-describedby', `${help.id} ${box.id}`);
    } else {
      input.removeAttribute('aria-invalid');
      box.textContent = '';
      box.classList.remove('d-block');
      input.setAttribute('aria-describedby', help.id);
    }
  }

  function clearErrors() { ['fare', 'total', 'people'].forEach((f) => setError(f, '')); }

  /** Returns {ok, values}. Focuses the first invalid field. */
  function validate() {
    const fareRaw = el.fare.value.trim();
    const totalRaw = el.total.value.trim();
    const peopleRaw = el.people.value.trim();
    const fare = Number(fareRaw);
    const total = Number(totalRaw);
    const people = Number(peopleRaw);
    const errs = {};

    if (fareRaw === '' || !Number.isFinite(fare)) errs.fare = 'أدخل قيمة الأجرة للفرد.';
    else if (fare < 0) errs.fare = 'لا يمكن أن تكون الأجرة سالبة.';
    else if (fare === 0) errs.fare = 'يجب أن تكون الأجرة أكبر من صفر.';

    if (totalRaw === '' || !Number.isFinite(total)) errs.total = 'أدخل المبلغ الإجمالي.';
    else if (total < 0) errs.total = 'لا يمكن أن يكون المبلغ سالبًا.';

    if (peopleRaw === '' || !Number.isFinite(people)) errs.people = 'أدخل عدد الأشخاص.';
    else if (!Number.isInteger(people)) errs.people = 'عدد الأشخاص يجب أن يكون رقمًا صحيحًا.';
    else if (people < 1) errs.people = 'عدد الأشخاص يجب ألا يقل عن 1.';

    ['fare', 'total', 'people'].forEach((f) => setError(f, errs[f] || ''));
    const first = ['fare', 'total', 'people'].find((f) => errs[f]);
    if (first) el[first].focus();
    return { ok: !first, values: { fare, total, people } };
  }

  /* =================================================================
   * 6. FEEDBACK (toast, sound)
   * ================================================================= */
  function showToast(message, { actionLabel, onAction, delay = 4000 } = {}) {
    const node = el.toastTpl.content.firstElementChild.cloneNode(true);
    $('.toast-body', node).textContent = message;
    const btn = $('.toast-action', node);
    if (onAction) {
      btn.hidden = false;
      $('.toast-action-label', node).textContent = actionLabel || 'تراجع';
    }
    el.toastHost.appendChild(node);
    const toast = bootstrap.Toast.getOrCreateInstance(node, { delay, autohide: true });
    btn.addEventListener('click', () => { onAction(); toast.hide(); });
    node.addEventListener('hidden.bs.toast', () => node.remove());
    toast.show();
    return toast;
  }

  let audioCtx = null;
  function feedback() {
    if (state.muted) return;
    if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* ignore */ } }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.13);
    } catch (e) { /* audio blocked: ignore */ }
  }

  /* =================================================================
   * 7. ACTIONS
   * ================================================================= */
  function commit() {
    Storage.save();
    renderStatic();
    renderTable();
    renderSummary();
    renderPreview();
  }

  function resetEntryFields() {
    el.total.value = '';
    el.people.value = '1';
    clearErrors();
    renderPreview();
  }

  function handleSubmit(ev) {
    ev.preventDefault();
    const { ok, values } = validate();
    if (!ok) return;

    state.fare = String(values.fare);

    if (state.editingId) {
      const op = state.ops.find((o) => o.id === state.editingId);
      if (op) {
        op.fare = values.fare;
        op.paid = values.total;
        op.people = values.people;
      }
      state.editingId = null;
      renderEditMode();
      showToast('تم حفظ التعديل');
    } else {
      state.ops.unshift({
        id: uid(), fare: values.fare, paid: values.total,
        people: values.people, done: false, ts: new Date().toISOString(),
      });
      if (state.ops.length > MAX_OPS) state.ops.length = MAX_OPS;
      feedback();
    }

    commit();
    resetEntryFields();
    el.total.focus();
  }

  function startEdit(id) {
    const op = state.ops.find((o) => o.id === id);
    if (!op) return;
    state.editingId = id;
    el.fare.value = String(op.fare);
    el.total.value = String(op.paid);
    el.people.value = String(op.people);
    clearErrors();
    renderEditMode();
    renderTable();
    renderPreview();
    el.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.total.focus();
  }

  function cancelEdit() {
    state.editingId = null;
    el.fare.value = state.fare;
    resetEntryFields();
    renderEditMode();
    renderTable();
    el.total.focus();
  }

  function toggleDone(id, checked) {
    const op = state.ops.find((o) => o.id === id);
    if (!op) return;
    op.done = checked;
    commit();
    // Keep keyboard focus on the same switch after the table re-renders.
    const again = $(`#done-${CSS.escape(id)}`);
    if (again) again.focus();
  }

  function offerUndo(message) {
    clearTimeout(undoTimer);
    const snapshot = undoSnapshot;
    undoTimer = setTimeout(() => { undoSnapshot = null; }, UNDO_MS);
    showToast(message, {
      actionLabel: 'تراجع', delay: UNDO_MS,
      onAction: () => {
        if (!snapshot) return;
        state.ops = snapshot;
        undoSnapshot = null;
        commit();
        showToast('تمت استعادة العمليات');
      },
    });
  }

  function deleteOp(id) {
    const idx = state.ops.findIndex((o) => o.id === id);
    if (idx === -1) return;
    undoSnapshot = state.ops.map((o) => ({ ...o }));
    state.ops.splice(idx, 1);
    if (state.editingId === id) { state.editingId = null; resetEntryFields(); renderEditMode(); }
    commit();
    offerUndo('تم حذف العملية');
    el.fare.focus({ preventScroll: true });
  }

  function clearAll() {
    if (!state.ops.length) return;
    undoSnapshot = state.ops.map((o) => ({ ...o }));
    state.ops = [];
    state.editingId = null;
    resetEntryFields();
    renderEditMode();
    commit();
    offerUndo('تم مسح كل العمليات');
  }

  function stepPeople(delta) {
    const cur = parseInt(el.people.value, 10);
    const next = Math.max(1, (Number.isFinite(cur) ? cur : 0) + delta);
    el.people.value = String(next);
    setError('people', '');
    renderPreview();
  }

  /* =================================================================
   * 8. EXPORT & PRINT
   * ================================================================= */
  const csvCell = (v) => {
    let s = String(v ?? '');
    // Neutralise spreadsheet formula injection for text cells.
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function exportCsv() {
    if (!state.ops.length) { showToast('لا توجد عمليات للتصدير'); return; }
    const rows = [[
      'الوقت', 'الأجرة للفرد', 'عدد الأشخاص', 'المطلوب', 'المدفوع', 'الباقي', 'الحالة', 'تم؟',
    ]];
    const list = visibleOps();
    for (const op of list.slice().reverse()) {
      const c = calcOp(op);
      rows.push([
        op.ts, op.fare, op.people, c.required, op.paid, c.change,
        STATUS[c.status].text, op.done ? 'نعم' : 'لا',
      ]);
    }
    const s = calcSummary(state.ops);
    rows.push([], ['ملخص العمليات'],
      ['عدد الإدخالات', s.entries],
      ['عدد الأشخاص الذين تم التحصيل منهم', s.people],
      ['إجمالي المبالغ المتبقية', s.remaining],
      ['إجمالي المال المطلوب', s.required],
      ['إجمالي المال المحصّل', s.collected],
      ['العملة', state.currency]);

    const csv = '' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fare-calculator-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('تم تصدير الملف');
  }

  function printView() {
    el.printStamp.textContent = `تاريخ الطباعة: ${fmtDateTime(new Date().toISOString())}`;
    window.print();
  }

  /* =================================================================
   * 9. EVENTS
   * ================================================================= */
  function bindEvents() {
    el.form.addEventListener('submit', handleSubmit);
    el.cancelEdit.addEventListener('click', cancelEdit);

    // Live preview + remember fare + clear error on input.
    ['fare', 'total', 'people'].forEach((f) => {
      el[f].addEventListener('input', () => {
        if (el[f].classList.contains('is-invalid')) setError(f, '');
        if (f === 'fare') { state.fare = el.fare.value; Storage.save(); }
        renderPreview();
      });
    });

    el.peopleMinus.addEventListener('click', () => stepPeople(-1));
    el.peoplePlus.addEventListener('click', () => stepPeople(1));

    el.quick.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-amount]');
      if (!btn) return;
      el.total.value = btn.dataset.amount;
      setError('total', '');
      renderPreview();
      el.total.focus();
    });

    // Table: delegated actions.
    el.body.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.closest('tr').dataset.id;
      if (btn.dataset.action === 'edit') startEdit(id);
      if (btn.dataset.action === 'delete') deleteOp(id);
    });
    el.body.addEventListener('change', (ev) => {
      if (!ev.target.classList.contains('op-done')) return;
      toggleDone(ev.target.closest('tr').dataset.id, ev.target.checked);
    });

    // Filter.
    $$('input[name="filter"]').forEach((r) => r.addEventListener('change', () => {
      if (!r.checked) return;
      state.filter = r.value;
      Storage.save();
      renderTable();
    }));

    // Clear all (confirmation modal).
    el.clearModal.addEventListener('show.bs.modal', () => {
      el.clearCount.textContent = fmtNum(state.ops.length);
    });
    el.confirmClear.addEventListener('click', () => {
      bootstrap.Modal.getOrCreateInstance(el.clearModal).hide();
      clearAll();
      el.fare.focus({ preventScroll: true });
    });

    // Theme.
    el.themeToggle.addEventListener('click', () => {
      state.theme = isDark() ? 'light' : 'dark';
      Storage.save();
      renderTheme();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'auto') renderTheme();
    });

    // Sound.
    el.soundToggle.addEventListener('click', () => {
      state.muted = !state.muted;
      Storage.save();
      renderSound();
      if (!state.muted) feedback();
    });

    // Settings: digits + currency.
    $$('input[name="digits"]').forEach((r) => r.addEventListener('change', () => {
      if (!r.checked) return;
      state.digits = r.value;
      Storage.save();
      Object.keys(shown).forEach((k) => { shown[k] = undefined; });
      renderAll();
    }));
    el.currencyInput.addEventListener('input', () => {
      state.currency = el.currencyInput.value.trim() || DEFAULT_CURRENCY;
      Storage.save();
      renderAll();
    });
    el.currencyInput.addEventListener('blur', () => {
      el.currencyInput.value = state.currency;
    });

    // Export / print.
    el.exportBtn.addEventListener('click', exportCsv);
    el.printBtn.addEventListener('click', printView);

    // Cross-tab sync.
    window.addEventListener('storage', (ev) => {
      if (ev.key !== STORAGE_KEY) return;
      Storage.load();
      renderAll();
    });
  }

  /* =================================================================
   * 10. INIT
   * ================================================================= */
  function init() {
    Storage.load();
    el.fare.value = state.fare;
    el.people.value = '1';
    bindEvents();
    renderAll();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
