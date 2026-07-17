// ============================================================
// content.js — نقطة الدخول في كل صفحة
// - حقن لوحة التحكم (iframe) وإظهارها/إخفاؤها
// - جسر رسائل بين اللوحة وأدوات الصفحة (Picker / Extractor / Runner)
// - استئناف المهام بعد التنقل (بما فيها تطبيقات SPA)
// ============================================================
(function (NS) {
  'use strict';
  if (window.__WS_CONTENT_LOADED__) return;
  window.__WS_CONTENT_LOADED__ = true;

  const PANEL_ID = '__ws_panel_host';
  let panelToken = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // ---------- إنشاء اللوحة ----------
  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement('div');
    host.id = PANEL_ID;
    const iframe = document.createElement('iframe');
    iframe.id = '__ws_panel_frame';
    iframe.src = chrome.runtime.getURL('panel/panel.html') + '#t=' + panelToken;
    iframe.setAttribute('allow', 'downloads');
    host.appendChild(iframe);

    const fab = document.createElement('button');
    fab.id = '__ws_fab';
    fab.title = 'فتح مستخرج الويب الذكي';
    fab.textContent = '🕷';
    fab.addEventListener('click', () => togglePanel(true));
    host.appendChild(fab);

    (document.documentElement || document.body).appendChild(host);
    host.classList.add('__ws_hidden');
  }

  function togglePanel(force) {
    const host = document.getElementById(PANEL_ID);
    if (!host) { createPanel(); return togglePanel(force); }
    const show = typeof force === 'boolean' ? force : host.classList.contains('__ws_hidden');
    host.classList.toggle('__ws_hidden', !show);
    if (show) {
      // أبلغ اللوحة بحالة المهمة الحالية فور فتحها
      setTimeout(() => relayToPanel({ type: 'panelOpened', href: location.href }), 300);
    }
  }

  function relayToPanel(obj) {
    const frame = document.getElementById('__ws_panel_frame');
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(Object.assign({ src: 'WS_CONTENT', token: panelToken }, obj), '*');
    }
  }

  // ---------- رسائل من اللوحة إلى الصفحة ----------
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.src !== 'WS_PANEL' || d.token !== panelToken) return;

    switch (d.type) {
      case 'closePanel':
        togglePanel(false);
        break;

      case 'startPick': {
        NS.startPick({
          similar: !!d.similar,
          prompt1: d.prompt1,
          prompt2: d.prompt2,
          onDone: (selector, count) => {
            relayToPanel({ type: 'picked', reqId: d.reqId, selector, count });
            NS.clearPreview(document);
          },
          onCancel: () => relayToPanel({ type: 'pickCancelled', reqId: d.reqId })
        });
        break;
      }

      case 'cancelPick':
        NS.cancelPick();
        break;

      case 'preview': {
        const count = NS.previewSelector(document, d.selector || '');
        relayToPanel({ type: 'previewed', reqId: d.reqId, count });
        break;
      }

      case 'clearPreview':
        NS.clearPreview(document);
        break;

      case 'countSelector': {
        relayToPanel({ type: 'counted', reqId: d.reqId, count: NS.safeCount(document, d.selector || '') });
        break;
      }

      case 'autoTable': {
        const cfg = NS.autoTableConfig(d.selector);
        relayToPanel({ type: 'autoTableResult', reqId: d.reqId, config: cfg });
        break;
      }

      case 'run':
        NS.startJob(d.config).then(res => relayToPanel({ type: 'runResult', ok: res.ok, error: res.error }));
        break;

      case 'stop':
        NS.stopJob();
        break;

      case 'extractNow': {
        // استخراج تجريبي فوري بدون مهمة (للمعاينة)
        const out = NS.extractPage(d.config);
        relayToPanel({ type: 'extractNowResult', reqId: d.reqId, rows: out.rows.slice(0, 5), total: out.rows.length, columns: out.columns });
        break;
      }
    }
  });

  // ---------- رسائل من الـ Popup / الخلفية ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'WS_TOGGLE_PANEL') {
      togglePanel();
      sendResponse({ ok: true });
    }
    return true;
  });

  // ---------- أحداث DOM من المشغّل => تمريرها للوحة ----------
  document.addEventListener('__WS_EVENT', (e) => {
    relayToPanel({ type: 'jobEvent', detail: e.detail });
  });

  // ---------- استئناف بعد التنقل ----------
  function tryResumeSoon() { setTimeout(() => NS.tryResumeJob(), 400); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryResumeSoon);
  } else {
    tryResumeSoon();
  }

  // دعم تطبيقات الصفحة الواحدة (SPA): اعتراض pushState/replaceState
  (function hookHistory() {
    const fire = () => {
      window.dispatchEvent(new Event('__ws_locationchange'));
    };
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    window.addEventListener('__ws_locationchange', () => setTimeout(() => NS.tryResumeJob(), 800));
  })();

  // ---------- جسر اختبارات (يُستخدم للاختبار الآلي فقط) ----------
  document.addEventListener('__WS_TEST', (e) => {
    const d = e.detail || {};
    if (d.action === 'run') NS.startJob(d.config);
    else if (d.action === 'extract') {
      const out = NS.extractPage(d.config);
      NS._emitDomEvent('testExtract', { rows: out.rows, columns: out.columns });
    }
    else if (d.action === 'getResults') {
      try {
        chrome.storage.local.get(['ws_active_job', 'ws_results'], (o) => {
          const job = o.ws_active_job || null;
          const store = o.ws_results || { rows: [] };
          NS._emitDomEvent('testResults', {
            status: job ? job.status : null,
            pages: job ? job.pages : 0,
            totalRows: job ? job.totalRows : store.rows.length,
            rows: store.rows.slice(0, 5)
          });
        });
      } catch (err) { NS._emitDomEvent('testResults', { status: 'error', error: String(err) }); }
    }
    else if (d.action === 'autoTable') {
      const cfg = NS.autoTableConfig(d.selector);
      NS._emitDomEvent('testAutoTable', { config: cfg });
    }
    else if (d.action === 'generalize') {
      const els = document.querySelectorAll(d.sel1);
      const sel = els.length >= 2 ? NS.generalizeFromTwo(els[d.i1 || 0], els[d.i2 === undefined ? els.length - 1 : d.i2]) : null;
      NS._emitDomEvent('testGeneralize', { selector: sel, count: sel ? NS.safeCount(document, sel) : 0 });
    }
    else if (d.action === 'stop') NS.stopJob();
  });

  // إنشاء اللوحة مسبقًا (مخفية) حتى تفتح فورًا عند الطلب
  if (document.documentElement) createPanel();
  else document.addEventListener('DOMContentLoaded', createPanel);

})(window.__WS = window.__WS || {});
