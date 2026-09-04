(() => {
  // 幂等：manifest 注入 + 主动注入时避免重复注册
  if (window.__bossCsInjected) return;
  window.__bossCsInjected = true;

  let processing = false;

  chrome.storage.onChanged.addListener(async (changes) => {
    if (!changes.cmd?.newValue) return;
    const cmd = changes.cmd.newValue;
    if (cmd.type !== 'greet') return;
    if (processing) return; // 🔑 拒绝并发请求
    processing = true;

    // 用唯一 ID 避免冲突
    const div = document.createElement('div');
    div.id = '__boss_data_' + cmd.id;
    div.setAttribute('data-cmd', JSON.stringify(cmd));
    div.style.display = 'none';
    document.body.appendChild(div);

    // 注入 inject.js（传 div ID）
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.dataset.divId = div.id;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);

    // 等待结果后解锁
    const handler = (e) => {
      if (e.data?.__boss && e.data.id === cmd.id) {
        window.removeEventListener('message', handler);
        chrome.storage.local.set({ result: { id: e.data.id, ok: e.data.ok, msg: e.data.msg } });
        div.remove();
        processing = false;
      }
    };
    window.addEventListener('message', handler);

    // 超时解锁（10s）
    setTimeout(() => {
      if (processing) {
        window.removeEventListener('message', handler);
        chrome.storage.local.set({ result: { id: cmd.id, ok: false, msg: '超时' } });
        div.remove();
        processing = false;
      }
    }, 10000);
  });
})();
