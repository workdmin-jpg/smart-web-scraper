// ============================================================
// picker.js — التقاط العناصر بصريًا وتوليد محددات CSS ذكية
// يعمل داخل الصفحة المستهدفة (سكربت محتوى).
// ============================================================
window.__WS = window.__WS || {};

(function (NS) {
  'use strict';

  // ---------- أدوات مساعدة ----------
  function cssEscape(s) {
    try { return CSS.escape(s); } catch (e) { return s.replace(/[^\w-]/g, '\\$&'); }
  }

  function safeMatches(el, sel) {
    try { return el.matches(sel); } catch (e) { return false; }
  }

  function safeCount(doc, sel) {
    try { return doc.querySelectorAll(sel).length; } catch (e) { return -1; }
  }

  // استبعاد الأصناف المتغيرة/المولّدة تلقائيًا (هاشات، أرقام طويلة)
  function stableClasses(el) {
    const out = [];
    for (const c of el.classList || []) {
      if (!c) continue;
      if (/^[0-9]/.test(c)) continue;
      if (/[0-9a-f]{8,}/i.test(c) && c.length > 12) continue; // يشبه الهاش
      if (/^(css|sc|emotion|jss|jsx)-/i.test(c)) continue;
      if (c.length > 24) continue;
      out.push(cssEscape(c));
      if (out.length === 3) break;
    }
    return out;
  }

  // ---------- توليد محدد فريد لعنصر واحد ----------
  function generateSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const doc = el.ownerDocument;

    if (el.id) {
      const s = '#' + cssEscape(el.id);
      if (safeCount(doc, s) === 1) return s;
    }

    const parts = [];
    let cur = el;
    let depth = 0;

    while (cur && cur.nodeType === 1 && cur !== doc.documentElement && depth < 8) {
      let part = cur.tagName.toLowerCase();

      if (cur.id) {
        parts.unshift('#' + cssEscape(cur.id));
        break;
      }

      const cls = stableClasses(cur);
      if (cls.length) part += '.' + cls.slice(0, 2).join('.');

      const parent = cur.parentElement;
      if (parent) {
        const sameSiblings = Array.from(parent.children).filter(c => safeMatches(c, part));
        if (sameSiblings.length > 1) {
          const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
          const idx = sameTag.indexOf(cur) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }

      parts.unshift(part);

      const path = parts.join(' > ');
      if (safeCount(doc, path) === 1) return path;

      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  // واصف بسيط لمستوى معين من عنصر
  function descriptorOf(el) {
    const part = { tag: el.tagName.toLowerCase(), classes: stableClasses(el), nth: 0 };
    const parent = el.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      part.nth = sameTag.indexOf(el) + 1;
      part.total = sameTag.length;
    }
    return part;
  }

  function descToString(d, generalize) {
    let s = d.tag;
    if (d.classes.length) s += '.' + d.classes.slice(0, 2).join('.');
    if (!generalize && d.total > 1) s += ':nth-of-type(' + d.nth + ')';
    return s;
  }

  // ---------- تعميم محدد من عنصرين متشابهين ----------
  // الفكرة (مثل Web Scraper): المستخدم ينقر عنصرين من نفس النمط،
  // فنوجد سلفهما المشترك ونبني مسارًا يطابق كل العناصر المشابهة.
  function generalizeFromTwo(a, b) {
    if (!a || !b || a === b) return generateSelector(a);

    const chainA = [];
    let n = a;
    while (n && n.nodeType === 1) { chainA.unshift(n); n = n.parentElement; }
    const chainB = [];
    n = b;
    while (n && n.nodeType === 1) { chainB.unshift(n); n = n.parentElement; }

    // أعمق سلف مشترك
    let lcaIndex = -1;
    for (let i = 0; i < Math.min(chainA.length, chainB.length); i++) {
      if (chainA[i] === chainB[i]) lcaIndex = i; else break;
    }
    if (lcaIndex < 0) return generateSelector(a);

    const lca = chainA[lcaIndex];
    const relA = chainA.slice(lcaIndex + 1);
    const relB = chainB.slice(lcaIndex + 1);

    // بناء المسار النسبي المعمّم
    const relParts = [];
    for (let i = 0; i < Math.min(relA.length, relB.length); i++) {
      const dA = descriptorOf(relA[i]);
      const dB = descriptorOf(relB[i]);
      if (dA.tag !== dB.tag) return generateSelector(a); // بنيتان مختلفتان
      const common = { tag: dA.tag, classes: dA.classes.filter(c => dB.classes.includes(c)), nth: dA.nth, total: dA.total };
      const samePosition = dA.nth === dB.nth;
      // إذا اختلف الموضع بين العنصرين => هذا هو المستوى المتكرر => عمّم (بدون nth)
      relParts.push(descToString(common, !samePosition));
    }

    // مسار السلف المشترك (نريده ثابتًا قدر الإمكان)
    let prefix;
    if (lca === a.ownerDocument.body || lca === a.ownerDocument.documentElement) {
      prefix = '';
    } else {
      prefix = generateSelector(lca);
      if (safeCount(a.ownerDocument, prefix) !== 1) {
        // لم نستطع تثبيت السلف بمحدد فريد — جرّب واصفه العام
        prefix = descToString(descriptorOf(lca), true);
      }
    }

    const rel = relParts.join(' > ');
    const full = prefix ? prefix + ' > ' + rel : rel;

    // تحقق أن المحدد يطابق العنصرين فعلًا
    try {
      const set = new Set(a.ownerDocument.querySelectorAll(full));
      if (set.has(a) && set.has(b) && set.size >= 2) return full;
    } catch (e) { /* تجاهل */ }

    // خطة بديلة: إزالة آخر nth-of-type من محدد العنصر الأول
    const sel = generateSelector(a);
    const stripped = sel.replace(/:nth-of-type\(\d+\)(?!.*:nth-of-type\(\d+\))/, '');
    if (safeCount(a.ownerDocument, stripped) >= 2) return stripped;
    return sel;
  }

  // ---------- طبقة الإبراز (Overlay) ----------
  const overlayIds = ['__ws_highlight', '__ws_badge', '__ws_tip'];

  function ensureOverlay(doc) {
    if (doc.getElementById('__ws_highlight')) return;
    const h = doc.createElement('div');
    h.id = '__ws_highlight';
    const badge = doc.createElement('div');
    badge.id = '__ws_badge';
    const tip = doc.createElement('div');
    tip.id = '__ws_tip';
    tip.style.display = 'none';
    doc.documentElement.appendChild(h);
    doc.documentElement.appendChild(badge);
    doc.documentElement.appendChild(tip);
  }

  function positionBox(doc, el) {
    const h = doc.getElementById('__ws_highlight');
    const badge = doc.getElementById('__ws_badge');
    if (!h) return;
    const r = el.getBoundingClientRect();
    const x = r.left + doc.defaultView.scrollX;
    const y = r.top + doc.defaultView.scrollY;
    h.style.left = x + 'px';
    h.style.top = y + 'px';
    h.style.width = Math.max(2, r.width) + 'px';
    h.style.height = Math.max(2, r.height) + 'px';
    h.style.display = 'block';
    if (badge) {
      badge.textContent = el.tagName.toLowerCase() +
        (el.className && typeof el.className === 'string' ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.') : '');
      badge.style.left = x + 'px';
      badge.style.top = Math.max(0, y - 24) + 'px';
      badge.style.display = 'block';
    }
  }

  function hideOverlay(doc) {
    for (const id of overlayIds) {
      const n = doc.getElementById(id);
      if (n) n.style.display = 'none';
    }
  }

  function showTip(doc, text) {
    ensureOverlay(doc);
    const tip = doc.getElementById('__ws_tip');
    tip.textContent = text;
    tip.style.display = 'block';
  }

  // ---------- إبراز معاينة لكل العناصر المطابقة لمحدد ----------
  let previewBoxes = [];

  function clearPreview(doc) {
    for (const b of previewBoxes) { try { b.remove(); } catch (e) {} }
    previewBoxes = [];
  }

  function previewSelector(doc, selector, max = 60) {
    clearPreview(doc);
    let els = [];
    try { els = Array.from(doc.querySelectorAll(selector)); } catch (e) { return 0; }
    els.slice(0, max).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const box = doc.createElement('div');
      box.className = '__ws_preview_box';
      const x = r.left + doc.defaultView.scrollX;
      const y = r.top + doc.defaultView.scrollY;
      box.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${Math.max(2, r.width)}px;height:${Math.max(2, r.height)}px;z-index:2147483645;pointer-events:none;border:2px solid #22c55e;background:rgba(34,197,94,.10);`;
      const num = doc.createElement('span');
      num.textContent = String(i + 1);
      num.style.cssText = 'position:absolute;top:-18px;left:-2px;background:#22c55e;color:#fff;font:11px/16px sans-serif;padding:0 5px;border-radius:8px;';
      box.appendChild(num);
      doc.documentElement.appendChild(box);
      previewBoxes.push(box);
    });
    return els.length;
  }

  // ---------- أداة الالتقاط ----------
  class ElementPicker {
    constructor(doc) {
      this.doc = doc;
      this.active = false;
      this._onMove = this._onMove.bind(this);
      this._onClick = this._onClick.bind(this);
      this._onKey = this._onKey.bind(this);
      this._onScroll = this._onScroll.bind(this);
    }

    // opts: { prompt1, prompt2, onDone(selector, count, elementsInfo), onCancel }
    start(opts) {
      if (this.active) this.stop();
      this.active = true;
      this.opts = opts || {};
      this.firstEl = null;
      this.stage = 1;
      ensureOverlay(this.doc);
      showTip(this.doc, this.opts.prompt1 || 'انقر على العنصر المطلوب — Esc للإلغاء');
      const d = this.doc;
      d.addEventListener('mousemove', this._onMove, true);
      d.addEventListener('click', this._onClick, true);
      d.addEventListener('keydown', this._onKey, true);
      d.defaultView.addEventListener('scroll', this._onScroll, true);
    }

    stop() {
      this.active = false;
      const d = this.doc;
      d.removeEventListener('mousemove', this._onMove, true);
      d.removeEventListener('click', this._onClick, true);
      d.removeEventListener('keydown', this._onKey, true);
      if (d.defaultView) d.defaultView.removeEventListener('scroll', this._onScroll, true);
      hideOverlay(d);
    }

    _isOurs(el) {
      // تجاهل النقر على لوحة الإضافة نفسها
      return !!(el && (el.id === '__ws_panel_host' || (el.closest && el.closest('#__ws_panel_host')) ||
        el.id === '__ws_highlight' || el.id === '__ws_badge' || el.id === '__ws_tip' ||
        (el.classList && el.classList.contains('__ws_preview_box'))));
    }

    _onMove(e) {
      if (!this.active) return;
      if (this._isOurs(e.target)) { hideOverlay(this.doc); showTip(this.doc, this.stage === 1 ? (this.opts.prompt1 || '') : (this.opts.prompt2 || '')); return; }
      positionBox(this.doc, e.target);
    }

    _onScroll() { if (this.active) hideOverlay(this.doc); }

    _onKey(e) {
      if (!this.active) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        this.stop();
        if (this.opts.onCancel) this.opts.onCancel();
      } else if (e.key === 'Enter' && this.stage === 2) {
        // اكتفاء بعنصر واحد
        e.preventDefault(); e.stopPropagation();
        const sel = generateSelector(this.firstEl);
        const count = safeCount(this.doc, sel);
        this.stop();
        this.opts.onDone && this.opts.onDone(sel, count, 1);
      }
    }

    _onClick(e) {
      if (!this.active) return;
      if (this._isOurs(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const el = e.target;
      if (this.stage === 1) {
        if (!this.opts.similar) {
          const sel = generateSelector(el);
          const count = safeCount(this.doc, sel);
          this.stop();
          this.opts.onDone && this.opts.onDone(sel, count, 1);
          return;
        }
        this.firstEl = el;
        this.stage = 2;
        showTip(this.doc, this.opts.prompt2 || 'انقر الآن على عنصر مشابه آخر ليتم تعميم التحديد — أو Enter للاكتفاء بعنصر واحد');
        positionBox(this.doc, el);
      } else {
        const sel = generalizeFromTwo(this.firstEl, el);
        const count = safeCount(this.doc, sel);
        this.stop();
        this.opts.onDone && this.opts.onDone(sel, count, 2);
      }
    }
  }

  NS.generateSelector = generateSelector;
  NS.generalizeFromTwo = generalizeFromTwo;
  NS.safeCount = safeCount;
  NS.previewSelector = previewSelector;
  NS.clearPreview = clearPreview;
  NS.ElementPicker = ElementPicker;
  NS._picker = null;
  NS.startPick = function (opts) {
    if (!NS._picker) NS._picker = new ElementPicker(document);
    NS._picker.start(opts);
  };
  NS.cancelPick = function () { if (NS._picker) NS._picker.stop(); };

})(window.__WS);
