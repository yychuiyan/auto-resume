// wcontent.js — 前程无忧页面桥接（对齐 1.0：收到 wcmd 即投递，不做页面校验）
(() => {
  if (window.__w51CsInjected) return;
  window.__w51CsInjected = true;

  let processing = false;
  chrome.storage.onChanged.addListener(async (changes) => {
    if (!changes.wcmd?.newValue) return;
    const cmd = changes.wcmd.newValue;
    if (cmd.type !== 'apply') return;
    if (processing) return;
    processing = true;
    const div = document.createElement('div');
    div.id = '__w51_data_' + cmd.id;
    div.setAttribute('data-cmd', JSON.stringify(cmd));
    div.style.display = 'none';
    document.body.appendChild(div);
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('winject.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
    const handler = (e) => {
      if (e.data?.__w51 && e.data.id === cmd.id) {
        window.removeEventListener('message', handler);
        chrome.storage.local.set({ wresult: { id: e.data.id, ok: e.data.ok, msg: e.data.msg } });
        div.remove();
        processing = false;
      }
    };
    window.addEventListener('message', handler);
    setTimeout(() => {
      if (processing) {
        window.removeEventListener('message', handler);
        chrome.storage.local.set({ wresult: { id: cmd.id, ok: false, msg: '超时' } });
        div.remove();
        processing = false;
      }
    }, 20000);
  });
})();
