// zcontent.js — 智联招聘页面桥接
(() => {
  // 幂等：manifest 注入 + 主动注入时避免重复注册
  if (window.__zlCsInjected) return;
  window.__zlCsInjected = true;

  let processing = false;

  chrome.storage.onChanged.addListener(async (changes) => {
    if (!changes.zcmd?.newValue) return;
    const cmd = changes.zcmd.newValue;
    if (cmd.type !== 'apply') return;
    if (processing) return;
    processing = true;

    const div = document.createElement('div');
    div.id = '__zl_data_' + cmd.id;
    div.setAttribute('data-cmd', JSON.stringify(cmd));
    div.style.display = 'none';
    document.body.appendChild(div);

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('zinject.js');
    script.dataset.divId = div.id;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);

    const handler = (e) => {
      if (e.data?.__zl && e.data.id === cmd.id) {
        window.removeEventListener('message', handler);
        chrome.storage.local.set({ zresult: { id: e.data.id, ok: e.data.ok, msg: e.data.msg } });
        div.remove();
        processing = false;
      }
    };
    window.addEventListener('message', handler);

    setTimeout(() => {
      if (processing) {
        window.removeEventListener('message', handler);
        chrome.storage.local.set({ zresult: { id: cmd.id, ok: false, msg: '超时' } });
        div.remove();
        processing = false;
      }
    }, 15000);
  });
})();
