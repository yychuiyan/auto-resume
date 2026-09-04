// inject.js — BOSS API 调用（页面主环境，Cookie 自动带）
// 策略：1. 已有 securityId → 直接用  2. JSON API →  3. HTML兜底
(async () => {
  const divs = document.querySelectorAll('[id^="__boss_data_"]');
  const div = divs[divs.length - 1];
  if (!div) return;
  const cmd = JSON.parse(div.getAttribute('data-cmd'));

  const h = cmd.cookies ? { 'Cookie': cmd.cookies } : {};

  try {
    let secId = cmd.securityId || '';
    let lid = cmd.lid || '';
    let jobId = cmd.encryptId;

    // === 策略 1：有预设 securityId，直接跳过抓取 ===
    if (secId) {
      // 直接走打招呼接口
    } else {
      // === 策略 2：尝试 JSON API（不触发 HTML 风控） ===
      let apiLog = '';
      try {
        const apiRes = await fetch('/wapi/zpgeek/job/detail.json?jobId=' + jobId + '&securityId=&source=1');
        apiLog = 'status=' + apiRes.status;
        if (apiRes.ok) {
          const json = await apiRes.json();
          apiLog += ' code=' + json.code + ' hasZpData=' + !!json.zpData;
          // code!=0 时 zpData 可能仍有数据（如 code=37 限流但数据还在）
          if (json.zpData) {
            secId = json.zpData.securityId || '';
            lid = json.zpData.lid || '';
            apiLog += ' secId=' + (secId ? 'YES' : 'NO');
          }
        }
      } catch (e) { apiLog = 'error:' + e.message; }

      if (secId) {
        // JSON API 成功
      } else {
        // === 策略 3：HTML 页面抓取（兜底） ===
        const r1 = await fetch('/job_detail/' + cmd.encryptId + '.html');
        const html = await r1.text();

        const fakeUrl = '?' + html.replace(/\n/g, '&').replace(/"/g, '=');
        const p = new URLSearchParams(fakeUrl);
        secId = p.get('securityId') || (html.match(/securityId["'=]+([a-zA-Z0-9_-]+)/) || [])[1] || '';
        lid = p.get('lid') || '';
        jobId = p.get('jobId') || cmd.encryptId;

        if (!secId) {
          // 诊断
          const hasCaptcha = /captcha|验证|滑块|swiper|geetest|verify|极验/i.test(html);
          const hasLogin = /login|登录|密码|password|手机号登录/i.test(html);
          const hasSecurityId = /securityId/i.test(html);
          const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '无title';
          window.postMessage({ __boss: true, id: cmd.id, ok: false,
            msg: '未找到securityId | api=[' + apiLog + '] | title=' + title.trim() + ' | htmlLength=' + html.length
              + ' | hasSecurityId=' + hasSecurityId + ' | hasCaptcha=' + hasCaptcha + ' | hasLogin=' + hasLogin
          }, '*');
          return;
        }
      }
    }

    // === 打招呼 ===
    let qs = 'securityId=' + secId + '&jobId=' + jobId + '&source=1';
    if (lid) qs += '&lid=' + lid;

    const r2 = await fetch('/wapi/zpgeek/friend/add.json?' + qs, { headers: h });
    const d2 = await r2.json();

    window.postMessage({ __boss: true, id: cmd.id, ok: d2.code === 0, msg: d2.code === 0 ? '已发送' : (d2.message || 'code=' + d2.code) }, '*');
  } catch (e) {
    window.postMessage({ __boss: true, id: cmd.id, ok: false, msg: e.message }, '*');
  }
})();
