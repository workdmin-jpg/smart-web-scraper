// ============================================================
// extractor.js — محرك استخراج البيانات من الصفحة
// أنواع الحقول: نص، رابط، صورة، سمة، HTML
// وضعان: صفوف (حاوية متكررة + حقول) أو أعمدة (بدون حاوية)
// ============================================================
(function (NS) {
  'use strict';

  function absUrl(u) {
    if (!u) return '';
    try { return new URL(u, document.baseURI).href; } catch (e) { return u; }
  }

  function qsa(ctx, sel) {
    if (!sel) return [];
    try { return Array.from(ctx.querySelectorAll(sel)); } catch (e) { return []; }
  }

  function pickImageSrc(el) {
    if (!el) return '';
    if (el.tagName === 'IMG') {
      const cand = el.currentSrc || el.src || el.getAttribute('data-src') ||
        el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || '';
      if (cand) return absUrl(cand);
      const ss = el.getAttribute('srcset');
      if (ss) return absUrl(ss.split(',')[0].trim().split(/\s+/)[0]);
      return '';
    }
    const img = el.querySelector && el.querySelector('img');
    if (img) return pickImageSrc(img);
    // خلفية CSS
    try {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
      if (m) return absUrl(m[1]);
    } catch (e) {}
    return '';
  }

  function valueFromElement(el, field) {
    if (!el) return '';
    switch (field.type) {
      case 'link': {
        const a = el.tagName === 'A' ? el : (el.querySelector ? (el.closest('a') || el.querySelector('a')) : null);
        if (a && a.getAttribute('href') !== null) return absUrl(a.getAttribute('href'));
        return absUrl(el.getAttribute('href') || '');
      }
      case 'image':
        return pickImageSrc(el);
      case 'attribute':
        return el.getAttribute(field.attr || '') || '';
      case 'html':
        return el.innerHTML.trim();
      case 'text':
      default:
        return (el.innerText !== undefined ? el.innerText : el.textContent || '').trim().replace(/\s+\n/g, '\n');
    }
  }

  // استخراج حقل واحد داخل سياق (صف أو المستند كله)
  function extractField(field, ctx) {
    const els = qsa(ctx, field.selector);
    if (field.multiple) {
      return els.map(el => valueFromElement(el, field)).filter(v => v !== '').join(' | ');
    }
    return els.length ? valueFromElement(els[0], field) : '';
  }

  // استخراج حقل كقائمة (لوضع الأعمدة)
  function extractFieldList(field, ctx) {
    const els = qsa(ctx, field.selector);
    return els.map(el => valueFromElement(el, field));
  }

  // هل الصف يبدو صف ترويسة جدول؟
  function isHeaderRow(tr) {
    return !!tr.querySelector('th') && !tr.querySelector('td');
  }

  // ---------- الاستخراج الرئيسي للصفحة الحالية ----------
  // config: { rowSelector, fields[], options{} }
  function extractPage(config) {
    const fields = (config.fields || []).filter(f => f.name && (f.selector || f.type === 'constant'));
    const rows = [];

    if (config.rowSelector) {
      let containers = qsa(document, config.rowSelector);
      containers = containers.filter(c => !(c.tagName === 'TR' && isHeaderRow(c)));
      for (const c of containers) {
        const row = {};
        let hasValue = false;
        for (const f of fields) {
          const v = extractField(f, c);
          row[f.name] = v;
          if (v !== '') hasValue = true;
        }
        if (hasValue || !config.options || !config.options.skipEmpty) rows.push(row);
      }
    } else {
      // وضع الأعمدة: كل حقل متعدد = عمود، تُدمج بالفهرس
      const cols = {};
      let maxLen = 0;
      for (const f of fields) {
        if (f.multiple) {
          cols[f.name] = extractFieldList(f, document);
          maxLen = Math.max(maxLen, cols[f.name].length);
        } else {
          cols[f.name] = extractField(f, document);
          maxLen = Math.max(maxLen, 1);
        }
      }
      for (let i = 0; i < maxLen; i++) {
        const row = {};
        let hasValue = false;
        for (const f of fields) {
          const v = Array.isArray(cols[f.name]) ? (cols[f.name][i] || '') : (i === 0 ? cols[f.name] : cols[f.name]);
          row[f.name] = v;
          if (v !== '') hasValue = true;
        }
        if (hasValue) rows.push(row);
      }
    }

    return { rows, columns: fields.map(f => f.name) };
  }

  // ---------- توليد حقول جدول تلقائيًا ----------
  // يحوّل <table> إلى: محدد صفوف + حقول أعمدة
  function autoTableConfig(tableSelector) {
    const table = document.querySelector(tableSelector);
    if (!table || table.tagName !== 'TABLE') {
      // ربما التقط المستخدم عنصرًا داخل الجدول
      const t = table && table.closest ? table.closest('table') : null;
      if (!t) return null;
      return autoTableConfig(NS.generateSelector(t));
    }

    const headThs = table.querySelectorAll('thead th');
    let headers = [];
    if (headThs.length) {
      headers = Array.from(headThs).map(th => th.innerText.trim());
    } else {
      const firstTr = table.querySelector('tr');
      if (firstTr) {
        const cells = firstTr.querySelectorAll('th');
        headers = Array.from(cells).map(c => c.innerText.trim());
      }
    }

    const hasTbody = !!table.querySelector('tbody tr');
    const rowSelector = tableSelector + (hasTbody ? ' tbody tr' : ' tr');

    let colCount = headers.length;
    if (!colCount) {
      const anyRow = table.querySelector('tbody tr') || table.querySelector('tr');
      colCount = anyRow ? anyRow.querySelectorAll('td, th').length : 0;
    }

    const fields = [];
    for (let i = 0; i < colCount; i++) {
      fields.push({
        name: headers[i] && headers[i] !== '' ? headers[i] : 'عمود ' + (i + 1),
        selector: 'td:nth-of-type(' + (i + 1) + ')',
        type: 'text',
        multiple: false
      });
    }
    return { rowSelector, fields };
  }

  // ---------- إيجاد زر/رابط "التالي" ----------
  function findNextElement(selector) {
    if (!selector) return null;
    const els = qsa(document, selector);
    for (const el of els) {
      if (isDisabled(el)) return null; // موجود لكنه معطّل => نهاية الصفحات
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      return el;
    }
    return null;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.hasAttribute('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const cls = ' ' + (el.className && typeof el.className === 'string' ? el.className : '') + ' ';
    if (/\b(disabled|is-disabled|pagination-disabled)\b/i.test(cls)) return true;
    const li = el.closest && el.closest('li,button');
    if (li && li !== el) {
      if (li.hasAttribute('disabled') || li.getAttribute('aria-disabled') === 'true') return true;
      const lc = ' ' + (typeof li.className === 'string' ? li.className : '') + ' ';
      if (/\b(disabled|is-disabled)\b/i.test(lc)) return true;
    }
    return false;
  }

  function nextUrlOf(el) {
    if (!el) return null;
    const a = el.tagName === 'A' ? el : (el.closest('a') || (el.querySelector && el.querySelector('a')));
    if (a && a.href) return a.href;
    return null;
  }

  // مقارنة متساهلة للروابط (تجاهل # والشرطة الأخيرة)
  function urlsLooseEqual(u1, u2) {
    try {
      const a = new URL(u1), b = new URL(u2);
      const norm = (u) => (u.origin + u.pathname.replace(/\/+$/, '') + u.search);
      return norm(a) === norm(b);
    } catch (e) { return u1 === u2; }
  }

  NS.extractPage = extractPage;
  NS.autoTableConfig = autoTableConfig;
  NS.findNextElement = findNextElement;
  NS.nextUrlOf = nextUrlOf;
  NS.isDisabled = isDisabled;
  NS.absUrl = absUrl;
  NS.urlsLooseEqual = urlsLooseEqual;

})(window.__WS = window.__WS || {});
