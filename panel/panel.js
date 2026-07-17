// ============================================================
// panel.js — منطق لوحة التحكم
// تتواصل مع سكربت المحتوى عبر postMessage، وتقرأ حالة المهام
// والنتائج مباشرة من chrome.storage.
// ============================================================
(function () {
'use strict';

const token = (location.hash.match(/t=([^&]+)/) || [])[1] || '';
const $ = (id) => document.getElementById(id);

// ---------- إرسال طلب لسكربت المحتوى ----------
let reqSeq = 0;
const pending = new Map();

function toContent(type, payload) {
  return new Promise((resolve) => {
    const reqId = ++reqSeq;
    pending.set(reqId, resolve);
    window.parent.postMessage(Object.assign({ src: 'WS_PANEL', token, type, reqId }, payload || {}), '*');
    // مهلة أمان
    setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); resolve(null); } }, 15000);
  });
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.src !== 'WS_CONTENT' || d.token !== token) return;

  if (d.reqId && pending.has(d.reqId)) {
    pending.get(d.reqId)(d);
    pending.delete(d.reqId);
  }

  if (d.type === 'jobEvent') {
    const ev = d.detail || {};
    if (ev.event === 'progress' || ev.event === 'done' || ev.event === 'stopped') {
      refreshStatus();
      refreshPreview();
    }
  }
  if (d.type === 'picked') {
    toast(`تم الالتقاط: ${d.count} عنصرًا مطابقًا`);
  }
});

// ---------- أدوات عامة ----------
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => t.classList.remove('show'), ms);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- التبويبات ----------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tabpage').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'data') { refreshStatus(); refreshPreview(); }
    if (btn.dataset.tab === 'projects') renderProjects();
  });
});

$('btnClose').addEventListener('click', () => toContent('closePanel'));

// ============================================================
// إدارة الحقول
// ============================================================
let fieldSeq = 0;

function addFieldCard(field) {
  field = field || { name: '', selector: '', type: 'text', multiple: false, attr: '' };
  const id = ++fieldSeq;
  const card = document.createElement('div');
  card.className = 'field-card' + (field.type === 'attribute' ? ' show-attr' : '');
  card.dataset.fid = id;
  card.innerHTML = `
    <div class="frow">
      <input type="text" class="fname" placeholder="اسم الحقل" value="${esc(field.name)}">
      <select class="ftype">
        <option value="text">نص</option>
        <option value="link">رابط</option>
        <option value="image">صورة</option>
        <option value="attribute">سمة</option>
        <option value="html">HTML</option>
      </select>
      <input type="text" class="fattr" dir="ltr" placeholder="href / data-id" value="${esc(field.attr || '')}">
    </div>
    <div class="frow">
      <input type="text" class="fsel" dir="ltr" placeholder=".selector" value="${esc(field.selector)}">
      <span class="field-count" title="عدد العناصر المطابقة"></span>
      <button class="btn pick small f-pick" title="التقاط">🎯</button>
      <button class="btn ghost small f-prev" title="معاينة">👁</button>
      <button class="btn ghost small f-del" title="حذف">🗑</button>
    </div>
    <label class="mini-check"><input type="checkbox" class="fmult" ${field.multiple ? 'checked' : ''}> عناصر متعددة داخل الصف (تُدمج بفاصل | )</label>
  `;
  card.querySelector('.ftype').value = field.type || 'text';

  card.querySelector('.ftype').addEventListener('change', (ev) => {
    card.classList.toggle('show-attr', ev.target.value === 'attribute');
  });
  card.querySelector('.f-del').addEventListener('click', () => card.remove());
  card.querySelector('.f-pick').addEventListener('click', async () => {
    const res = await toContent('startPick', {
      similar: card.querySelector('.fmult').checked,
      prompt1: 'انقر على العنصر داخل الصف الأول — Esc للإلغاء',
      prompt2: 'انقر عنصرًا مشابهًا في صف آخر للتعميم — أو Enter لعنصر واحد'
    });
    if (res && res.selector) {
      // إن كان هناك محدد صفوف، اجعل المحدد نسبيًا إن أمكن
      card.querySelector('.fsel').value = res.selector;
      updateFieldCount(card);
    }
  });
  card.querySelector('.f-prev').addEventListener('click', async () => {
    const sel = effectiveSelector(card.querySelector('.fsel').value);
    const res = await toContent('preview', { selector: sel });
    if (res) toast(`${res.count} عنصرًا مطابقًا`);
  });
  card.querySelector('.fsel').addEventListener('change', () => updateFieldCount(card));

  $('fieldsList').appendChild(card);
  return card;
}

// المحدد الفعلي: إن وُجدت حاوية صفوف نعاين داخل أول حاوية، وإلا على الصفحة
function effectiveSelector(sel) {
  const row = $('rowSelector').value.trim();
  if (row && sel) return row + ' ' + sel;
  return sel;
}

async function updateFieldCount(card) {
  const sel = effectiveSelector(card.querySelector('.fsel').value.trim());
  if (!sel) { card.querySelector('.field-count').textContent = ''; return; }
  const res = await toContent('countSelector', { selector: sel });
  if (res) card.querySelector('.field-count').textContent = res.count >= 0 ? res.count : '⚠';
}

$('btnAddField').addEventListener('click', () => addFieldCard());

// ---------- التقاط حاوية الصفوف ----------
$('pickRow').addEventListener('click', async () => {
  const res = await toContent('startPick', {
    similar: true,
    prompt1: 'انقر على أول عنصر متكرر (مثلاً بطاقة منتج)',
    prompt2: 'انقر على عنصر مشابه ثانٍ ليتم تعميم التحديد على الكل — أو Enter لعنصر واحد'
  });
  if (res && res.selector) {
    $('rowSelector').value = res.selector;
    $('noRowSelector').checked = false;
    updateRowHint(res.count);
  }
});

$('previewRow').addEventListener('click', async () => {
  const sel = $('rowSelector').value.trim();
  if (!sel) return toast('أدخل محددًا أولًا');
  const res = await toContent('preview', { selector: sel });
  if (res) updateRowHint(res.count);
});

$('rowSelector').addEventListener('change', async () => {
  const sel = $('rowSelector').value.trim();
  if (!sel) return updateRowHint(null);
  const res = await toContent('countSelector', { selector: sel });
  if (res) updateRowHint(res.count);
});

function updateRowHint(count) {
  const el = $('rowCountHint');
  if (count === null || count === undefined) { el.textContent = ''; return; }
  el.textContent = count < 0 ? '⚠ المحدد غير صالح' : `✔ ${count} صفًا/عنصرًا مطابقًا في هذه الصفحة`;
  el.style.color = count > 0 ? '#059669' : '#dc2626';
}

$('noRowSelector').addEventListener('change', (e) => {
  $('rowSelector').disabled = e.target.checked;
  $('pickRow').disabled = e.target.checked;
  $('previewRow').disabled = e.target.checked;
});

// ---------- التقاط زر "التالي" ----------
$('pickNext').addEventListener('click', async () => {
  const res = await toContent('startPick', {
    similar: false,
    prompt1: 'انقر على زر أو رابط «التالي» في شريط الصفحات — Esc للإلغاء'
  });
  if (res && res.selector) $('nextSelector').value = res.selector;
});
$('previewNext').addEventListener('click', async () => {
  const sel = $('nextSelector').value.trim();
  if (!sel) return;
  const res = await toContent('preview', { selector: sel });
  if (res) toast(`${res.count} عنصرًا مطابقًا`);
});

// ---------- الجدول التلقائي ----------
$('btnAutoTable').addEventListener('click', async () => {
  const res = await toContent('startPick', {
    similar: false,
    prompt1: 'انقر في أي مكان داخل الجدول المطلوب استخراجه — Esc للإلغاء'
  });
  if (!res || !res.selector) return;
  const cfg = await toContent('autoTable', { selector: res.selector });
  if (cfg && cfg.config) {
    $('rowSelector').value = cfg.config.rowSelector;
    $('noRowSelector').checked = false;
    $('rowSelector').disabled = false;
    $('fieldsList').innerHTML = '';
    cfg.config.fields.forEach(f => addFieldCard(f));
    toast(`تم توليد ${cfg.config.fields.length} أعمدة من الجدول`);
    const c = await toContent('countSelector', { selector: cfg.config.rowSelector });
    if (c) updateRowHint(c.count);
  } else {
    toast('لم يتم العثور على جدول في العنصر الملتقط', 3200);
  }
});

// ============================================================
// وضع التنقل — إظهار/إخفاء الخيارات
// ============================================================
document.querySelectorAll('input[name=pagMode]').forEach(r => {
  r.addEventListener('change', () => {
    const mode = document.querySelector('input[name=pagMode]:checked').value;
    document.querySelectorAll('.pag-opt').forEach(box => {
      box.classList.toggle('visible', box.dataset.for.split(' ').includes(mode));
    });
  });
});

// ============================================================
// تجميع الإعدادات
// ============================================================
function collectConfig() {
  const fields = Array.from(document.querySelectorAll('.field-card')).map(card => ({
    name: card.querySelector('.fname').value.trim() || 'حقل',
    selector: card.querySelector('.fsel').value.trim(),
    type: card.querySelector('.ftype').value,
    multiple: card.querySelector('.fmult').checked,
    attr: card.querySelector('.fattr').value.trim()
  })).filter(f => f.selector);

  const mode = document.querySelector('input[name=pagMode]:checked').value;
  return {
    name: $('projectName').value.trim() || 'بيانات مستخرجة',
    rowSelector: $('noRowSelector').checked ? '' : $('rowSelector').value.trim(),
    fields,
    pagination: {
      mode,
      nextSelector: $('nextSelector').value.trim(),
      urlTemplate: $('urlTemplate').value.trim(),
      from: parseInt($('pageFrom').value, 10) || 1,
      to: parseInt($('pageTo').value, 10) || 0
    },
    options: {
      maxPages: parseInt($('optMaxPages').value, 10) || 50,
      pageWait: parseInt($('optPageWait').value, 10) || 1500,
      scrollWait: parseInt($('optScrollWait').value, 10) || 1500,
      maxScrolls: parseInt($('optMaxScrolls').value, 10) || 40,
      dedupe: $('optDedupe').checked,
      skipEmpty: $('optSkipEmpty').checked
    }
  };
}

function applyConfig(cfg) {
  $('projectName').value = cfg.name || '';
  $('noRowSelector').checked = !cfg.rowSelector;
  $('rowSelector').value = cfg.rowSelector || '';
  $('rowSelector').disabled = !cfg.rowSelector;
  $('fieldsList').innerHTML = '';
  (cfg.fields || []).forEach(f => addFieldCard(f));
  const pag = cfg.pagination || { mode: 'none' };
  const radio = document.querySelector(`input[name=pagMode][value="${pag.mode || 'none'}"]`);
  if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  $('nextSelector').value = pag.nextSelector || '';
  $('urlTemplate').value = pag.urlTemplate || '';
  $('pageFrom').value = pag.from || 1;
  $('pageTo').value = pag.to || 10;
  const o = cfg.options || {};
  $('optMaxPages').value = o.maxPages || 50;
  $('optPageWait').value = o.pageWait != null ? o.pageWait : 1500;
  $('optScrollWait').value = o.scrollWait || 1500;
  $('optMaxScrolls').value = o.maxScrolls || 40;
  $('optDedupe').checked = o.dedupe !== false;
  $('optSkipEmpty').checked = o.skipEmpty !== false;
  if (cfg.rowSelector) $('rowSelector').dispatchEvent(new Event('change'));
}

// ============================================================
// تجربة الاستخراج
// ============================================================
$('btnTestExtract').addEventListener('click', async () => {
  const cfg = collectConfig();
  if (!cfg.fields.length) return toast('أضف حقلًا واحدًا على الأقل');
  const res = await toContent('extractNow', { config: cfg });
  const box = $('testResult');
  if (!res || !res.rows) { box.innerHTML = ''; return toast('تعذر الاستخراج'); }
  if (!res.rows.length) {
    box.innerHTML = '<div class="tr-title">⚠ لم يتم العثور على بيانات — تحقق من المحددات</div>';
    return;
  }
  box.innerHTML = `<div class="tr-title">✔ ${res.total} صفًا في هذه الصفحة — معاينة أول ${res.rows.length}:</div>` + buildTable(res.columns, res.rows);
});

function buildTable(columns, rows) {
  const cols = columns && columns.length ? columns : Object.keys(rows[0] || {});
  let html = '<table><thead><tr>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows) {
    html += '<tr>' + cols.map(c => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('') + '</tr>';
  }
  return html + '</tbody></table>';
}

// ============================================================
// التشغيل والإيقاف
// ============================================================
$('btnRun').addEventListener('click', async () => {
  const cfg = collectConfig();
  if (!cfg.fields.length) return toast('أضف حقلًا واحدًا على الأقل');
  if (!cfg.rowSelector && !cfg.fields.some(f => f.multiple)) {
    if (!confirm('بدون حاوية صفوف ولا حقول متعددة ستحصل غالبًا على صف واحد. متابعة؟')) return;
  }
  if ((cfg.pagination.mode === 'next' || cfg.pagination.mode === 'click') && !cfg.pagination.nextSelector)
    return toast('حدد محدد زر «التالي» في تبويب التنقل');
  if (cfg.pagination.mode === 'pattern' && !cfg.pagination.urlTemplate.includes('{page}'))
    return toast('أدخل نمط رابط يحتوي {page}');

  await chrome.storage.local.set({ ws_last_config: cfg }); // استعادة النموذج بعد التنقل
  const res = await toContent('run', { config: cfg });
  if (res && res.ok === false) toast(res.error || 'تعذر البدء');
  else { toast('بدأ الاستخراج…'); refreshStatus(); }
});

$('btnStop').addEventListener('click', async () => {
  await toContent('stop');
  toast('تم إرسال أمر الإيقاف');
  setTimeout(refreshStatus, 600);
});

// ============================================================
// الحالة والمعاينة من التخزين
// ============================================================
const JOB_KEY = 'ws_active_job';
const RESULTS_KEY = 'ws_results';

async function refreshStatus() {
  const o = await chrome.storage.local.get([JOB_KEY]);
  const job = o[JOB_KEY];
  const card = $('statusCard');
  const txt = $('statusText');
  const meta = $('statusMeta');
  card.className = '';
  $('btnRun').disabled = false;
  $('btnStop').disabled = true;

  if (!job) {
    txt.textContent = 'جاهز للتشغيل';
    meta.textContent = '';
    $('progressFill').style.width = '0';
    return;
  }
  const cfgName = job.config && job.config.name ? job.config.name : '';
  if (job.status === 'running') {
    card.classList.add('running');
    txt.textContent = `⏳ جارٍ الاستخراج… ${cfgName}`;
    meta.textContent = `الصفحات: ${job.pages} — السجلات: ${job.totalRows}`;
    $('progressFill').style.width = '100%';
    $('btnRun').disabled = true;
    $('btnStop').disabled = false;
  } else if (job.status === 'done') {
    card.classList.add('done');
    txt.textContent = `✔ اكتمل الاستخراج — ${cfgName}`;
    meta.textContent = `الصفحات: ${job.pages} — السجلات: ${job.totalRows}`;
    $('progressFill').style.width = '100%';
  } else if (job.status === 'stopped') {
    txt.textContent = '⏹ تم الإيقاف';
    meta.textContent = `الصفحات: ${job.pages} — السجلات: ${job.totalRows} — يمكنك تصدير ما جُمع`;
  } else if (job.status === 'error') {
    card.classList.add('error');
    txt.textContent = '⚠ حدث خطأ';
    meta.textContent = job.error || '';
  }
}

async function refreshPreview() {
  const o = await chrome.storage.local.get([RESULTS_KEY]);
  const store = o[RESULTS_KEY] || { rows: [], columns: [] };
  $('rowsBadge').textContent = store.rows.length;
  const box = $('dataPreview');
  if (!store.rows.length) {
    box.innerHTML = '<div class="empty">لا توجد بيانات بعد — ابدأ الاستخراج</div>';
    return;
  }
  box.innerHTML = buildTable(store.columns, store.rows.slice(0, 100)) +
    (store.rows.length > 100 ? `<div class="hint" style="padding:6px">تُعرض أول 100 من ${store.rows.length} سجلًا — التصدير يشمل الكل</div>` : '');
}

$('btnRefreshData').addEventListener('click', () => { refreshStatus(); refreshPreview(); });
$('btnClearData').addEventListener('click', async () => {
  if (!confirm('مسح كل البيانات المستخرجة؟')) return;
  await chrome.storage.local.remove([RESULTS_KEY, JOB_KEY]);
  refreshStatus(); refreshPreview();
});

// تحديث حي عند تغيّر التخزين
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[JOB_KEY]) refreshStatus();
  if (changes[RESULTS_KEY]) refreshPreview();
});

// ============================================================
// التصدير CSV / XLSX
// ============================================================
async function getResults() {
  const o = await chrome.storage.local.get([RESULTS_KEY, JOB_KEY]);
  return {
    rows: (o[RESULTS_KEY] && o[RESULTS_KEY].rows) || [],
    columns: (o[RESULTS_KEY] && o[RESULTS_KEY].columns) || [],
    name: (o[JOB_KEY] && o[JOB_KEY].config && o[JOB_KEY].config.name) || $('projectName').value.trim() || 'بيانات'
  };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeFileName(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'web-scraper-data';
}

function downloadBlob(blob, filename) {
  // الرابط المباشر: الطريقة الوحيدة التي تحترم اسم الملف من داخل إطار
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10000);
}

function toCSV(rows, columns) {
  const cols = columns && columns.length ? columns : Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const escCell = (v) => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [cols.map(escCell).join(',')];
  for (const r of rows) lines.push(cols.map(c => escCell(r[c])).join(','));
  return '\uFEFF' + lines.join('\r\n'); // U+FEFF BOM لدعم العربية في Excel
}

$('btnExportCSV').addEventListener('click', async () => {
  const { rows, columns, name } = await getResults();
  if (!rows.length) return toast('لا توجد بيانات للتصدير');
  const blob = new Blob([toCSV(rows, columns)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `${safeFileName(name)}-${timestamp()}.csv`);
  toast(`تم تصدير ${rows.length} سجلًا إلى CSV`);
});

$('btnExportXLSX').addEventListener('click', async () => {
  const { rows, columns, name } = await getResults();
  if (!rows.length) return toast('لا توجد بيانات للتصدير');
  const cols = columns && columns.length ? columns : Array.from(new Set(rows.flatMap(r => Object.keys(r))));
  const ordered = rows.map(r => { const o = {}; cols.forEach(c => o[c] = r[c] != null ? r[c] : ''); return o; });
  const ws = XLSX.utils.json_to_sheet(ordered, { header: cols });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'البيانات');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeFileName(name)}-${timestamp()}.xlsx`);
  toast(`تم تصدير ${rows.length} سجلًا إلى XLSX`);
});

// ============================================================
// المشاريع المحفوظة
// ============================================================
const PROJECTS_KEY = 'ws_projects';

async function getProjects() {
  const o = await chrome.storage.local.get(PROJECTS_KEY);
  return o[PROJECTS_KEY] || {};
}

$('btnSaveProject').addEventListener('click', async () => {
  const cfg = collectConfig();
  if (!cfg.fields.length) return toast('أضف حقولًا قبل الحفظ');
  const projects = await getProjects();
  const id = 'p_' + Date.now();
  projects[id] = { id, name: cfg.name, host: location.hostname || '', config: cfg, savedAt: Date.now() };
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  toast('تم حفظ المشروع ✔');
});

async function renderProjects() {
  const projects = await getProjects();
  const list = $('projectsList');
  const arr = Object.values(projects).sort((a, b) => b.savedAt - a.savedAt);
  if (!arr.length) {
    list.innerHTML = '<div class="hint" style="text-align:center;padding:30px">لا توجد مشاريع محفوظة بعد.<br>ابنِ محدداتك في تبويب «المحددات» ثم اضغط «حفظ المشروع».</div>';
    return;
  }
  list.innerHTML = '';
  for (const p of arr) {
    const div = document.createElement('div');
    div.className = 'project-card';
    const date = new Date(p.savedAt).toLocaleDateString('ar');
    div.innerHTML = `
      <div class="pname">${esc(p.name)}</div>
      <div class="pmeta">الحقول: ${(p.config.fields || []).length} — التنقل: ${pagModeName(p.config.pagination && p.config.pagination.mode)} — حُفظ: ${date}</div>
      <div class="pactions">
        <button class="btn primary small p-load">📂 تحميل</button>
        <button class="btn success small p-run">▶ تشغيل</button>
        <button class="btn danger small p-del">🗑 حذف</button>
      </div>`;
    div.querySelector('.p-load').addEventListener('click', () => {
      applyConfig(p.config);
      document.querySelector('.tab[data-tab=build]').click();
      toast('تم تحميل المشروع');
    });
    div.querySelector('.p-run').addEventListener('click', async () => {
      applyConfig(p.config);
      document.querySelector('.tab[data-tab=data]').click();
      await chrome.storage.local.set({ ws_last_config: p.config });
      const res = await toContent('run', { config: p.config });
      if (res && res.ok === false) toast(res.error || 'تعذر البدء');
      else toast('بدأ الاستخراج…');
    });
    div.querySelector('.p-del').addEventListener('click', async () => {
      if (!confirm(`حذف مشروع «${p.name}»؟`)) return;
      const projects = await getProjects();
      delete projects[p.id];
      await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
      renderProjects();
    });
    list.appendChild(div);
  }
}

function pagModeName(m) {
  return { none: 'بدون', next: 'رابط التالي', click: 'نقرة AJAX', scroll: 'تمرير لانهائي', pattern: 'نمط رابط' }[m] || 'بدون';
}

// ============================================================
// تهيئة — استعادة آخر إعدادات (اللوحة تُعاد عند كل تنقل)
// ============================================================
(async function init() {
  const o = await chrome.storage.local.get([JOB_KEY, 'ws_last_config']);
  const job = o[JOB_KEY];
  const cfg = (job && job.config) || o.ws_last_config;
  if (cfg && cfg.fields && cfg.fields.length) {
    applyConfig(cfg);
  } else {
    addFieldCard({ name: 'الاسم' });
    addFieldCard({ name: 'السعر' });
  }
  refreshStatus();
  refreshPreview();
})();

})();
