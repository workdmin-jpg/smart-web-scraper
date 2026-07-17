// ============================================================
// background.js — عامل الخدمة (Service Worker)
// يدير حالة مهمة الاستخراج النشطة حتى تستمر بعد التنقل بين الصفحات.
// الحالة تُخزَّن في chrome.storage.local حتى لا تضيع لو توقف العامل.
// ============================================================

const JOB_KEY = 'ws_active_job';
const RESULTS_KEY = 'ws_results';

async function getJob() {
  const o = await chrome.storage.local.get(JOB_KEY);
  return o[JOB_KEY] || null;
}

async function setJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

async function clearJob() {
  await chrome.storage.local.remove([JOB_KEY, RESULTS_KEY]);
}

async function appendResults(newRows, meta) {
  const o = await chrome.storage.local.get(RESULTS_KEY);
  const store = o[RESULTS_KEY] || { rows: [], columns: [] };
  if (meta && meta.columns) store.columns = meta.columns;
  store.rows = store.rows.concat(newRows);
  try {
    await chrome.storage.local.set({ [RESULTS_KEY]: store });
  } catch (e) {
    // تجاوز الحصة التخزينية — نبقي ما أمكن
    console.warn('WS: storage quota', e);
  }
  return store.rows.length;
}

async function resetResults(columns) {
  await chrome.storage.local.set({ [RESULTS_KEY]: { rows: [], columns: columns || [] } });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'WS_START_JOB': {
        // بدء مهمة جديدة: تصفير النتائج وحفظ المهمة
        await resetResults(msg.columns || []);
        const job = {
          tabId: sender.tab ? sender.tab.id : msg.tabId,
          status: 'running',
          config: msg.config,
          pages: 0,
          totalRows: 0,
          nextUrl: null,
          startedAt: Date.now(),
          error: null
        };
        await setJob(job);
        sendResponse({ ok: true });
        break;
      }
      case 'WS_GET_JOB': {
        const job = await getJob();
        sendResponse({ job });
        break;
      }
      case 'WS_UPDATE_JOB': {
        const job = await getJob();
        if (job) {
          Object.assign(job, msg.patch || {});
          await setJob(job);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'WS_APPEND': {
        const total = await appendResults(msg.rows || [], msg.meta);
        const job = await getJob();
        if (job) {
          job.totalRows = total;
          if (typeof msg.pages === 'number') job.pages = msg.pages;
          await setJob(job);
        }
        sendResponse({ ok: true, total });
        break;
      }
      case 'WS_FINISH_JOB': {
        const job = await getJob();
        if (job) {
          job.status = msg.error ? 'error' : 'done';
          job.error = msg.error || null;
          job.finishedAt = Date.now();
          await setJob(job);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'WS_STOP_JOB': {
        const job = await getJob();
        if (job && job.status === 'running') {
          job.status = 'stopped';
          job.finishedAt = Date.now();
          await setJob(job);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'WS_CLEAR_ALL': {
        await clearJob();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // رد غير متزامن
});

// تنظيف مهمة معلّقة إذا أُغلق التبويب الذي كان يشغّلها
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await getJob();
  if (job && job.tabId === tabId && job.status === 'running') {
    job.status = 'stopped';
    job.error = 'أُغلق التبويب أثناء التشغيل';
    await setJob(job);
  }
});
