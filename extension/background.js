// background.js — 后台批量投递服务
const LOG_LIMIT = 80;

function makeProgress(platform, data) {
  chrome.storage.local.set({ [platform + '_progress']: data });
}

function addLog(platform, logs, t, msg, color) {
  logs.push({ t, msg, color: color || '#888' });
  if (logs.length > LOG_LIMIT) logs.shift();
}

// ==================== BOSS ====================
async function bossBatch(jobs, cookieStr, minInt, maxInt) {
  const progress = { running: true, idx: 0, total: jobs.length, okC: 0, failC: 0, currentName: '', status: '准备中...', logs: [] };
  makeProgress('boss', progress);

  let okC = 0, failC = 0;
  const log = (m, c) => addLog('boss', progress.logs, new Date().toLocaleTimeString('zh-CN', { hour12: false }), m, c);

  log('=== 开始 ' + jobs.length + ' 个 ===', '#8b949e');

  for (let i = 0; i < jobs.length; i++) {
    // 检查取消
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

    // 等待结果
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
      // 分片等待，便于取消检测
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

// ==================== 智联 ====================
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
    await chrome.storage.local.set({ zcmd: {
      type: 'apply', id: cmdId, jobNumber, at, rt, resumeNumber,
      cityIds, staffId, actionId: '', cookies: cookieStr,
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

// 消息入口
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'boss_start') {
    bossBatch(msg.jobs, msg.cookieStr, msg.min, msg.max);
    sendResponse({ ok: true });
  } else if (msg.action === 'zp_start') {
    zpBatch(msg.jobs, msg.cookieStr, msg.at, msg.rt, msg.resumeNumber, msg.cityIds, msg.staffId, msg.min, msg.max);
    sendResponse({ ok: true });
  }
});
