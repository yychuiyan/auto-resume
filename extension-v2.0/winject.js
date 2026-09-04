// winject.js — 前程：API 投递 → 列表点击；拦截 xyz 简历页跳转
(async () => {
  const divs = document.querySelectorAll('[id^="__w51_data_"]');
  const div = divs[divs.length - 1];
  if (!div) return;
  const cmd = JSON.parse(div.getAttribute('data-cmd'));
  const jobId = String(cmd.jobId || '');
  const ctmId = String(cmd.ctmId || '');
  const done = (ok, msg) => window.postMessage({ __w51: true, id: cmd.id, ok, msg }, '*');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RESUME_PAGE = /xyz\.51job\.com|consumer\/pc\/resume/i;
  const startHref = location.href;

  const onResumePage = () => RESUME_PAGE.test(location.href);
  const backFromResume = () => {
    if (!onResumePage()) return false;
    try { history.back(); } catch (_) {}
    return true;
  };

  const parseApplyJson = (json) => {
    if (!json || typeof json !== 'object') return null;
    const msg = String(json.message || json.msg || json.resultmsg || json.resultMsg || '');
    const st = json.status ?? json.code ?? json.result;
    if (/已申请|已投递|申请成功|投递成功|重复申请/.test(msg)) return { ok: true, msg: msg || '已投递' };
    if ((st === 1 || st === '1') && msg && !/失败|错误|不能|无法|登录|限制|完善|简历/.test(msg)) {
      return { ok: true, msg: msg || '已投递' };
    }
    if (/失败|错误|不能|无法|登录|限制|完善|简历/.test(msg)) return { ok: false, msg };
    if (msg) return { ok: false, msg };
    return null;
  };

  const tryApiApply = async () => {
    const hdr = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Referer: location.href.includes('51job.com') ? location.href : 'https://we.51job.com/pc/search',
      Origin: 'https://we.51job.com',
    };
    const ts = Date.now();
    const posts = [
      { url: 'https://we.51job.com/api/job/apply-pc?api_key=51job&timestamp=' + ts, body: { jobId, ctmId, jobid: jobId, ctmid: ctmId } },
      { url: 'https://we.51job.com/api/job/apply-pc?api_key=51job&timestamp=' + (ts + 1), body: { jobId, ctmId, prd: '51job_web', cd: '51job_web' } },
    ];
    for (const p of posts) {
      try {
        const r = await fetch(p.url, { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify(p.body) });
        const t = await r.text();
        if (!t || t.trim().charAt(0) !== '{') continue;
        const verdict = parseApplyJson(JSON.parse(t));
        if (verdict) return verdict;
      } catch (_) {}
    }
    if (jobId && ctmId) {
      try {
        const u = 'https://we.51job.com/api/job/apply-get?api_key=51job&timestamp=' + ts
          + '&jobId=' + encodeURIComponent(jobId) + '&ctmId=' + encodeURIComponent(ctmId);
        const r = await fetch(u, { credentials: 'include', headers: hdr });
        const t = await r.text();
        if (t && t.trim().charAt(0) === '{') {
          const verdict = parseApplyJson(JSON.parse(t));
          if (verdict) return verdict;
        }
      } catch (_) {}
    }
    return null;
  };

  const findCard = () => {
    const cards = document.querySelectorAll('.joblist-item');
    if (cmd.listIndex != null && cards[cmd.listIndex]) return cards[cmd.listIndex];
    if (jobId) {
      for (const c of cards) {
        if (c.outerHTML.includes(jobId)) return c;
      }
    }
    return null;
  };

  const isAppliedBtn = (btn) => btn && /已申请|已投递|重复申请/.test(String(btn.textContent || btn.innerText || ''));

  try {
    if (cmd.resumeFlow) {
      done(false, '简历投递(匹配已过滤，跳过)');
      return;
    }

    const apiResult = await tryApiApply();
    if (apiResult?.ok) {
      done(true, apiResult.msg);
      return;
    }
    if (apiResult && !apiResult.ok && /完善|简历/.test(apiResult.msg)) {
      done(false, '简历投递(已跳过): ' + apiResult.msg);
      return;
    }

    const card = findCard();
    if (!card) {
      done(false, apiResult?.msg || '未找到列表项');
      return;
    }
    const btn = card.querySelector('button.btn.apply');
    if (!btn) {
      done(false, apiResult?.msg || '未找到申请按钮');
      return;
    }
    if (isAppliedBtn(btn)) {
      done(true, '已投递');
      return;
    }
    const btnText = String(btn.textContent || btn.innerText || '').trim();
    if (/网申|官网|外部|完善简历|选择简历/.test(btnText)) {
      done(false, '简历投递(按钮: ' + btnText + ')');
      return;
    }

    const as = card.querySelectorAll('a');
    const pe = [];
    as.forEach((a) => { pe.push(a.style.pointerEvents); a.style.pointerEvents = 'none'; });
    const oo = window.open;
    window.open = () => null;
    btn.click();

    let success = false;
    let resumeHit = false;
    for (let i = 0; i < 16; i++) {
      await sleep(400);
      if (onResumePage()) {
        resumeHit = true;
        backFromResume();
        await sleep(600);
        break;
      }
      const c = findCard();
      if (c) {
        const b = c.querySelector('button.btn.apply');
        if (isAppliedBtn(b)) { success = true; break; }
      }
    }

    window.open = oo;
    as.forEach((a, i) => { a.style.pointerEvents = pe[i]; });

    if (resumeHit || onResumePage()) {
      backFromResume();
      done(false, '简历投递(已跳过，未离开搜索页)');
      return;
    }
    if (location.href !== startHref && !location.href.includes('/pc/search')) {
      try { history.back(); } catch (_) {}
      done(false, '页面跳转(已回退)');
      return;
    }
    if (success) {
      done(true, '已投递');
      return;
    }
    done(false, apiResult?.msg || '未确认投递成功');
  } catch (e) {
    if (onResumePage()) backFromResume();
    done(false, e.message || String(e));
  }
})();
