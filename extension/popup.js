let isRunning = false, allJobs = [];
let sessionLogs = [];

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function log(msg, color) {
  const el = document.getElementById('log');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  sessionLogs.push({ t, msg, color: color || '#888' });
  if (!el) return;
  const line = document.createElement('div');
  line.innerHTML = `<span style="color:#555">${t}</span> <span style="color:${color || '#888'}">${escHtml(msg)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function ok(m) { log('✅ ' + m, '#4ade80'); }
function err(m) { log('❌ ' + m, '#f87171'); }
function info(m) { log('ℹ️ ' + m, '#8b949e'); }

function replayLogs(logs) {
  const el = document.getElementById('log');
  if (!el || !logs.length) return;
  el.innerHTML = logs.map(l =>
    `<div><span style="color:#555">${l.t}</span> <span style="color:${l.color}">${escHtml(l.msg)}</span></div>`
  ).join('');
  el.scrollTop = el.scrollHeight;
}

function showCancel(id) { const b = document.getElementById(id); if (b) b.style.display = ''; }
function hideCancel(id) { const b = document.getElementById(id); if (b) b.style.display = 'none'; }

let countBoss = 0, countZp = 0;
const today = new Date().toISOString().substring(0, 10);

function addCount(platform, n) {
  const key = platform + '_cnt_' + today;
  if (platform === 'boss') countBoss += n;
  else if (platform === 'zp') countZp += n;
  chrome.storage.local.set({ [key]: platform === 'boss' ? countBoss : countZp });
  updateCountDisplay();
}

function updateCountDisplay() {
  const b = document.getElementById('cntBoss'), z = document.getElementById('cntZp');
  if (b) b.textContent = countBoss;
  if (z) z.textContent = countZp;
}

function saveSession(platform, data) {
  if (data._logs) { data.logs = data._logs; delete data._logs; }
  else data.logs = sessionLogs.slice(-50);
  chrome.storage.local.set({ [platform + '_ses_' + today]: data });
}

async function restoreSession(platform) {
  const s = await chrome.storage.local.get(platform + '_ses_' + today);
  return s[platform + '_ses_' + today] || null;
}

function renderBossList(jobs) {
  const jl = document.getElementById('jobList');
  if (!jobs.length) { jl.style.display = 'none'; return; }
  jl.innerHTML = jobs.map((j, i) =>
    `<div style="padding:2px 0;border-bottom:1px solid #222;display:flex;gap:6px">
      <span style="color:#667eea;flex-shrink:0">${i+1}.</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${j.name}">${j.name}</span>
      ${j.securityId?'<span style="color:#4ade80;flex-shrink:0;font-size:10px">✔</span>':''}
    </div>`).join('');
  jl.style.display = 'block';
}

function renderZpList(jobs) {
  const jl = document.getElementById('zJobList');
  if (!jobs.length) { jl.style.display = 'none'; return; }
  jl.innerHTML = jobs.map((j, i) =>
    `<div style="padding:2px 0;border-bottom:1px solid #222;display:flex;gap:6px">
      <span style="color:#f5576c;flex-shrink:0">${i+1}.</span>
      <div style="flex:1;min-width:0">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.name}</div>
        ${j.company?`<div style="font-size:10px;color:#888">${j.company} ${j.info||''}</div>`:''}
      </div>
    </div>`).join('');
  jl.style.display = 'block';
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.local.get(['boss_cnt_' + today, 'zp_cnt_' + today]);
  countBoss = s['boss_cnt_' + today] || 0;
  countZp = s['zp_cnt_' + today] || 0;
  updateCountDisplay();

  // 根据当前页面自动切Tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tabs[0]?.url || '';
  if (url.includes('zhipin.com')) switchTab('boss');
  else if (url.includes('zhaopin.com')) switchTab('zhaopin');

  // 恢复今日会话（两边都恢复，列表始终显示）
  const bossData = await restoreSession('boss');
  const zpData = await restoreSession('zp');

  // 恢复数据但不显示列表（仅后台保留，等用户重新抓取时再用）
  if (bossData && bossData.jobs) {
    allJobs = bossData.jobs;
    document.getElementById('min').value = bossData.min || 3;
    document.getElementById('max').value = bossData.max || 5;
  }

  if (zpData && zpData.jobs) {
    zAllJobs = zpData.jobs;
    document.getElementById('zMin').value = zpData.min || 3;
    document.getElementById('zMax').value = zpData.max || 5;
  }

  // 检测后台进度 → 优先恢复日志
  const bossProg = await chrome.storage.local.get('boss_progress');
  const zpProg = await chrome.storage.local.get('zp_progress');

  if (bossProg.boss_progress && bossProg.boss_progress.running) {
    isRunning = true; document.getElementById('btnStart').disabled = true;
    document.getElementById('prog').style.display = ''; showCancel('bCancel');
    pollProgress('boss');
  } else if (bossProg.boss_progress && !bossProg.boss_progress.running) {
    const bp = bossProg.boss_progress;
    if (bp.logs && bp.logs.length) { saveSession('boss', { jobs: allJobs.length ? allJobs : (bossData && bossData.jobs || []), okC: bp.okC||0, failC: bp.failC||0, batchDone: true, min: 3, max: 5, fetchTime: Date.now(), _logs: bp.logs }); }
    await chrome.storage.local.remove('boss_progress');
  }

  if (zpProg.zp_progress && zpProg.zp_progress.running) {
    zIsRunning = true; document.getElementById('zStart').disabled = true;
    document.getElementById('zProg').style.display = ''; showCancel('zCancel');
    pollProgress('zp');
  } else if (zpProg.zp_progress && !zpProg.zp_progress.running) {
    const zpp = zpProg.zp_progress;
    if (zpp.logs && zpp.logs.length) { saveSession('zp', { jobs: zAllJobs.length ? zAllJobs : (zpData && zpData.jobs || []), okC: zpp.okC||0, failC: zpp.failC||0, batchDone: true, min: 3, max: 5, fetchTime: Date.now(), _logs: zpp.logs }); }
    await chrome.storage.local.remove('zp_progress');
  }

  // 重新加载session（可能被recovery更新了）
  const finalBoss = await restoreSession('boss');
  const finalZp = await restoreSession('zp');

  // 恢复当前Tab日志
  const curData = (activeTab === 'zhaopin' ? finalZp : finalBoss);
  if (curData && curData.logs && curData.logs.length) { sessionLogs = curData.logs; replayLogs(curData.logs); }
  // === Tab 切换 ===
  document.getElementById('tabBoss').addEventListener('click', () => switchTab('boss'));
  document.getElementById('tabZhaopin').addEventListener('click', () => switchTab('zhaopin'));
  // === BOSS ===
  document.getElementById('btnFetch').addEventListener('click', fetchJobs);
  document.getElementById('btnStart').addEventListener('click', startBatch);
  document.getElementById('bProbe').addEventListener('click', bProbe);
  document.getElementById('bCancel').addEventListener('click', () => { chrome.storage.local.set({ boss_cancel: true }); err('⏹ 取消中...'); });

  // === 智联 ===
  document.getElementById('zFetch').addEventListener('click', zFetch);
  document.getElementById('zStart').addEventListener('click', zStartBatch);
  document.getElementById('zProbe').addEventListener('click', zProbe);
  document.getElementById('zCancel').addEventListener('click', () => { chrome.storage.local.set({ zp_cancel: true }); err('⏹ 取消中...'); });

  // 清除日志按钮
  document.querySelectorAll('.clear-log').forEach(b => {
    b.addEventListener('click', () => {
      document.getElementById('log').innerHTML = '';
      sessionLogs = [];
      // 同时清除当前Tab的session日志
      saveSession(activeTab, { jobs: activeTab === 'boss' ? allJobs : zAllJobs, fetchTime: Date.now() });
    });
  });

  loadSettings();
});

let activeTab = 'boss';

function switchTab(platform) {
  // 切走前保存当前Tab日志
  if (activeTab !== platform) {
    saveSession(activeTab, { jobs: activeTab === 'boss' ? allJobs : zAllJobs, fetchTime: Date.now() });
  }
  activeTab = platform;
  document.getElementById('tabBoss').classList.toggle('active', platform === 'boss');
  document.getElementById('tabZhaopin').classList.toggle('active', platform === 'zhaopin');
  document.getElementById('panelBoss').classList.toggle('active', platform === 'boss');
  document.getElementById('panelZhaopin').classList.toggle('active', platform === 'zhaopin');
  // 恢复目标Tab日志
  restoreSession(platform).then(data => {
    if (data && data.logs) { sessionLogs = data.logs; replayLogs(data.logs); }
    else { document.getElementById('log').innerHTML = ''; sessionLogs = []; }
  });
}

async function loadSettings() {
  const s = await chrome.storage.local.get(['minInt', 'maxInt']);
  document.getElementById('min').value = s.minInt || 3;
  document.getElementById('max').value = s.maxInt || 5;
}

async function fetchJobs() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab.url?.includes('zhipin.com')) {
    document.getElementById('fetchInfo').textContent = '请切换到 BOSS 搜索页';
    return;
  }
  const btn = document.getElementById('btnFetch');
  btn.disabled = true; btn.textContent = '⏳ 抓取...';

  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const jobs = []; const seen = new Set();

      // === 策略 A：调搜索 API 拿完整数据（含 securityId） ===
      let apiDiag = 'url=' + window.location.href.substring(0, 80);
      try {
        // 尝试多种方式拿搜索关键词
        let query = '', city = '';
        // 方式1: URL query string
        const usp = new URLSearchParams(window.location.search);
        query = usp.get('query') || '';
        city = usp.get('city') || '';
        // 方式2: hash 中的 query（SPA路由）
        if (!query && window.location.hash) {
          const hq = window.location.hash.match(/[?&]query=([^&]+)/);
          if (hq) query = decodeURIComponent(hq[1]);
          const hc = window.location.hash.match(/[?&]city=([^&]+)/);
          if (hc) city = decodeURIComponent(hc[1]);
        }
        // 方式3: 从 __INITIAL_STATE__ 取
        if (!query) {
          try {
            const st = document.querySelector('script');
            for (const s of document.querySelectorAll('script')) {
              const m = s.textContent.match(/(?:query|keyword|searchWord)["']?\s*[:=]\s*["']([^"']+)["']/);
              if (m) { query = m[1]; break; }
            }
          } catch (_) {}
        }
        apiDiag += ' query=' + query + ' city=' + city;
        if (query) {
          const apiUrl = '/wapi/zpgeek/search/joblist.json?site=1&query=' + encodeURIComponent(query)
            + '&city=' + encodeURIComponent(city) + '&page=' + (usp.get('page') || '1') + '&pageSize=30&experience=&degree=&industry=&scale=&stage=&position=';
          const apiRes = await fetch(apiUrl);
          apiDiag = 'status=' + apiRes.status;
          if (apiRes.ok) {
            const json = await apiRes.json();
            apiDiag += ' code=' + json.code;
            if (json.zpData) {
              const jl = json.zpData.jobList || json.zpData.list || [];
              apiDiag += ' jobCount=' + jl.length;
              // 看第一个 job 有哪些字段
              if (jl.length) {
                apiDiag += ' firstKeys=' + Object.keys(jl[0]).slice(0, 15).join(',');
                apiDiag += ' hasSecId=' + (typeof jl[0].securityId !== 'undefined');
                apiDiag += ' hasEncrypt=' + (typeof (jl[0].encryptJobId || jl[0].encryptId) !== 'undefined');
              }
            }
            if (json.code === 0 && json.zpData) {
              const jobList = json.zpData.jobList || json.zpData.list || [];
              for (const j of jobList) {
                const href = 'https://www.zhipin.com/job_detail/' + (j.encryptJobId || j.encryptId || '') + '.html';
                if (seen.has(href)) continue;
                seen.add(href);
                jobs.push({
                  url: href,
                  name: (j.jobName || j.title || '').trim().substring(0, 50),
                  encryptId: j.encryptJobId || j.encryptId || '',
                  securityId: j.securityId || '',
                  lid: j.lid || '',
                });
              }
            }
          }
        }
      } catch (_) {}

      // === 策略 B：DOM 抓取兜底 ===
      if (!jobs.length) {
        for (const card of document.querySelectorAll('.job-card-body, [class*="job-card"], li[class*="job"]')) {
          const link = card.querySelector('a[href*="job_detail"]');
          if (!link) continue;
          const href = link.href;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const name = (card.querySelector('.job-name, [class*="job-name"], .name, h3')?.textContent || '').trim().substring(0, 50);
          const encryptId = href.match(/job_detail\/([a-zA-Z0-9_-]+)/)?.[1] || '';
          jobs.push({ url: href, name, encryptId, securityId: '', lid: '' });
        }
      }
      return { jobs, apiDiag };
    },
  });
  const rawResult = (res && res[0]?.result) || {};
  allJobs = rawResult.jobs || [];
  if (rawResult.apiDiag) info('搜索API: ' + rawResult.apiDiag);
  ok(`抓取到 ${allJobs.length} 个职位`);
  document.getElementById('fetchInfo').textContent = `✅ ${allJobs.length} 个职位`;
  // 渲染职位列表
  const jl = document.getElementById('jobList');
  if (allJobs.length) {
    const hasSecCount = allJobs.filter(j => j.securityId).length;
    jl.innerHTML = allJobs.map((j, i) =>
      `<div style="padding:2px 0;border-bottom:1px solid #222;display:flex;gap:6px">
        <span style="color:#667eea;flex-shrink:0">${i + 1}.</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${j.name}">${j.name}</span>
        ${j.securityId ? '<span style="color:#4ade80;flex-shrink:0;font-size:10px">✔</span>' : ''}
      </div>`).join('');
    if (hasSecCount) ok(`其中 ${hasSecCount} 个职位已预取 securityId，可跳过详情页`);
    jl.style.display = 'block';
  } else {
    jl.style.display = 'none';
  }
  document.getElementById('total').textContent = allJobs.length;
  document.getElementById('cnt').value = allJobs.length;
  document.getElementById('cfg').style.display = '';
  btn.textContent = '🔍 重新抓取'; btn.disabled = false;
  saveSession('boss', { jobs: allJobs, min: parseInt(document.getElementById('min').value)||3, max: parseInt(document.getElementById('max').value)||5, fetchTime: Date.now() });
}

async function startBatch() {
  if (isRunning || !allJobs.length) return;
  const cnt = Math.min(parseInt(document.getElementById('cnt').value) || 5, allJobs.length);
  const jobs = allJobs.slice(0, cnt);
  const minInt = parseInt(document.getElementById('min').value) || 3;
  const maxInt = parseInt(document.getElementById('max').value) || 5;
  chrome.storage.local.set({ minInt, maxInt });

  // 委托 background 执行
  await chrome.storage.local.remove('boss_cancel');
  const tabs = await chrome.tabs.query({});
  const bossTab = tabs.find(t => t.url?.includes('zhipin.com'));
  if (!bossTab) { setStatus('请打开 BOSS 页面', 'er'); return; }
  const cookies = await chrome.cookies.getAll({ domain: '.zhipin.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
  if (!cookies.find(c => c.name === 'wt2')) { err('未登录 BOSS'); return; }

  isRunning = true;
  document.getElementById('btnStart').disabled = true;
  document.getElementById('prog').style.display = '';
  showCancel('bCancel');
  sessionLogs = [];
  chrome.runtime.sendMessage({ action: 'boss_start', jobs, cookieStr, min: minInt, max: maxInt });
  pollProgress('boss');
}

function updateBar(done, total, o, f) {
  document.getElementById('ptxt').textContent = `进度 ${done}/${total}（${o}✅/${f}❌）`;
  document.getElementById('pfill').style.width = `${Math.round(done / total * 100)}%`;
}

function pollProgress(platform) {
  const key = platform + '_progress';
  const isBoss = platform === 'boss';
  const timer = setInterval(async () => {
    const s = await chrome.storage.local.get(key);
    const p = s[key];
    if (!p) return;
    if (p.logs) {
      sessionLogs = [...p.logs];
      // 只在对应Tab活跃时更新DOM
      if ((isBoss && activeTab === 'boss') || (!isBoss && activeTab === 'zhaopin')) {
        const el = document.getElementById('log');
        if (el && p.logs.length) {
          el.innerHTML = p.logs.map(l =>
            `<div><span style="color:#555">${l.t}</span> <span style="color:${l.color}">${escHtml(l.msg)}</span></div>`
          ).join('');
          el.scrollTop = el.scrollHeight;
        }
      }
    }
    if (isBoss) {
      updateBar(p.idx, p.total, p.okC, p.failC);
      setStatus(p.status, p.running ? '' : (p.okC === p.total ? 'ok' : 'er'));
      if (!p.running) { clearInterval(timer); isRunning = false; document.getElementById('btnStart').disabled = false; hideCancel('bCancel'); saveSession('boss', { jobs: allJobs, okC: p.okC, failC: p.failC, batchDone: true, min: parseInt(document.getElementById('min').value)||3, max: parseInt(document.getElementById('max').value)||5, fetchTime: Date.now() }); }
    } else {
      zUpdateBar(p.idx, p.total, p.okC, p.failC);
      zSetStatus(p.status, p.running ? '' : (p.okC === p.total ? 'ok' : 'er'));
      if (!p.running) { clearInterval(timer); zIsRunning = false; document.getElementById('zStart').disabled = false; hideCancel('zCancel'); saveSession('zp', { jobs: zAllJobs, okC: p.okC, failC: p.failC, batchDone: true, min: parseInt(document.getElementById('zMin').value)||3, max: parseInt(document.getElementById('zMax').value)||5, fetchTime: Date.now() }); }
    }
    const today = new Date().toISOString().substring(0, 10);
    const cnt = await chrome.storage.local.get(['boss_cnt_' + today, 'zp_cnt_' + today]);
    countBoss = cnt['boss_cnt_' + today] || 0;
    countZp = cnt['zp_cnt_' + today] || 0;
    updateCountDisplay();
  }, 500);
}

function setStatus(text, cls) {
  const el = document.getElementById('pst');
  el.textContent = text; el.className = 'st ' + (cls || '');
}

function waitForResult(cmdId, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = async () => {
      const s = await chrome.storage.local.get('result');
      if (s.result?.id === cmdId) { await chrome.storage.local.remove('result'); resolve(s.result); return; }
      if (Date.now() - start > timeout) { resolve(null); return; }
      setTimeout(check, 300);
    };
    check();
  });
}

// 🔬 BOSS 诊断
async function bProbe() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab.url?.includes('zhipin.com')) {
    document.getElementById('fetchInfo').textContent = '请先切换到 BOSS 页面';
    return;
  }
  const btn = document.getElementById('bProbe');
  btn.textContent = '⏳...'; btn.disabled = true;

  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const d = {};
      d.url = window.location.href.substring(0, 100);

      // 搜素 API
      const usp = new URLSearchParams(window.location.search);
      const query = usp.get('query') || '';
      d.query = query;

      // 页面 script 中的关键数据
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent || '';
        if (t.includes('securityId')) {
          const m = t.match(/securityId["\s:=]+([A-Za-z0-9_-]+)/);
          d.hasSecurityId = !!m;
          if (m) d.securityIdSample = m[1];
        }
        if (t.includes('resumeNumber')) {
          d.hasResumeNum = true;
        }
      }

      // 当前页面的卡片数量
      d.cardCount = document.querySelectorAll('.job-card-body, [class*="job-card"], li[class*="job"]').length;

      return d;
    },
  });

  const d = (res && res[0]?.result) || {};
  info('BOSS诊断: ' + JSON.stringify(d).substring(0, 600));
  btn.textContent = '🔬 诊断'; btn.disabled = false;
}

// ==================== 智联招聘 ====================
let zIsRunning = false, zAllJobs = [];

// 🔬 探测页面结构
async function zProbe() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab.url?.includes('zhaopin.com')) {
    document.getElementById('zFetchInfo').textContent = '请切换到智联搜索页';
    return;
  }
  const btn = document.getElementById('zProbe');
  btn.disabled = true; btn.textContent = '⏳ 探测中...';

  // 注入网络拦截器 + 采集页面结构
  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const diag = {};

      // --- 安装拦截器 ---
      if (!window.__zl_probe_active) {
        window.__zl_probe_active = true;
        window.__zl_captured = [];
        const origFetch = window.fetch;
        window.fetch = function(...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          window.__zl_captured.push({ type: 'fetch', url: url.substring(0, 300), time: Date.now() });
          return origFetch.apply(this, args);
        };
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          window.__zl_captured.push({ type: 'xhr', method, url: url.substring(0, 300), time: Date.now() });
          return origOpen.apply(this, arguments);
        };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body) {
          if (body && typeof body === 'string') {
            const last = window.__zl_captured[window.__zl_captured.length - 1];
            if (last) last.body = body.substring(0, 1000);
          }
          return origSend.apply(this, arguments);
        };
      }

      // --- 读取已拦截的请求（保留全量数据） ---
      diag.captured = (window.__zl_captured || []).slice(-30);
      diag.captured = diag.captured.map(c => ({
        type: c.type, method: c.method || 'GET',
        url: (c.url || '').substring(0, 400),
        body: (c.body || '').substring(0, 1500),
      }));
      // 特别标出投递相关
      diag.deliveryAPIs = diag.captured.filter(c =>
        c.url.includes('deliver') || c.url.includes('apply') || c.url.includes('application') ||
        (c.body && c.body.includes('resumeNumber'))
      );
      window.__zl_captured = [];

      // --- 查 token ---
      diag.tokens = {};
      // 所有 cookie 里含 at/rt/token/resume 的
      diag.tokens.cookies = document.cookie.split(';').filter(c => /at=|rt=|token|resume|userId|staffId/i.test(c)).map(c => c.trim().substring(0, 120));
      // localStorage 全部 key
      diag.tokens.lsKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /at|rt|token|resume|user|staff|city/i.test(k)) {
          diag.tokens.lsKeys.push(k + '=' + (localStorage.getItem(k) || '').substring(0, 80));
        }
      }
      // 从 HTML/script 中找 at, rt, resumeNumber
      diag.tokens.fromHTML = '';
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent || '';
        for (const key of ['"at"', '"rt"', 'resumeNumber', 'cityIds', '"staffId"', 'userId']) {
          if (t.includes(key)) {
            const idx = t.indexOf(key);
            diag.tokens.fromHTML += key + ':' + t.substring(idx, idx + 80).replace(/\n/g, ' ') + ' | ';
          }
        }
      }
      diag.tokens.fromHTML = diag.tokens.fromHTML.substring(0, 600);
      // 页面 URL 本身
      diag.tokens.pageURL = window.location.href.substring(0, 120);

      // --- 分析"立即投递"按钮 ---
      const cards = document.querySelectorAll('.joblist-box__item');
      if (cards.length) {
        const first = cards[0];
        diag.cardHTML = first.outerHTML.substring(0, 1200);

        const applyBtns = first.querySelectorAll('[class*="apply"], [class*="collect-and-apply"], [class*="btninfo"], [class*="deliver"]');
        diag.applyButtons = [];
        for (const b of applyBtns) {
          let parents = '';
          let p = b.parentElement;
          for (let i = 0; i < 4 && p && p !== document.body; i++) {
            const tag = p.tagName;
            const id = p.id ? '#' + p.id : '';
            const cls = p.className ? '.' + (typeof p.className === 'string' ? p.className : '').substring(0, 50) : '';
            const oc = p.getAttribute('onclick') || '';
            parents += (i ? ' < ' : '') + tag + id + cls + (oc ? ' [onclick=' + oc.substring(0, 60) + ']' : '');
            p = p.parentElement;
          }
          diag.applyButtons.push({
            tag: b.tagName,
            class: (typeof b.className === 'string' ? b.className : '').substring(0, 80),
            text: b.textContent.trim().substring(0, 30),
            href: b.href || '',
            onclick: (b.getAttribute('onclick') || '').substring(0, 200),
            attrs: [...b.attributes].map(a => a.name + '=' + (a.value || '').substring(0, 80)).slice(0, 8),
            parents: parents.substring(0, 300),
          });
        }
      }

      // --- 找 script 中的 API ---
      diag.scriptAPIs = [];
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent || '';
        if (!t || t.length < 100) continue;
        const ms = t.match(/["'\/]([a-zA-Z][a-zA-Z0-9_\/-]{3,60}(?:api|apply|resume|deliver|job|position)[a-zA-Z0-9_\/-]*)["'\/]/gi) || [];
        for (const m of ms) {
          const c = m.replace(/["'\/]/g, '');
          if (!diag.scriptAPIs.includes(c) && diag.scriptAPIs.length < 15) diag.scriptAPIs.push(c);
        }
      }

      diag.hint = '点一次页面上的"立即投递"按钮，再回来点探测，就能看到 captured 的 API';
      return diag;
    },
  });

  const diag = (res && res[0]?.result) || {};
  const diagStr = JSON.stringify(diag);
  info('智联探测 tokens/cookies: ' + JSON.stringify(diag.tokens).substring(0, 500));
  info('智联探测 deliveryAPIs: ' + JSON.stringify(diag.deliveryAPIs).substring(0, 2000));
  info('智联探测 全量captured: ' + diagStr.substring(0, 3000));
  document.getElementById('zFetchInfo').textContent = diag.hint || '探测完成，看下方日志';
  btn.textContent = '🔬 重新探测'; btn.disabled = false;
}

// 抓取智联职位
async function zFetch() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab.url?.includes('zhaopin.com')) {
    document.getElementById('zFetchInfo').textContent = '请切换到智联搜索页';
    return;
  }
  const btn = document.getElementById('zFetch');
  btn.disabled = true; btn.textContent = '⏳ 抓取...';

  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const jobs = []; const seen = new Set();
      let apiDiag = '';

      // === 策略 A：调搜索 API ===
      try {
        // 从当前 URL 提取搜索参数
        const usp = new URLSearchParams(window.location.search);
        let keyword = usp.get('keyword') || usp.get('kw') || usp.get('query') || '';
        if (!keyword) {
          const hashMatch = window.location.hash.match(/keyword=([^&]+)/);
          if (hashMatch) keyword = decodeURIComponent(hashMatch[1]);
        }
        if (!keyword) {
          const inputEl = document.querySelector('input[placeholder*="搜索"], input[placeholder*="职位"],' +
            'input[placeholder*="search"], input[name="keyword"]');
          if (inputEl) keyword = inputEl.value;
        }

        if (keyword) {
          const apiUrl = '/sou/api/search?keyword=' + encodeURIComponent(keyword) + '&page=1&pageSize=30';
          const apiRes = await fetch(apiUrl);
          apiDiag = 'status=' + apiRes.status;
          if (apiRes.ok) {
            const json = await apiRes.json();
            apiDiag += ' code=' + (json.code || json.status || '?');
            // 尝试多种常见响应结构
            const list = json.data?.list || json.data?.results || json.data?.jobList
              || json.result?.list || json.result?.results || json.list || [];
            apiDiag += ' count=' + list.length;
            if (list.length) {
              apiDiag += ' firstKeys=' + Object.keys(list[0]).slice(0, 12).join(',');
            }
            for (const j of list) {
              const id = j.jobId || j.id || j.positionId || j.jobNumber || '';
              const href = 'https://www.zhaopin.com/jobdetail/' + id + '.html';
              if (seen.has(href)) continue;
              seen.add(href);
              jobs.push({
                url: href,
                name: (j.jobName || j.positionName || j.title || j.name || '').trim().substring(0, 50),
                jobId: id,
                company: (j.companyName || j.company || j.corpName || '').trim().substring(0, 30),
                info: (j.salary || j.salaryDesc || j.workCity || j.city || '').trim().substring(0, 40),
                apiData: j, // 保留原始数据
              });
            }
          }
        }
      } catch (e) { apiDiag = 'api_unavailable(用DOM兜底)'; }

      // === 策略 B：DOM 抓取兜底 ===
      if (!jobs.length) {
        for (const card of document.querySelectorAll('.joblist-box__item')) {
          const link = card.querySelector('a[href]');
          if (!link) continue;
          const href = link.href;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const nameEl = card.querySelector('[class*="job-name"], [class*="jobName"], [class*="title"], h3, .jobname');
          const coEl = card.querySelector('[class*="company"], [class*="corp"], [class*="comp"]');
          const infoEl = card.querySelector('[class*="salary"], [class*="pay"]');
          jobs.push({
            url: href,
            name: (nameEl?.textContent || link.textContent || '').trim().substring(0, 50),
            jobId: '',
            company: (coEl?.textContent || '').trim().substring(0, 30),
            info: (infoEl?.textContent || '').trim().substring(0, 40),
          });
        }
      }
      return { jobs, apiDiag };
    },
  });

  const raw = (res && res[0]?.result) || {};
  zAllJobs = raw.jobs || [];
  if (raw.apiDiag) info('智联搜索API: ' + raw.apiDiag);
  info(`智联抓取到 ${zAllJobs.length} 个职位`);
  document.getElementById('zFetchInfo').textContent = `✅ ${zAllJobs.length} 个职位`;

  const jl = document.getElementById('zJobList');
  if (zAllJobs.length) {
    const hasApi = zAllJobs.filter(j => j.apiData).length;
    jl.innerHTML = zAllJobs.map((j, i) =>
      `<div style="padding:2px 0;border-bottom:1px solid #222;display:flex;gap:6px">
        <span style="color:#f5576c;flex-shrink:0">${i + 1}.</span>
        <div style="flex:1;min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${j.name}">${j.name}</div>
          ${j.company ? `<div style="font-size:10px;color:#888">${j.company} ${j.info||''} ${j.apiData?'✔':''}</div>` : ''}
        </div>
      </div>`).join('');
    if (hasApi) ok(`智联搜索API已返回 ${hasApi} 个职位的完整数据`);
    jl.style.display = 'block';
  }
  document.getElementById('zTotal').textContent = zAllJobs.length;
  document.getElementById('zCnt').value = zAllJobs.length;
  document.getElementById('zCfg').style.display = '';
  btn.textContent = '🔍 重新抓取'; btn.disabled = false;
  saveSession('zp', { jobs: zAllJobs, min: parseInt(document.getElementById('zMin').value)||3, max: parseInt(document.getElementById('zMax').value)||5, fetchTime: Date.now() });
}

// 智联批量投递
async function zStartBatch() {
  if (zIsRunning || !zAllJobs.length) return;
  const cnt = Math.min(parseInt(document.getElementById('zCnt').value) || 5, zAllJobs.length);
  const jobs = zAllJobs.slice(0, cnt);
  const minInt = parseInt(document.getElementById('zMin').value) || 3;
  const maxInt = parseInt(document.getElementById('zMax').value) || 5;

  // 委托 background 执行
  await chrome.storage.local.remove('zp_cancel');
  const tabs = await chrome.tabs.query({});
  const zlTab = tabs.find(t => t.url?.includes('zhaopin.com'));
  if (!zlTab) { zSetStatus('请打开智联页面', 'er'); return; }

  const cookies = await chrome.cookies.getAll({ domain: '.zhaopin.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
  const at = cookies.find(c => c.name === 'at')?.value || '';
  const rt = cookies.find(c => c.name === 'rt')?.value || '';
  if (!at || !rt) { err('缺少 at/rt token'); return; }

  // 从页面取 resumeNumber
  const pageData = await chrome.scripting.executeScript({
    target: { tabId: zlTab.id }, world: 'MAIN',
    func: () => {
      const d = {};
      const html = document.documentElement.outerHTML;
      let m = html.match(/resumeNumber["\s:=]+([A-Za-z0-9_]+)/);
      if (!m) { for (const s of document.querySelectorAll('script')) { m = (s.textContent||'').match(/resumeNumber["\s:=]+([A-Za-z0-9_]+)/); if (m) break; } }
      if (m && m[1].length > 10) d.resumeNumber = m[1];
      const um = window.location.pathname.match(/\/jl(\d+)/);
      if (um) d.cityId = um[1];
      const sm = html.match(/staffId[^0-9]+(\d+)/);
      if (sm) d.staffId = parseInt(sm[1]);
      return d;
    },
  });
  const pd = (pageData && pageData[0]?.result) || {};
  const resumeNumber = pd.resumeNumber || '';
  const cityIds = [pd.cityId || '538'];
  const staffId = pd.staffId || 0;
  if (!resumeNumber) { err('未找到简历编号'); return; }

  zIsRunning = true;
  document.getElementById('zStart').disabled = true;
  document.getElementById('zProg').style.display = '';
  showCancel('zCancel');
  sessionLogs = [];
  chrome.runtime.sendMessage({ action: 'zp_start', jobs, cookieStr, at, rt, resumeNumber, cityIds, staffId, min: minInt, max: maxInt });
  pollProgress('zp');
}

function zUpdateBar(done, total, o, f) {
  document.getElementById('zPtxt').textContent = `进度 ${done}/${total}（${o}✅/${f}❌）`;
  document.getElementById('zPfill').style.width = `${Math.round(done / total * 100)}%`;
}

function zSetStatus(text, cls) {
  const el = document.getElementById('zPst');
  el.textContent = text; el.className = 'st ' + (cls || '');
}

function zWaitResult(cmdId, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = async () => {
      const s = await chrome.storage.local.get('zresult');
      if (s.zresult?.id === cmdId) { await chrome.storage.local.remove('zresult'); resolve(s.zresult); return; }
      if (Date.now() - start > timeout) { resolve(null); return; }
      setTimeout(check, 300);
    };
    check();
  });
}
