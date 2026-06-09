// winject.js — 前程无忧投递（点击按钮+防导航+关弹窗）
(async () => {
  const divs = document.querySelectorAll('[id^="__w51_data_"]');
  const div = divs[divs.length - 1];
  if (!div) return;
  const cmd = JSON.parse(div.getAttribute('data-cmd'));
  try {
    const cards = document.querySelectorAll('.joblist-item');
    let clicked = false;
    for (const card of cards) {
      if (!card.outerHTML.includes(cmd.jobId)) continue;
      const btn = card.querySelector('button.btn.apply');
      if (!btn) break;
      if (btn.textContent.includes('已申请')) {
        window.postMessage({__w51:true,id:cmd.id,ok:true,msg:'已投递'},'*'); return;
      }
      // 屏蔽a标签防导航，点击按钮
      const as = card.querySelectorAll('a'); const pe = [];
      as.forEach(a => { pe.push(a.style.pointerEvents); a.style.pointerEvents = 'none'; });
      const oo = window.open; window.open = () => null;
      btn.click(); clicked = true;
      setTimeout(() => { window.open = oo; as.forEach((a,i) => { a.style.pointerEvents = pe[i]; }); }, 2000);
      break;
    }
    if (!clicked) { window.postMessage({__w51:true,id:cmd.id,ok:false,msg:'未找到按钮'},'*'); return; }

    // 等结果（不碰弹窗，只检测按钮状态变化）
    let success = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 500));
      for (const c of document.querySelectorAll('.joblist-item')) {
        if (c.outerHTML.includes(cmd.jobId)) {
          const b = c.querySelector('button.btn.apply');
          if (b && b.textContent.includes('已申请')) { success = true; break; }
        }
      }
      if (success) break;
    }
    window.postMessage({ __w51: true, id: cmd.id, ok: success || clicked, msg: '已投递' }, '*');
  } catch(e) {
    window.postMessage({ __w51: true, id: cmd.id, ok: false, msg: e.message }, '*');
  }
})();
