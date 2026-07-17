// popup.js — فتح/إخفاء لوحة الاستخراج في التبويب النشط
document.getElementById('open').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/.test(tab.url || '')) {
      document.getElementById('err').style.display = 'block';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'WS_TOGGLE_PANEL' }, () => {
      if (chrome.runtime.lastError) {
        // السكربت لم يُحقن بعد (ربما فُتحت الصفحة قبل تثبيت الإضافة)
        document.getElementById('err').textContent = '⚠ أعد تحميل الصفحة أولًا ثم حاول مجددًا.';
        document.getElementById('err').style.display = 'block';
        return;
      }
      window.close();
    });
  } catch (e) {
    document.getElementById('err').style.display = 'block';
  }
});
