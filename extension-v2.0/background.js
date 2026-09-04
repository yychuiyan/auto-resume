// background.js — 复用原扩展的 BOSS 批量打招呼
const LOG_LIMIT = 80;

function makeProgress(platform, data) {
  chrome.storage.local.set({ [platform + '_progress']: data });
}

function addLog(platform, logs, t, msg, color) {
  const tag = ({ boss: 'BOSS', zp: '智联', w51: '前程' })[platform] || '';
  const text = tag ? '[' + tag + '] ' + msg : msg;
  logs.push({ t, msg: text, color: color || '#888' });
  if (logs.length > LOG_LIMIT) logs.shift();
}

async function bossBatch(jobs, cookieStr, minInt, maxInt) {
  const progress = { running: true, idx: 0, total: jobs.length, okC: 0, failC: 0, currentName: '', status: '准备中...', logs: [] };
  makeProgress('boss', progress);

  let okC = 0, failC = 0;
  const log = (m, c) => addLog('boss', progress.logs, new Date().toLocaleTimeString('zh-CN', { hour12: false }), m, c);

  log('=== 开始 ' + jobs.length + ' 个 ===', '#8b949e');

  for (let i = 0; i < jobs.length; i++) {
    const s = await chrome.storage.local.get('boss_cancel');
    if (s.boss_cancel) {
      log('⏹ 已取消', '#f87171');
      await chrome.storage.local.remove('boss_cancel');
      break;
    }

    const j = jobs[i], idx = i + 1;
    const encryptId = j.encryptId || (j.url || '').match(/job_detail\/([a-zA-Z0-9_-]+)/)?.[1] || '';
    if (!encryptId) { failC++; log('[' + idx + '] ❌ 无法提取ID', '#f87171'); continue; }

    progress.idx = idx; progress.currentName = j.name; progress.status = '投递中...';
    progress.okC = okC; progress.failC = failC;
    makeProgress('boss', progress);

    const cmdId = Date.now() + '_' + idx;
    const cmdData = { type: 'greet', id: cmdId, encryptId, cookies: cookieStr };
    if (j.securityId) cmdData.securityId = j.securityId;
    if (j.lid) cmdData.lid = j.lid;

    await chrome.storage.local.set({ cmd: cmdData });

    const result = await waitStorage('result', cmdId, 15000);
    if (!result) { failC++; log('[' + idx + '] ❌ 超时', '#f87171'); }
    else if (result.ok) {
      okC++;
      log('[' + idx + '] ✅ ' + j.name + ' | ' + (result.msg || '已发送'), '#4ade80');
      const today = new Date().toISOString().substring(0, 10);
      const cntKey = 'boss_cnt_' + today;
      const cnt = await chrome.storage.local.get(cntKey);
      const n = (cnt[cntKey] || 0) + 1;
      await chrome.storage.local.set({ [cntKey]: n });
    }
    else {
      failC++;
      log('[' + idx + '] ❌ ' + result.msg, '#f87171');
      if (result.msg && (result.msg.includes('请稍候') || result.msg.includes('hasCaptcha=true'))) {
        log('⚠️ BOSS 风控，已停止', '#f87171');
        break;
      }
    }

    progress.okC = okC; progress.failC = failC;
    makeProgress('boss', progress);

    if (i < jobs.length - 1) {
      const delay = minInt + Math.floor(Math.random() * (maxInt - minInt + 1));
      progress.status = '等 ' + delay + 's...';
      makeProgress('boss', progress);
      for (let d = 0; d < delay * 2; d++) {
        await new Promise(r => setTimeout(r, 500));
        const cs = await chrome.storage.local.get('boss_cancel');
        if (cs.boss_cancel) break;
      }
      const cs = await chrome.storage.local.get('boss_cancel');
      if (cs.boss_cancel) { log('⏹ 已取消', '#f87171'); await chrome.storage.local.remove('boss_cancel'); break; }
    }
  }

  log('=== ' + okC + '成功 / ' + failC + '失败 ===', '#8b949e');
  progress.running = false;
  progress.okC = okC; progress.failC = failC;
  progress.status = okC + '成功 / ' + failC + '失败';
  makeProgress('boss', progress);
  await chrome.storage.local.remove('cmd');
}

async function zpBatch(jobs, cookieStr, at, rt, resumeNumber, cityIds, staffId, minInt, maxInt) {
  const progress = { running: true, idx: 0, total: jobs.length, okC: 0, failC: 0, currentName: '', status: '准备中...', logs: [] };
  makeProgress('zp', progress);

  let okC = 0, failC = 0;
  const log = (m, c) => addLog('zp', progress.logs, new Date().toLocaleTimeString('zh-CN', { hour12: false }), m, c);

  log('=== 智联开始 ' + jobs.length + ' 个 ===', '#8b949e');

  for (let i = 0; i < jobs.length; i++) {
    const s = await chrome.storage.local.get('zp_cancel');
    if (s.zp_cancel) { log('⏹ 已取消', '#f87171'); await chrome.storage.local.remove('zp_cancel'); break; }

    const j = jobs[i], idx = i + 1;
    const jobNumber = j.jobId || (j.url || '').match(/jobdetail\/([a-zA-Z0-9]+)/)?.[1] || '';
    if (!jobNumber) { failC++; log('[' + idx + '] ❌ 缺少jobNumber', '#f87171'); continue; }

    progress.idx = idx; progress.currentName = j.name; progress.status = '投递中...';
    progress.okC = okC; progress.failC = failC;
    makeProgress('zp', progress);

    const cmdId = Date.now() + '_z' + idx;
    const actionId = crypto.randomUUID();
    const jobRootOrgId = j.rootOrgId || '';
    const jobStaffId = j.staffId || staffId || 0;
    const jobCityIds = j.cityId ? [String(j.cityId)] : cityIds;
    await chrome.storage.local.set({ zcmd: {
      type: 'apply', id: cmdId, jobNumber, at, rt, resumeNumber,
      cityIds: jobCityIds, staffId: jobStaffId, rootOrgId: jobRootOrgId,
      actionId, cookies: cookieStr,
    }});

    const result = await waitStorage('zresult', cmdId, 20000);
    if (!result) { failC++; log('[' + idx + '] ❌ 超时', '#f87171'); }
    else if (result.ok) {
      okC++;
      log('[' + idx + '] ✅ ' + j.name + ' | ' + (result.msg || '已投递'), '#4ade80');
      const today = new Date().toISOString().substring(0, 10);
      const cntKey = 'zp_cnt_' + today;
      const cnt = await chrome.storage.local.get(cntKey);
      const n = (cnt[cntKey] || 0) + 1;
      await chrome.storage.local.set({ [cntKey]: n });
    }
    else { failC++; log('[' + idx + '] ❌ ' + result.msg, '#f87171'); }

    progress.okC = okC; progress.failC = failC;
    makeProgress('zp', progress);

    if (i < jobs.length - 1) {
      const delay = minInt + Math.floor(Math.random() * (maxInt - minInt + 1));
      progress.status = '等 ' + delay + 's...';
      makeProgress('zp', progress);
      for (let d = 0; d < delay * 2; d++) {
        await new Promise(r => setTimeout(r, 500));
        const cs = await chrome.storage.local.get('zp_cancel');
        if (cs.zp_cancel) break;
      }
      const cs = await chrome.storage.local.get('zp_cancel');
      if (cs.zp_cancel) { log('⏹ 已取消', '#f87171'); await chrome.storage.local.remove('zp_cancel'); break; }
    }
  }

  log('=== ' + okC + '成功 / ' + failC + '失败 ===', '#8b949e');
  progress.running = false;
  progress.okC = okC; progress.failC = failC;
  progress.status = okC + '成功 / ' + failC + '失败';
  makeProgress('zp', progress);
  await chrome.storage.local.remove('zcmd');
}

async function waitTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 12000);
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch (_) { return false; }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function w51EnsureSearchPage(tabId, searchUrl) {
  if (!searchUrl) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    if (/xyz\.51job\.com|consumer\/pc\/resume/i.test(url) || !url.includes('/pc/search')) {
      await chrome.tabs.update(tabId, { url: searchUrl });
      await waitTabLoad(tabId, 20000);
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch (_) {}
}

async function waitW51List(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 18000);
  while (Date.now() < deadline) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => document.querySelectorAll('.joblist-item button.btn.apply, .joblist-item button.apply').length,
      });
      if ((res && res[0] && res[0].result) > 0) return true;
    } catch (_) { return false; }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function w51CreateApplyTab(searchUrl) {
  if (!searchUrl) throw new Error('缺少搜索页地址');
  const t = await chrome.tabs.create({ url: searchUrl, active: false });
  await waitTabLoad(t.id, 25000);
  await new Promise(r => setTimeout(r, 800));
  const ok = await waitW51List(t.id, 18000);
  if (!ok) throw new Error('后台搜索页未出现申请按钮');
  return t.id;
}

async function w51ApplyOnListTab(applyTabId, job) {
  const jobId = String(job.jobId || '');
  const listIndex = job.listIndex;
  let resumed = false;
  const onUpdated = (id, info) => {
    if (id !== applyTabId || !info.url) return;
    if (/xyz\.51job\.com|consumer\/pc\/resume/i.test(info.url)) resumed = true;
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    const clickRes = await Promise.race([
      chrome.scripting.executeScript({
    target: { tabId: applyTabId },
    world: 'MAIN',
    func: async (params) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cards = document.querySelectorAll('.joblist-item');
      let card = null;
      if (params.listIndex != null && cards[params.listIndex]) card = cards[params.listIndex];
      if (!card && params.jobId) {
        for (const c of cards) {
          if (c.outerHTML.includes(String(params.jobId))) { card = c; break; }
        }
      }
      if (!card) {
        return { ok: false, msg: '未找到列表项 item=' + cards.length };
      }
      const btn = card.querySelector('button.btn.apply, button.apply');
      if (!btn) return { ok: false, msg: '未找到申请按钮' };
      const txt = () => String(btn.textContent || btn.innerText || '').trim();
      if (/已申请|已投递|重复申请/.test(txt())) return { ok: true, msg: '已投递' };
      if (/网申|官网|外部|完善简历|选择简历|填写简历/.test(txt())) {
        return { ok: false, msg: '简历投递(按钮:' + txt() + ')' };
      }
      const as = card.querySelectorAll('a');
      const pe = [];
      as.forEach((a) => { pe.push(a.style.pointerEvents); a.style.pointerEvents = 'none'; });
      const oo = window.open;
      window.open = () => null;
      btn.click();
      const clickConfirm = () => {
        const nodes = document.querySelectorAll('button, .el-button, .btn, a');
        for (const n of nodes) {
          const t = String(n.textContent || '').trim();
          if (/^(确定|确认|立即申请|申请职位|投递)$/.test(t)) { n.click(); return true; }
        }
        return false;
      };
      let success = false;
      for (let i = 0; i < 16; i++) {
        await sleep(400);
        if (/xyz\.51job\.com|consumer\/pc\/resume/i.test(location.href)) {
          window.open = oo;
          return { ok: false, msg: '简历投递(需完善简历/选简历)' };
        }
        if (i === 2 || i === 5) clickConfirm();
        const fresh = document.querySelectorAll('.joblist-item');
        let c = (params.listIndex != null && fresh[params.listIndex]) ? fresh[params.listIndex] : null;
        if (!c && params.jobId) {
          for (const x of fresh) {
            if (x.outerHTML.includes(String(params.jobId))) { c = x; break; }
          }
        }
        const b = c && c.querySelector('button.btn.apply, button.apply');
        if (b && /已申请|已投递|重复申请/.test(b.textContent || '')) { success = true; break; }
      }
      window.open = oo;
      as.forEach((a, i) => { a.style.pointerEvents = pe[i]; });
      if (success) return { ok: true, msg: '已投递' };
      if (!location.href.includes('/pc/search')) {
        return { ok: false, msg: '页面跳转(已离开搜索列表)' };
      }
      return { ok: false, msg: '列表点击后未变成已申请' };
    },
    args: [{ jobId, listIndex }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('列表点击超时')), 12000)),
    ]);
    if (resumed) return { ok: false, msg: '简历投递(需完善简历/选简历)', needReset: true };
    try {
      const t = await chrome.tabs.get(applyTabId);
      if (!t.url || /xyz\.51job\.com|consumer\/pc\/resume/i.test(t.url) || !t.url.includes('/pc/search')) {
        return { ok: false, msg: '简历投递(需完善简历/选简历)', needReset: true };
      }
    } catch (_) {
      return { ok: false, msg: '简历投递(后台页已关闭)', needReset: true };
    }
    const result = (clickRes && clickRes[0] && clickRes[0].result) || { ok: false, msg: '脚本无返回' };
    if (/简历投递|页面跳转/.test(result.msg || '')) result.needReset = true;
    return result;
  } catch (e) {
    if (resumed) return { ok: false, msg: '简历投递(需完善简历/选简历)', needReset: true };
    return { ok: false, msg: e.message || String(e), needReset: true };
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

async function w51Batch(jobs, cookieStr, tabId, minInt, maxInt, searchUrlHint) {
  const progress = { running: true, idx: 0, total: jobs.length, okC: 0, failC: 0, currentName: '', status: '准备中...', logs: [] };
  makeProgress('w51', progress);

  let okC = 0, failC = 0;
  const log = (m, c) => addLog('w51', progress.logs, new Date().toLocaleTimeString('zh-CN', { hour12: false }), m, c);

  if (!tabId) {
    log('❌ 请打开已登录的 we.51job.com 搜索页', '#f87171');
    progress.running = false;
    progress.status = '缺少前程页面';
    makeProgress('w51', progress);
    return;
  }

  log('=== 前程开始 ' + jobs.length + ' 个 ===', '#8b949e');
  log('后台复制搜索页点申请，你正在看的页面不会被点击', '#8b949e');

  let searchUrl = searchUrlHint || '';
  if (!searchUrl) {
    const saved = await chrome.storage.local.get('w51_search_url');
    searchUrl = saved.w51_search_url || '';
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.includes('/pc/search')) searchUrl = tab.url;
  } catch (_) {}

  const onNavGuard = (id, info) => {
    if (id !== tabId || !info.url || !searchUrl) return;
    if (/xyz\.51job\.com|consumer\/pc\/resume/i.test(info.url)) {
      chrome.tabs.update(tabId, { url: searchUrl }).catch(() => {});
    }
  };
  chrome.tabs.onUpdated.addListener(onNavGuard);

  let applyTabId = null;
  const resetApplyTab = async () => {
    if (applyTabId) {
      try { await chrome.tabs.remove(applyTabId); } catch (_) {}
      applyTabId = null;
    }
  };
  const ensureApplyTab = async () => {
    if (applyTabId) {
      try {
        const t = await chrome.tabs.get(applyTabId);
        if (t.url && t.url.includes('/pc/search')) return applyTabId;
      } catch (_) {
        applyTabId = null;
      }
    }
    applyTabId = await w51CreateApplyTab(searchUrl);
    return applyTabId;
  };

  try {
    await ensureApplyTab();
    for (let i = 0; i < jobs.length; i++) {
      const s = await chrome.storage.local.get('w51_cancel');
      if (s.w51_cancel) { log('⏹ 已取消', '#f87171'); await chrome.storage.local.remove('w51_cancel'); break; }

      const j = jobs[i], idx = i + 1;
      const jobId = j.jobId || (j.url || '').match(/(?:jobId=|\/)(\d{6,})/)?.[1] || '';
      if (!jobId) { failC++; log('[' + idx + '] ❌ 缺少jobId', '#f87171'); continue; }

      if (j.resumeFlow) {
        log('[' + idx + '] ⏭ ' + j.name + ' | 简历投递(匹配已过滤)', '#fbbf24');
        progress.idx = idx; progress.currentName = j.name;
        progress.okC = okC; progress.failC = failC;
        makeProgress('w51', progress);
        continue;
      }

      progress.idx = idx; progress.currentName = j.name; progress.status = '投递中...';
      progress.okC = okC; progress.failC = failC;
      makeProgress('w51', progress);

      let result;
      try {
        const aid = await ensureApplyTab();
        result = await w51ApplyOnListTab(aid, j);
        if (result.needReset) await resetApplyTab();
      } catch (e) {
        result = { ok: false, msg: e.message || String(e) };
        await resetApplyTab();
      }
      if (result.ok) {
        okC++;
        log('[' + idx + '] ✅ ' + j.name + ' | ' + (result.msg || '已投递'), '#4ade80');
        const today = new Date().toISOString().substring(0, 10);
        const cntKey = 'w51_cnt_' + today;
        const cnt = await chrome.storage.local.get(cntKey);
        await chrome.storage.local.set({ [cntKey]: (cnt[cntKey] || 0) + 1 });
      } else {
        const skip = /简历投递|页面跳转/.test(result.msg || '');
        if (skip) {
          log('[' + idx + '] ⏭ ' + j.name + ' | ' + (result.msg || '已跳过'), '#fbbf24');
        } else {
          failC++;
          log('[' + idx + '] ❌ ' + (result.msg || '投递失败'), '#f87171');
        }
      }

      progress.okC = okC; progress.failC = failC;
      makeProgress('w51', progress);

      if (i < jobs.length - 1) {
        const delay = minInt + Math.floor(Math.random() * (maxInt - minInt + 1));
        progress.status = '等 ' + delay + 's...';
        makeProgress('w51', progress);
        for (let d = 0; d < delay * 2; d++) {
          await new Promise(r => setTimeout(r, 500));
          const cs = await chrome.storage.local.get('w51_cancel');
          if (cs.w51_cancel) break;
        }
        const cs = await chrome.storage.local.get('w51_cancel');
        if (cs.w51_cancel) { log('⏹ 已取消', '#f87171'); await chrome.storage.local.remove('w51_cancel'); break; }
      }
    }

    log('=== ' + okC + '成功 / ' + failC + '失败 ===', '#8b949e');
    progress.running = false;
    progress.okC = okC; progress.failC = failC;
    progress.status = okC + '成功 / ' + failC + '失败';
    makeProgress('w51', progress);
  } catch (e) {
    log('❌ 批量异常: ' + (e.message || ''), '#f87171');
    progress.running = false;
    makeProgress('w51', progress);
  } finally {
    chrome.tabs.onUpdated.removeListener(onNavGuard);
    if (applyTabId) {
      try { await chrome.tabs.remove(applyTabId); } catch (_) {}
    }
    await chrome.storage.local.remove('wcmd');
  }
}

function waitStorage(key, cmdId, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = async () => {
      const s = await chrome.storage.local.get(key);
      const r = s[key];
      if (r && r.id === cmdId) { await chrome.storage.local.remove(key); resolve(r); return; }
      if (Date.now() - start > timeout) { resolve(null); return; }
      setTimeout(check, 500);
    };
    check();
  });
}

function siteFromUrl(url) {
  if (!url) return '';
  if (url.includes('zhaopin.com')) return 'zhaopin';
  if (url.includes('51job.com')) return '51job';
  if (url.includes('zhipin.com')) return 'boss';
  return '';
}

function sidePanelPath(_site) {
  return 'popup.html';
}

async function syncSidePanel(tabId, url) {
  if (!tabId || tabId < 0) return;
  const u = url || '';
  if (u.startsWith('chrome://') || u.startsWith('chrome-extension://')) return;
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: sidePanelPath(siteFromUrl(u)),
      enabled: true,
    });
  } catch (_) {}
}

function initSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => initSidePanel());
chrome.runtime.onStartup.addListener(() => initSidePanel());
initSidePanel();

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncSidePanel(tabId, tab.url);
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  syncSidePanel(tabId, tab.url);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'boss_start') {
    bossBatch(msg.jobs, msg.cookieStr, msg.min, msg.max);
    sendResponse({ ok: true });
  } else if (msg.action === 'zp_start') {
    zpBatch(msg.jobs, msg.cookieStr, msg.at, msg.rt, msg.resumeNumber, msg.cityIds, msg.staffId, msg.min, msg.max);
    sendResponse({ ok: true });
  } else if (msg.action === 'w51_start') {
    w51Batch(msg.jobs, msg.cookieStr, msg.tabId, msg.min, msg.max, msg.searchUrl);
    sendResponse({ ok: true });
  }
});
