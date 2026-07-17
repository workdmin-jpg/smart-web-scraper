// ============================================================
// runner.js — مشغّل مهام الاستخراج
// يدعم: صفحة واحدة، رابط/زر "التالي"، النقر (AJAX)،
// التمرير اللانهائي، ونمط رابط {page}. ويستأنف تلقائيًا بعد التنقل.
// ============================================================
(function (NS) {
  'use strict';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let runningFlag = false;
  let stopRequested = false;

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  // بث حدث على مستوى المستند (تستخدمه اللوحة وبيئة الاختبار)
  function emitDomEvent(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent('__WS_EVENT', { detail: Object.assign({ event: name }, detail || {}) }));
    } catch (e) {}
  }

  async function waitForReady(config) {
    const opts = config.options || {};
    const timeout = Math.max(3000, opts.pageWait || 1500);
    // انتظر ظهور محدد الصفوف أو محدد مخصص إن وُجد
    const target = opts.waitForSelector || config.rowSelector ||
      (config.fields && config.fields[0] && config.fields[0].selector);
    if (target) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout + 4000) {
        if (stopRequested) return;
        if (NS.safeCount(document, target) > 0) break;
        await sleep(250);
      }
    }
    await sleep(opts.pageWait || 1500);
  }

  // ---------- التمرير اللانهائي ----------
  async function infiniteScroll(config) {
    const opts = config.options || {};
    const maxScrolls = opts.maxScrolls || 30;
    const wait = opts.scrollWait || 1500;
    const countSel = config.rowSelector || (config.fields[0] && config.fields[0].selector) || 'body *';

    let lastCount = NS.safeCount(document, countSel);
    let stableRounds = 0;

    for (let i = 0; i < maxScrolls; i++) {
      if (stopRequested) return;
      window.scrollTo(0, document.documentElement.scrollHeight);
      document.documentElement.scrollTop = document.documentElement.scrollHeight;
      document.body && (document.body.scrollTop = document.body.scrollHeight);
      await sleep(wait);
      const c = NS.safeCount(document, countSel);
      emitDomEvent('scroll', { round: i + 1, count: c });
      if (c === lastCount) stableRounds++; else stableRounds = 0;
      lastCount = c;
      if (stableRounds >= 2) break; // لم يعد هناك محتوى جديد
    }
  }

  // ---------- انتظار تغيّر DOM بعد نقرة AJAX ----------
  function waitDomChange(ms) {
    return new Promise((resolve) => {
      let seen = false;
      let quietTimer = null;
      const obs = new MutationObserver(() => {
        seen = true;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => { obs.disconnect(); resolve(true); }, 600);
      });
      try { obs.observe(document.body, { childList: true, subtree: true, attributes: false }); } catch (e) {}
      setTimeout(() => { obs.disconnect(); resolve(seen); }, ms);
    });
  }

  function rowKey(row) {
    return Object.keys(row).sort().map(k => k + '=' + row[k]).join('\u0001');
  }

  // ---------- الحلقة الرئيسية ----------
  // state (عند الاستئناف): { pages, seenKeys[], noNewStreak, patternPage }
  async function runLoop(config, state) {
    runningFlag = true;
    stopRequested = false;
    const pag = config.pagination || { mode: 'none' };
    const opts = config.options || {};
    const maxPages = opts.maxPages || 100;
    const seen = new Set(state && state.seenKeys ? state.seenKeys : []);
    let pages = state && state.pages ? state.pages : 0;
    let noNewStreak = state && state.noNewStreak ? state.noNewStreak : 0;
    let patternPage = state && state.patternPage ? state.patternPage : (pag.from || 1);

    while (true) {
      if (stopRequested) { await send('WS_STOP_JOB'); emitDomEvent('stopped', { pages }); runningFlag = false; return; }

      await waitForReady(config);
      if (stopRequested) continue;

      // التمرير اللانهائي يحدث قبل الاستخراج (صفحة واحدة منطقيًا)
      if (pag.mode === 'scroll') await infiniteScroll(config);

      const { rows, columns } = NS.extractPage(config);

      // إزالة التكرار
      let fresh = rows;
      if (opts.dedupe !== false) {
        fresh = rows.filter(r => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
      } else {
        rows.forEach(r => seen.add(rowKey(r)));
      }

      pages += 1;
      if (fresh.length === 0) noNewStreak++; else noNewStreak = 0;

      const resp = await send('WS_APPEND', { rows: fresh, meta: { columns }, pages });
      emitDomEvent('progress', { pages, newRows: fresh.length, total: resp.total });

      // هل نتوقف؟
      if (pages >= maxPages) break;
      if (pag.mode === 'none' || pag.mode === 'scroll') break;
      if (noNewStreak >= 2 && (pag.mode === 'click')) break; // لا بيانات جديدة رغم النقر

      // تحديد الخطوة التالية
      if (pag.mode === 'pattern') {
        patternPage += 1;
        if (pag.to && patternPage > pag.to) break;
        const nextUrl = (pag.urlTemplate || '').replace('{page}', String(patternPage));
        if (!nextUrl || NS.urlsLooseEqual(nextUrl, location.href)) break;
        await send('WS_UPDATE_JOB', { patch: { nextUrl, state: { pages, seenKeys: Array.from(seen), noNewStreak, patternPage } } });
        emitDomEvent('navigate', { url: nextUrl, pages });
        location.href = nextUrl;
        return; // الاستئناف بعد التحميل
      }

      if (pag.mode === 'next' || pag.mode === 'click') {
        const el = NS.findNextElement(pag.nextSelector);
        if (!el) break; // لا يوجد "التالي" => انتهينا

        if (pag.mode === 'next') {
          const url = NS.nextUrlOf(el);
          if (url && !NS.urlsLooseEqual(url, location.href)) {
            await send('WS_UPDATE_JOB', { patch: { nextUrl: url, state: { pages, seenKeys: Array.from(seen), noNewStreak, patternPage } } });
            emitDomEvent('navigate', { url, pages });
            location.href = url;
            return;
          }
          // الرابط لا يحمل href صالحًا => جرّب النقر
        }

        // وضع النقر (AJAX)
        const beforeCount = NS.safeCount(document, config.rowSelector || '*');
        el.scrollIntoView({ block: 'center' });
        await sleep(300);
        const changed = waitDomChange(Math.max(5000, (opts.pageWait || 1500) * 3));
        el.click();
        const didChange = await changed;
        // بعض المواقع تنقل فعلًا عبر JS
        await sleep(400);
        if (!didChange) {
          const afterCount = NS.safeCount(document, config.rowSelector || '*');
          if (afterCount === beforeCount) noNewStreak++;
          if (noNewStreak >= 2) break;
        }
        await sleep(opts.pageWait || 1200);
        continue;
      }

      break;
    }

    await send('WS_FINISH_JOB', {});
    emitDomEvent('done', { pages });
    runningFlag = false;
  }

  // ---------- واجهة عامة ----------
  async function start(config) {
    if (runningFlag) return { ok: false, error: 'هناك مهمة تعمل بالفعل' };
    const columns = (config.fields || []).map(f => f.name).filter(Boolean);
    await send('WS_START_JOB', { config, columns });
    emitDomEvent('started', {});
    runLoop(config, null); // بلا انتظار — التنقل قد يمزق السياق
    return { ok: true };
  }

  async function tryResume() {
    if (runningFlag) return;
    const { job } = await send('WS_GET_JOB');
    if (!job || job.status !== 'running') return;
    if (!job.nextUrl) return; // وضع النقر لا يغيّر الصفحة — الاستئناف للتنقل فقط
    if (!NS.urlsLooseEqual(location.href, job.nextUrl)) return;
    const st = job.state || {};
    emitDomEvent('resumed', { pages: st.pages || 0 });
    runLoop(job.config, st);
  }

  async function stop() {
    stopRequested = true;
    await send('WS_STOP_JOB');
  }

  NS.startJob = start;
  NS.stopJob = stop;
  NS.tryResumeJob = tryResume;
  NS.isJobRunning = () => runningFlag;
  NS._emitDomEvent = emitDomEvent;

})(window.__WS = window.__WS || {});
