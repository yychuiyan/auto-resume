let isRunning = false, zIsRunning = false, wIsRunning = false;
let allJobs = [], zAllJobs = [], wAllJobs = [];
let sessionLogs = [];
let activeTab = 'boss';
const LOG_LIMIT = 300;
const progressLogCursor = { boss: 0, zp: 0, w51: 0 };
const today = new Date().toISOString().substring(0, 10);

function dayCountKey(platform) {
  return platform + '_cnt_' + today;
}

async function refreshDayCounts() {
  const keys = [dayCountKey('boss'), dayCountKey('zp'), dayCountKey('w51'),
    'applied_ids_boss', 'applied_ids_zp', 'applied_ids_w51'];
  const s = await chrome.storage.local.get(keys);
  const nums = {
    boss: s[keys[0]] || 0,
    zp: s[keys[1]] || 0,
    w51: s[keys[2]] || 0,
  };
  const applied = {
    boss: Array.isArray(s.applied_ids_boss) ? s.applied_ids_boss.length : 0,
    zp: Array.isArray(s.applied_ids_zp) ? s.applied_ids_zp.length : 0,
    w51: Array.isArray(s.applied_ids_w51) ? s.applied_ids_w51.length : 0,
  };
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  set('cntBoss', nums.boss);
  set('cntZp', nums.zp);
  set('cntW51', nums.w51);
  set('dayBoss', nums.boss);
  set('dayZp', nums.zp);
  set('dayW51', nums.w51);
  set('appliedBoss', applied.boss);
  set('appliedZp', applied.zp);
  set('appliedW51', applied.w51);
}

async function clearAppliedIds(platform) {
  const key = 'applied_ids_' + platform;
  await chrome.storage.local.remove(key);
  await refreshDayCounts();
  const label = ({ boss: 'BOSS', zp: '智联', w51: '前程' })[platform] || platform;
  info(label + ' 本机已投名单已清空');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function renderLogs() {
  const el = document.getElementById('log');
  if (!el) return;
  el.innerHTML = sessionLogs.map(l =>
    `<div><span style="color:#555">${escHtml(l.t)}</span> <span style="color:${l.color || '#888'}">${escHtml(l.msg)}</span></div>`
  ).join('');
  el.scrollTop = el.scrollHeight;
}
function persistLogs() {
  if (sessionLogs.length > LOG_LIMIT) sessionLogs = sessionLogs.slice(-LOG_LIMIT);
  chrome.storage.local.set({ ui_logs: sessionLogs });
}
function log(msg, color) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  sessionLogs.push({ t, msg, color: color || '#888' });
  persistLogs();
  const el = document.getElementById('log');
  if (!el) return;
  const line = document.createElement('div');
  line.innerHTML = `<span style="color:#555">${t}</span> <span style="color:${color || '#888'}">${escHtml(msg)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function ok(m) { log('✅ ' + m, '#4ade80'); }
function err(m) { log('❌ ' + m, '#f87171'); }
function info(m) { log('ℹ️ ' + m, '#8b949e'); }

function mergeProgressLogs(platform, logs) {
  if (!logs || !logs.length) return;
  if (logs.length < progressLogCursor[platform]) progressLogCursor[platform] = 0;
  const fresh = logs.slice(progressLogCursor[platform]);
  progressLogCursor[platform] = logs.length;
  if (!fresh.length) return;
  sessionLogs = sessionLogs.concat(fresh);
  persistLogs();
  renderLogs();
}

function showCancel() { const b = document.getElementById('bCancel'); if (b) b.style.display = ''; }
function hideCancel() { const b = document.getElementById('bCancel'); if (b) b.style.display = 'none'; }

async function findSiteTab(hostPart) {
  const all = await chrome.tabs.query({});
  const hits = all.filter(t => t.url && t.url.includes(hostPart) && !t.url.startsWith('chrome-extension://'));
  return hits.find(t => t.active) || hits[0] || null;
}

function setFlash(id, msg, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'flash' + (kind ? ' ' + kind : '');
}

function formatSaveAt(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function setSavedFlash(id, label, ts) {
  if (!ts) return;
  setFlash(id, label + ' · ' + formatSaveAt(ts), 'ok');
}

async function markSaved(kind) {
  const ts = Date.now();
  const s = await chrome.storage.local.get('ui_save_at');
  const data = Object.assign({}, s.ui_save_at || {}, { [kind]: ts });
  await chrome.storage.local.set({ ui_save_at: data });
  if (kind === 'api') setSavedFlash('apiSaveMsg', '保存成功', ts);
  if (kind === 'profile') setSavedFlash('profileSaveMsg', '匹配规则已保存', ts);
}

async function clearSaved(kind) {
  const s = await chrome.storage.local.get('ui_save_at');
  const data = Object.assign({}, s.ui_save_at || {});
  delete data[kind];
  await chrome.storage.local.set({ ui_save_at: data });
  if (kind === 'profile') setFlash('profileSaveMsg', '', '');
  if (kind === 'api') setFlash('apiSaveMsg', '', '');
}

async function restoreSaveFlashes() {
  const s = await chrome.storage.local.get('ui_save_at');
  const data = s.ui_save_at || {};
  if (data.api) setSavedFlash('apiSaveMsg', '保存成功', data.api);
  if (data.profile) setSavedFlash('profileSaveMsg', '匹配规则已保存', data.profile);
}

function splitProfileList(s) {
  return String(s || '').split(/[,，、\n;；]+/).map(x => x.trim()).filter(Boolean);
}

function degreeBoxes() {
  return Array.from(document.querySelectorAll('#pfDegreeList input[data-degree]'));
}

function getSelectedDegrees() {
  const opts = (window.ResumeMatch && window.ResumeMatch.DEGREE_OPTS) || ['高中', '中专', '大专', '本科', '硕士', '博士'];
  const picked = degreeBoxes().filter(el => el.getAttribute('data-degree') !== '__all__' && el.checked)
    .map(el => el.getAttribute('data-degree'));
  if (!picked.length || picked.length >= opts.length) return [];
  return picked;
}

function setSelectedDegrees(list) {
  const opts = (window.ResumeMatch && window.ResumeMatch.DEGREE_OPTS) || ['高中', '中专', '大专', '本科', '硕士', '博士'];
  const want = [].concat(list || []).filter(d => opts.indexOf(d) >= 0);
  const all = !want.length || want.length >= opts.length;
  degreeBoxes().forEach((el) => {
    const v = el.getAttribute('data-degree');
    el.checked = all || v === '__all__' ? all : want.indexOf(v) >= 0;
  });
  const allBox = document.querySelector('#pfDegreeList input[data-degree="__all__"]');
  if (allBox) allBox.checked = all;
  const btn = document.getElementById('pfDegreeBtn');
  if (btn) btn.textContent = all ? '全部' : want.join('、');
}

function bindDegreePicker() {
  const wrap = document.getElementById('pfDegree');
  const btn = document.getElementById('pfDegreeBtn');
  const list = document.getElementById('pfDegreeList');
  if (!wrap || !btn || !list || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  list.addEventListener('click', (e) => e.stopPropagation());
  list.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const v = t.getAttribute('data-degree');
    if (v === '__all__') {
      if (t.checked) setSelectedDegrees([]);
      else {
        degreeBoxes().forEach((el) => { el.checked = false; });
        const b = document.getElementById('pfDegreeBtn');
        if (b) b.textContent = '全部';
      }
      return;
    }
    setSelectedDegrees(getSelectedDegrees());
  });
  document.addEventListener('click', () => wrap.classList.remove('open'));
}

function directionBoxes() {
  return Array.from(document.querySelectorAll('#pfDirectionList input[data-direction]'));
}

function getSelectedDirections() {
  const opts = (window.ResumeMatch && window.ResumeMatch.DIRECTION_OPTS) || ['软件', '硬件', 'AI测试'];
  const picked = directionBoxes().filter(el => el.getAttribute('data-direction') !== '__all__' && el.checked)
    .map(el => el.getAttribute('data-direction'));
  if (!picked.length || picked.length >= opts.length) return [];
  return picked;
}

function setSelectedDirections(list) {
  const opts = (window.ResumeMatch && window.ResumeMatch.DIRECTION_OPTS) || ['软件', '硬件', 'AI测试'];
  const want = [].concat(list || []).filter(d => opts.indexOf(d) >= 0);
  const all = !want.length || want.length >= opts.length;
  directionBoxes().forEach((el) => {
    const v = el.getAttribute('data-direction');
    el.checked = all || v === '__all__' ? all : want.indexOf(v) >= 0;
  });
  const allBox = document.querySelector('#pfDirectionList input[data-direction="__all__"]');
  if (allBox) allBox.checked = all;
  const btn = document.getElementById('pfDirectionBtn');
  if (btn) btn.textContent = all ? '全部' : want.join('、');
}

function bindDirectionPicker() {
  const wrap = document.getElementById('pfDirection');
  const btn = document.getElementById('pfDirectionBtn');
  const list = document.getElementById('pfDirectionList');
  if (!wrap || !btn || !list || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  list.addEventListener('click', (e) => e.stopPropagation());
  list.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const v = t.getAttribute('data-direction');
    if (v === '__all__') {
      if (t.checked) setSelectedDirections([]);
      else {
        directionBoxes().forEach((el) => { el.checked = false; });
        const b = document.getElementById('pfDirectionBtn');
        if (b) b.textContent = '全部';
      }
      return;
    }
    setSelectedDirections(getSelectedDirections());
  });
  document.addEventListener('click', () => wrap.classList.remove('open'));
}

function fillProfileEditor(p) {
  const box = document.getElementById('profileEditor');
  if (!box) return;
  if (!p || !(p.titles || []).length) {
    box.style.display = 'none';
    return;
  }
  document.getElementById('pfTitles').value = (p.titles || []).join(', ');
  document.getElementById('pfCity').value = p.city || '';
  document.getElementById('pfSkills').value = (p.skills || []).join('\n');
  document.getElementById('pfWork').value = (p.workKeywords || []).join('\n');
  const sal = document.getElementById('pfSalary');
  if (sal) sal.value = String(p.salaryMin > 0 ? p.salaryMin : 0);
  const sc = document.getElementById('pfScale');
  if (sc) sc.value = String(p.scaleMin > 0 ? p.scaleMin : 0);
  setSelectedDegrees(p.degrees || []);
  setSelectedDirections(p.directions || []);
  box.style.display = 'block';
}

function setResumeFold(open) {
  const card = document.getElementById('resumeCard');
  const caret = document.getElementById('resumeFoldCaret');
  if (!card) return;
  card.classList.toggle('collapsed', !open);
  if (caret) caret.textContent = open ? '收起' : '展开';
  chrome.storage.local.set({ ui_resume_open: !!open });
}

function renderResumeFoldSum(text) {
  const el = document.getElementById('resumeFoldSum');
  if (el) el.textContent = text || '';
}

function renderResumeFile(fileName) {
  const row = document.getElementById('resumeFileRow');
  const name = document.getElementById('resumeFileName');
  if (!row || !name) return;
  if (!fileName) {
    row.classList.remove('show');
    name.textContent = '';
    return;
  }
  name.textContent = fileName;
  name.title = fileName;
  row.classList.add('show');
}

async function renderResumeInfo() {
  const el = document.getElementById('resumeInfo');
  if (!el) return;
  try {
    const [p, upload] = await Promise.all([
      window.ResumeAI.loadProfile(),
      window.ResumeAI.loadResumeUpload(),
    ]);
    const fileName = (p && p.fileName) || (upload && upload.fileName) || '';
    renderResumeFile(fileName);
    if (p && (p.titles || []).length) {
      const when = p.parsedAt ? new Date(p.parsedAt).toLocaleString('zh-CN', { hour12: false }) : '';
      el.textContent = '解析成功' + (when ? ' · ' + when : '');
      renderResumeFoldSum((p.titles || []).slice(0, 2).join('/') + (p.city ? ' · ' + p.city : ''));
      fillProfileEditor(p);
      return;
    }
    fillProfileEditor(null);
    if (fileName) {
      el.textContent = '已上传，尚未解析。点「解析」生成匹配规则。';
      renderResumeFoldSum(fileName + ' · 未解析');
      return;
    }
    el.textContent = '尚未上传。先上传 .docx，再点解析。';
    renderResumeFoldSum('');
  } catch (_) {
    renderResumeFile('');
    renderResumeFoldSum('');
  }
}

const NEED_RESUME_MSG = '请先上传 Word 简历并解析后再操作';

async function requireUploadedResume() {
  const p = await window.ResumeAI.loadProfile();
  if (p && (p.titles || []).length) return true;
  const upload = await window.ResumeAI.loadResumeUpload();
  const msg = (upload && upload.fileName)
    ? '请先点击「解析」生成匹配规则'
    : NEED_RESUME_MSG;
  setFlash('resumeParseMsg', msg, 'er');
  err(msg);
  return false;
}

function resetMatchResults() {
  allJobs = [];
  zAllJobs = [];
  wAllJobs = [];
  const ids = ['fetchInfo', 'zFetchInfo', 'wFetchInfo'];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  const cfg = document.getElementById('cfg');
  const zCfg = document.getElementById('zCfg');
  const wCfg = document.getElementById('wCfg');
  if (cfg) cfg.style.display = 'none';
  if (zCfg) zCfg.style.display = 'none';
  if (wCfg) wCfg.style.display = 'none';
  renderBossList([]);
  renderZpList([]);
  renderW51List([]);
}

async function deleteResumeFile() {
  await window.ResumeAI.clearResume();
  resetMatchResults();
  renderResumeInfo();
  showThinkBox('', false);
  setFlash('resumeParseMsg', NEED_RESUME_MSG, 'er');
  await clearSaved('profile');
  err(NEED_RESUME_MSG);
}

async function saveApiSettings() {
  try {
    await window.ResumeAI.saveConfig({
      apiKey: document.getElementById('apiKey').value,
      baseUrl: document.getElementById('apiBase').value,
      model: document.getElementById('apiModel').value,
    });
    await markSaved('api');
    ok('DeepSeek 设置已保存');
  } catch (e) {
    setFlash('apiSaveMsg', e.message || String(e), 'er');
    err(e.message || String(e));
  }
}

async function loadApiSettings() {
  const c = await window.ResumeAI.loadConfig();
  document.getElementById('apiKey').value = c.apiKey || '';
  document.getElementById('apiBase').value = c.baseUrl || window.ResumeAI.DEFAULT_BASE;
  document.getElementById('apiModel').value = c.model || window.ResumeAI.DEFAULT_MODEL;
}

async function handleResumeUpload(file) {
  const btn = document.getElementById('btnUploadResume');
  const parseBtn = document.getElementById('btnParseResume');
  btn.disabled = true;
  if (parseBtn) parseBtn.disabled = true;
  btn.textContent = '⏳ 读取中...';
  try {
    info('正在读取 Word...');
    const text = await window.ResumeAI.extractDocxText(file);
    await window.ResumeAI.saveResumeUpload(text, file.name);
    resetMatchResults();
    renderResumeInfo();
    setFlash('resumeParseMsg', '已上传，请点击「解析」', 'ok');
    await clearSaved('profile');
    ok('已上传 ' + file.name + '，请点击「解析」');
  } catch (e) {
    setFlash('resumeParseMsg', e.message || String(e), 'er');
    err(e.message || String(e));
  }
  btn.disabled = false;
  if (parseBtn) parseBtn.disabled = false;
  btn.textContent = '上传 Word';
}

function showThinkBox(text, visible) {
  const box = document.getElementById('thinkBox');
  const el = document.getElementById('thinkText');
  if (!box || !el) return;
  if (!visible) {
    box.classList.remove('show');
    el.textContent = '';
    return;
  }
  box.classList.add('show');
  el.textContent = text || '思考中...';
  box.scrollTop = box.scrollHeight;
}

async function handleResumeParse() {
  const btn = document.getElementById('btnParseResume');
  const uploadBtn = document.getElementById('btnUploadResume');
  btn.disabled = true;
  if (uploadBtn) uploadBtn.disabled = true;
  btn.textContent = '⏳ 解析中...';
  showThinkBox('思考中...', true);
  try {
    const upload = await window.ResumeAI.loadResumeUpload();
    if (!String(upload && upload.text || '').trim()) throw new Error('请先上传 Word 简历');
    const cfg = await window.ResumeAI.loadConfig();
    if (!String(cfg.apiKey || '').trim()) throw new Error('请先点「API 设置」填写 DeepSeek Key');
    info('正在用 DeepSeek 解析简历...');
    const raw = await window.ResumeAI.parseResumeText(upload.text, cfg, (p) => {
      showThinkBox((p && p.thinking) || '思考中...', true);
    });
    const profile = window.ResumeMatch.extractProfile(JSON.stringify(raw));
    await window.ResumeAI.saveProfile(profile, { fileName: upload.fileName || '' });
    renderResumeInfo();
    setFlash('resumeParseMsg', '解析成功', 'ok');
    await markSaved('profile');
    ok('解析成功：' + profile.titles.join('/') + ' · ' + (profile.city || '城市未识别'));
  } catch (e) {
    setFlash('resumeParseMsg', e.message || String(e), 'er');
    err(e.message || String(e));
  }
  btn.disabled = false;
  if (uploadBtn) uploadBtn.disabled = false;
  btn.textContent = '解析';
}

async function saveProfileEdits() {
  try {
    const prev = await window.ResumeAI.loadProfile();
    const raw = {
      titles: splitProfileList(document.getElementById('pfTitles').value),
      city: document.getElementById('pfCity').value.trim(),
      skills: splitProfileList(document.getElementById('pfSkills').value),
      workKeywords: splitProfileList(document.getElementById('pfWork').value),
      salaryMin: parseInt(document.getElementById('pfSalary').value, 10) || 0,
      scaleMin: parseInt(document.getElementById('pfScale').value, 10) || 0,
      degrees: getSelectedDegrees(),
      directions: getSelectedDirections(),
    };
    if (!raw.titles.length) throw new Error('期望职位不能为空');
    const profile = window.ResumeMatch.extractProfile(JSON.stringify(raw));
    await window.ResumeAI.saveProfile(profile, { fileName: (prev && prev.fileName) || '' });
    fillProfileEditor(Object.assign({}, profile, { fileName: (prev && prev.fileName) || '' }));
    await markSaved('profile');
    ok('匹配规则已保存');
  } catch (e) {
    setFlash('profileSaveMsg', e.message || String(e), 'er');
    err(e.message || String(e));
  }
}

function switchTab(platform) {
  activeTab = platform;
  document.getElementById('tabBoss').classList.toggle('active', platform === 'boss');
  document.getElementById('tabZhaopin').classList.toggle('active', platform === 'zhaopin');
  document.getElementById('tab51').classList.toggle('active', platform === '51job');
  document.getElementById('panelBoss').classList.toggle('active', platform === 'boss');
  document.getElementById('panelZhaopin').classList.toggle('active', platform === 'zhaopin');
  document.getElementById('panel51').classList.toggle('active', platform === '51job');
}

function platformFromUrl(url) {
  const u = String(url || '');
  if (u.includes('zhaopin.com')) return 'zhaopin';
  if (u.includes('51job.com')) return '51job';
  if (u.includes('zhipin.com')) return 'boss';
  return '';
}

async function followActiveSite() {
  try {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const platform = platformFromUrl(tabs[0] && tabs[0].url);
    if (platform) switchTab(platform);
  } catch (_) {}
}

function renderBossList(jobs) {
  const jl = document.getElementById('jobList');
  if (!jobs.length) { jl.style.display = 'none'; return; }
  jl.innerHTML = jobs.map((j, i) =>
    `<div style="padding:2px 0;border-bottom:1px solid #222;display:flex;gap:6px">
      <span style="color:#667eea;flex-shrink:0">${i + 1}.</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${escHtml(j.name)}">${escHtml(j.name)}</span>
      ${j.score != null ? `<span style="color:#fbbf24;flex-shrink:0;font-size:10px">${j.score}</span>` : ''}
    </div>`).join('');
  jl.style.display = 'block';
}

function renderZpList(jobs) {
  const jl = document.getElementById('zJobList');
  if (!jobs.length) { jl.style.display = 'none'; return; }
  jl.innerHTML = jobs.map((j, i) =>
    `<div style="padding:2px 0;border-bottom:1px solid #222;display:flex;gap:6px">
      <span style="color:#f5576c;flex-shrink:0">${i + 1}.</span>
      <div style="flex:1;min-width:0">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.name)}</div>
        ${j.company ? `<div style="font-size:10px;color:#888">${escHtml(j.company)} ${escHtml(j.info || '')}</div>` : ''}
      </div>
      ${j.score != null ? `<span style="color:#fbbf24;flex-shrink:0;font-size:10px">${j.score}</span>` : ''}
    </div>`).join('');
  jl.style.display = 'block';
}

function applyBossJobs(jobs, extra) {
  allJobs = jobs;
  const infoEl = document.getElementById('fetchInfo');
  if (!jobs.length) {
    infoEl.textContent = extra && extra.listCount
      ? '精排后为 0 条，粗筛也没有可回退的结果。看下方日志。'
      : '匹配结果为 0 条。未搜到职位，或粗筛未过阈值。';
  } else if (extra && extra.fallback) {
    infoEl.textContent = `精排后为 0 条，已回退粗筛前 ${jobs.length} 条`;
  } else if (extra && extra.refineTotal) {
    infoEl.textContent = `✅ ${jobs.length} 个匹配职位（精排 ${extra.refinePassed}/${extra.refineTotal}）`;
  } else {
    infoEl.textContent = `✅ ${jobs.length} 个匹配职位`;
  }
  document.getElementById('total').textContent = jobs.length;
  document.getElementById('cnt').value = jobs.length;
  document.getElementById('cfg').style.display = jobs.length ? '' : 'none';
  renderBossList(jobs);
}

function applyZpJobs(jobs, extra) {
  zAllJobs = jobs;
  const infoEl = document.getElementById('zFetchInfo');
  if (!jobs.length) {
    infoEl.textContent = extra && extra.listCount
      ? '智联精排后为 0 条，粗筛也没有可回退的结果。看下方日志。'
      : '智联匹配为 0 条。可能被派遣/代招排除，或未过阈值。看下方日志。';
  } else if (extra && extra.fallback) {
    infoEl.textContent = `智联精排后为 0 条，已回退粗筛前 ${jobs.length} 条`;
  } else if (extra && extra.refineTotal) {
    infoEl.textContent = `✅ ${jobs.length} 个匹配职位（精排 ${extra.refinePassed}/${extra.refineTotal}，粗筛 ${extra.listCount}）`;
  } else {
    infoEl.textContent = `✅ ${jobs.length} 个匹配职位` + (extra && extra.listCount ? `（粗筛 ${extra.listCount}）` : '');
  }
  document.getElementById('zTotal').textContent = jobs.length;
  document.getElementById('zCnt').value = jobs.length;
  document.getElementById('zCfg').style.display = jobs.length ? '' : 'none';
  renderZpList(jobs);
}

function renderW51List(jobs) {
  const jl = document.getElementById('wJobList');
  if (!jobs.length) { jl.style.display = 'none'; return; }
  jl.innerHTML = jobs.map((j, i) =>
    `<div style="padding:2px 0;border-bottom:1px solid #222;display:flex;gap:6px">
      <span style="color:#34d399;flex-shrink:0">${i + 1}.</span>
      <div style="flex:1;min-width:0">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.name)}</div>
        ${j.company ? `<div style="font-size:10px;color:#888">${escHtml(j.company)} ${escHtml(j.info || '')}</div>` : ''}
      </div>
      ${j.score != null ? `<span style="color:#fbbf24;flex-shrink:0;font-size:10px">${j.score}</span>` : ''}
    </div>`).join('');
  jl.style.display = 'block';
}

function applyW51Jobs(jobs, extra) {
  wAllJobs = jobs;
  const infoEl = document.getElementById('wFetchInfo');
  if (!jobs.length) {
    infoEl.textContent = extra && extra.listCount
      ? '前程精排后为 0 条，粗筛也没有可回退的结果。看下方日志。'
      : '前程匹配为 0 条。可能被校招/不可选中/派遣排除，或未过阈值。看下方日志。';
  } else if (extra && extra.fallback) {
    infoEl.textContent = `前程精排后为 0 条，已回退粗筛前 ${jobs.length} 条`;
  } else if (extra && extra.refineTotal) {
    infoEl.textContent = `✅ ${jobs.length} 个匹配职位（精排 ${extra.refinePassed}/${extra.refineTotal}，粗筛 ${extra.listCount}）`;
  } else {
    infoEl.textContent = `✅ ${jobs.length} 个匹配职位` + (extra && extra.listCount ? `（粗筛 ${extra.listCount}）` : '');
  }
  document.getElementById('wTotal').textContent = jobs.length;
  document.getElementById('wCnt').value = jobs.length;
  document.getElementById('wCfg').style.display = jobs.length ? '' : 'none';
  renderW51List(jobs);
}

function setStatus(text, cls) {
  const el = document.getElementById('pst');
  el.textContent = text; el.className = 'st ' + (cls || '');
}
function zSetStatus(text, cls) {
  const el = document.getElementById('zPst');
  el.textContent = text; el.className = 'st ' + (cls || '');
}
function wSetStatus(text, cls) {
  const el = document.getElementById('wPst');
  el.textContent = text; el.className = 'st ' + (cls || '');
}

function showMatchProgress(platform, show) {
  const map = {
    boss: { prog: 'matchProg', fill: 'matchFill', txt: 'matchTxt' },
    zp: { prog: 'zMatchProg', fill: 'zMatchFill', txt: 'zMatchTxt' },
    w51: { prog: 'wMatchProg', fill: 'wMatchFill', txt: 'wMatchTxt' },
  };
  const ids = map[platform];
  if (!ids) return;
  const el = document.getElementById(ids.prog);
  if (el) el.style.display = show ? '' : 'none';
}

function startMatchProgressPoll(platform) {
  const key = platform + '_match_progress';
  const cfg = {
    boss: { fill: 'matchFill', txt: 'matchTxt', status: setStatus },
    zp: { fill: 'zMatchFill', txt: 'zMatchTxt', status: zSetStatus },
    w51: { fill: 'wMatchFill', txt: 'wMatchTxt', status: wSetStatus },
  }[platform];
  showMatchProgress(platform, true);
  return setInterval(async () => {
    const s = await chrome.storage.local.get(key);
    const p = s[key];
    if (!p) return;
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    const fill = document.getElementById(cfg.fill);
    const txt = document.getElementById(cfg.txt);
    if (fill) fill.style.width = pct + '%';
    if (txt) txt.textContent = `精排 ${p.done}/${p.total}（已通过 ${p.passed}）`;
    if (p.running) cfg.status('精排 ' + p.done + '/' + p.total, '');
  }, 350);
}

function stopMatchProgressPoll(platform, timer) {
  clearInterval(timer);
  showMatchProgress(platform, false);
  chrome.storage.local.remove(platform + '_match_progress');
}

function pollProgress(platform) {
  const key = platform + '_progress';
  const timer = setInterval(async () => {
    const s = await chrome.storage.local.get(key);
    const p = s[key];
    if (!p) return;
    if (p.logs) mergeProgressLogs(platform, p.logs);
    refreshDayCounts();
    if (platform === 'boss') {
      document.getElementById('ptxt').textContent = `进度 ${p.idx}/${p.total}（${p.okC}✅/${p.failC}❌）`;
      document.getElementById('pfill').style.width = `${Math.round(p.idx / p.total * 100)}%`;
      setStatus(p.status, p.running ? '' : (p.okC === p.total ? 'ok' : 'er'));
      if (!p.running) {
        clearInterval(timer); isRunning = false;
        document.getElementById('btnStart').disabled = false; hideCancel();
      }
    } else if (platform === 'zp') {
      document.getElementById('zPtxt').textContent = `进度 ${p.idx}/${p.total}（${p.okC}✅/${p.failC}❌）`;
      document.getElementById('zPfill').style.width = `${Math.round(p.idx / p.total * 100)}%`;
      zSetStatus(p.status, p.running ? '' : (p.okC === p.total ? 'ok' : 'er'));
      if (!p.running) {
        clearInterval(timer); zIsRunning = false;
        document.getElementById('zStart').disabled = false; hideCancel();
      }
    } else {
      document.getElementById('wPtxt').textContent = `进度 ${p.idx}/${p.total}（${p.okC}✅/${p.failC}❌）`;
      document.getElementById('wPfill').style.width = `${Math.round(p.idx / p.total * 100)}%`;
      wSetStatus(p.status, p.running ? '' : (p.okC === p.total ? 'ok' : 'er'));
      if (!p.running) {
        clearInterval(timer); wIsRunning = false;
        document.getElementById('wStart').disabled = false; hideCancel();
      }
    }
  }, 500);
}

async function fetchBossByResume() {
  if (!(await requireUploadedResume())) {
    document.getElementById('fetchInfo').textContent = NEED_RESUME_MSG;
    return;
  }
  const tab = await findSiteTab('zhipin.com');
  if (!tab?.url?.includes('zhipin.com')) {
    document.getElementById('fetchInfo').textContent = '请切换到已登录的 BOSS 页面';
    err('请先打开 zhipin.com');
    return;
  }
  const btn = document.getElementById('btnMatch');
  btn.disabled = true; btn.textContent = '⏳ 匹配中...';
  const matchPoll = startMatchProgressPoll('boss');
  try {
    const { jobs, stopped, fallback, listCount, refineTotal, refinePassed } = await window.ResumeMatch.run({ tabId: tab.id, log: info });
    applyBossJobs(jobs, { fallback, listCount, refineTotal, refinePassed });
    if (!jobs.length) err('匹配后为 0 条。请看上方提示和日志。');
    else if (fallback) {
      err('精排后为 0 条，已回退粗筛（' + jobs.length + ' 条）。');
      ok('匹配完成 ' + jobs.length + ' 条（回退）' + (stopped ? '（遇风控提前结束）' : ''));
    } else ok('匹配完成 ' + jobs.length + ' 条' + (stopped ? '（遇风控提前结束）' : ''));
  } catch (e) {
    err(e.message || String(e));
    document.getElementById('fetchInfo').textContent = e.message || '匹配失败';
  }
  stopMatchProgressPoll('boss', matchPoll);
  btn.textContent = '📄 读取简历并匹配职位';
  btn.disabled = false;
}

async function fetchZpByResume() {
  if (!(await requireUploadedResume())) {
    document.getElementById('zFetchInfo').textContent = NEED_RESUME_MSG;
    return;
  }
  const tab = await findSiteTab('zhaopin.com');
  if (!tab?.url?.includes('zhaopin.com')) {
    document.getElementById('zFetchInfo').textContent = '请切换到已登录的智联页面';
    err('请先打开 zhaopin.com');
    return;
  }
  const btn = document.getElementById('zBtnMatch');
  btn.disabled = true; btn.textContent = '⏳ 匹配中...';
  const matchPoll = startMatchProgressPoll('zp');
  try {
    const { jobs, listCount, fallback, stopped, refineTotal, refinePassed } = await window.ResumeMatch.runZhaopin({ tabId: tab.id, log: info });
    applyZpJobs(jobs, { listCount, fallback, refineTotal, refinePassed });
    if (!jobs.length) err('智联匹配为 0 条。请看上方提示和日志（派遣/代招、精排或阈值）。');
    else if (fallback) {
      err('智联精排后为 0 条，已回退粗筛（' + jobs.length + ' 条）。');
      ok('智联匹配完成 ' + jobs.length + ' 条（回退）' + (stopped ? '（遇风控提前结束）' : ''));
    } else ok('智联匹配完成 ' + jobs.length + ' 条' + (stopped ? '（遇风控提前结束）' : ''));
  } catch (e) {
    err(e.message || String(e));
    document.getElementById('zFetchInfo').textContent = e.message || '匹配失败';
  }
  stopMatchProgressPoll('zp', matchPoll);
  btn.textContent = '📄 读取简历并匹配职位';
  btn.disabled = false;
}

async function startBossBatch() {
  if (!(await requireUploadedResume())) return;
  if (isRunning || !allJobs.length) return;
  const cnt = Math.min(parseInt(document.getElementById('cnt').value) || 5, allJobs.length);
  const jobs = allJobs.slice(0, cnt);
  const minInt = parseInt(document.getElementById('min').value) || 3;
  const maxInt = parseInt(document.getElementById('max').value) || 5;
  chrome.storage.local.set({ minInt, maxInt });

  await chrome.storage.local.remove('boss_cancel');
  const tabs = await chrome.tabs.query({});
  const bossTab = tabs.find(t => t.url?.includes('zhipin.com'));
  if (!bossTab) { setStatus('请打开 BOSS 页面', 'er'); return; }
  try { await chrome.scripting.executeScript({ target: { tabId: bossTab.id }, files: ['content.js'] }); } catch (_) {}
  const cookies = await chrome.cookies.getAll({ domain: '.zhipin.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
  if (!cookies.find(c => c.name === 'wt2')) { err('未登录 BOSS'); return; }

  isRunning = true;
  document.getElementById('btnStart').disabled = true;
  document.getElementById('prog').style.display = '';
  showCancel();
  progressLogCursor.boss = 0;
  chrome.runtime.sendMessage({ action: 'boss_start', jobs, cookieStr, min: minInt, max: maxInt });
  pollProgress('boss');
}

async function resolveZpResume(zlTab, at, rt) {
  const pageData = await chrome.scripting.executeScript({
    target: { tabId: zlTab.id }, world: 'MAIN',
    func: () => {
      const d = {};
      const patterns = [
        /resumeNumber["'\s:=]+([A-Za-z0-9_-]+)/,
        /"resumeNumber"\s*:\s*"([^"]+)"/,
        /resumeId["'\s:=]+([A-Za-z0-9_-]+)/,
      ];
      const allText = document.documentElement.outerHTML;
      for (const re of patterns) {
        const m = allText.match(re);
        if (m && m[1] && m[1].length > 3) { d.resumeNumber = m[1]; d._src = 'html'; break; }
      }
      if (!d.resumeNumber) {
        for (const store of [localStorage, sessionStorage]) {
          try {
            for (let i = 0; i < store.length; i++) {
              const k = store.key(i);
              if (!k || !/resume/i.test(k)) continue;
              const v = store.getItem(k) || '';
              try {
                const parsed = JSON.parse(v);
                const rn = parsed.resumeNumber || parsed.resumeId || parsed.number || '';
                if (rn && String(rn).length > 3) { d.resumeNumber = String(rn); d._src = 'ls:' + k; break; }
              } catch (_) {
                if (v.length > 3 && v.length < 200) { d.resumeNumber = v; d._src = 'ls_raw:' + k; break; }
              }
            }
          } catch (_) {}
          if (d.resumeNumber) break;
        }
      }
      const um = window.location.pathname.match(/\/jl(\d+)/);
      if (um) d.cityId = um[1];
      const sm = document.documentElement.outerHTML.match(/staffId[^0-9]+(\d+)/);
      if (sm) d.staffId = parseInt(sm[1]);
      return d;
    },
  });
  const pd = (pageData && pageData[0] && pageData[0].result) || {};
  let resumeNumber = pd.resumeNumber || '';
  const cityIds = [pd.cityId || '538'];
  let staffId = pd.staffId || 0;
  if (resumeNumber) { info('简历编号来源: ' + (pd._src || '页面')); return { resumeNumber, cityIds, staffId }; }

  info('页面未找到简历编号，尝试 API...');
  const tokenQS = 'at=' + encodeURIComponent(at) + '&rt=' + encodeURIComponent(rt) + '&_v=' + Date.now();
  const apiRes = await chrome.scripting.executeScript({
    target: { tabId: zlTab.id }, world: 'MAIN',
    func: async (params) => {
      try {
        const { qs, at, rt } = params;
        const r = await fetch('https://fe-api.zhaopin.com/c/pc/alan/jobs/application/preparation?' + qs, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ at, rt, jobCount: 1, rootOrgId: '', staffId: 0, isShowAttachmentSelect: true, actionId: '' }),
        });
        const j = await r.json();
        const data = j.data || {};
        const arr = data.resumes || data.resumeList || [];
        let rn = (arr[0] && (arr[0].number || arr[0].resumeNumber || arr[0].resumeId)) || '';
        if (!rn && data.defaultResume) rn = data.defaultResume.number || data.defaultResume.resumeNumber || '';
        if (!rn) rn = data.resumeNumber || data.resumeId || data.number || '';
        if (rn) return { resumeNumber: String(rn), src: 'api:preparation' };
        const json = JSON.stringify(data);
        const m = json.match(/"resumeNumber"\s*:\s*"([^"]{4,})"/) || json.match(/"number"\s*:\s*"([A-Za-z0-9_-]{20,})"/);
        if (m) return { resumeNumber: m[1], src: 'api:preparation(deep)' };
        return { _resBody: json.substring(0, 300) };
      } catch (e) { return { _err: e.message }; }
    },
    args: [{ qs: tokenQS, at, rt }],
  });
  const ar = (apiRes && apiRes[0] && apiRes[0].result) || {};
  if (ar.resumeNumber) { info('简历编号来源: ' + ar.src); resumeNumber = ar.resumeNumber; }
  else if (ar._err) info('API错误(preparation): ' + ar._err);
  else if (ar._resBody) info('API诊断(preparation): ' + ar._resBody);
  return { resumeNumber, cityIds, staffId };
}

async function startZpBatch() {
  if (!(await requireUploadedResume())) return;
  if (zIsRunning || !zAllJobs.length) return;
  const cnt = Math.min(parseInt(document.getElementById('zCnt').value) || 5, zAllJobs.length);
  const jobs = zAllJobs.slice(0, cnt);
  const minInt = parseInt(document.getElementById('zMin').value) || 3;
  const maxInt = parseInt(document.getElementById('zMax').value) || 5;

  await chrome.storage.local.remove('zp_cancel');
  const tabs = await chrome.tabs.query({});
  const zlTab = tabs.find(t => t.url?.includes('zhaopin.com'));
  if (!zlTab) { zSetStatus('请打开智联页面', 'er'); return; }
  try { await chrome.scripting.executeScript({ target: { tabId: zlTab.id }, files: ['zcontent.js'] }); } catch (_) {}

  const cookies = await chrome.cookies.getAll({ domain: '.zhaopin.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
  const at = (cookies.find(c => c.name === 'at') || {}).value || '';
  const rt = (cookies.find(c => c.name === 'rt') || {}).value || '';
  if (!at || !rt) { err('缺少 at/rt token'); return; }

  const resolved = await resolveZpResume(zlTab, at, rt);
  if (!resolved.resumeNumber) { err('未找到智联简历编号（页面+API均失败）'); return; }

  zIsRunning = true;
  document.getElementById('zStart').disabled = true;
  document.getElementById('zProg').style.display = '';
  showCancel();
  progressLogCursor.zp = 0;
  chrome.runtime.sendMessage({
    action: 'zp_start', jobs, cookieStr, at, rt,
    resumeNumber: resolved.resumeNumber, cityIds: resolved.cityIds, staffId: resolved.staffId,
    min: minInt, max: maxInt,
  });
  pollProgress('zp');
}

async function fetchW51ByResume() {
  if (!(await requireUploadedResume())) {
    document.getElementById('wFetchInfo').textContent = NEED_RESUME_MSG;
    return;
  }
  const tab = await findSiteTab('we.51job.com');
  if (!tab?.url?.includes('we.51job.com')) {
    document.getElementById('wFetchInfo').textContent = '请打开 we.51job.com 搜索页并手动搜出职位';
    err('请先打开 we.51job.com 搜索页');
    return;
  }
  if (!tab.url.includes('/pc/search')) {
    document.getElementById('wFetchInfo').textContent = '请在搜索页（/pc/search）看到列表后再匹配';
    err('请在前程搜索页操作');
    return;
  }
  const btn = document.getElementById('wBtnMatch');
  btn.disabled = true; btn.textContent = '⏳ 匹配中...';
  const matchPoll = startMatchProgressPoll('w51');
  try {
    const { jobs, listCount, fallback, stopped, refineTotal, refinePassed } = await window.ResumeMatch.run51job({ tabId: tab.id, log: info });
    applyW51Jobs(jobs, { listCount, fallback, refineTotal, refinePassed });
    if (!jobs.length) err('前程匹配为 0 条。请看上方提示和日志（校招、不可选中、派遣或阈值）。');
    else if (fallback) {
      err('前程精排后为 0 条，已回退粗筛（' + jobs.length + ' 条）。');
      ok('前程匹配完成 ' + jobs.length + ' 条（回退）' + (stopped ? '（遇风控提前结束）' : ''));
    } else ok('前程匹配完成 ' + jobs.length + ' 条' + (stopped ? '（遇风控提前结束）' : ''));
  } catch (e) {
    err(e.message || String(e));
    document.getElementById('wFetchInfo').textContent = e.message || '匹配失败';
  }
  stopMatchProgressPoll('w51', matchPoll);
  btn.textContent = '📄 读取简历并匹配职位';
  btn.disabled = false;
}

async function startW51Batch() {
  if (!(await requireUploadedResume())) return;
  if (wIsRunning || !wAllJobs.length) return;
  const cnt = Math.min(parseInt(document.getElementById('wCnt').value) || 5, wAllJobs.length);
  const jobs = wAllJobs.slice(0, cnt);
  const minInt = parseInt(document.getElementById('wMin').value) || 3;
  const maxInt = parseInt(document.getElementById('wMax').value) || 5;

  await chrome.storage.local.remove('w51_cancel');
  const all = await chrome.tabs.query({});
  const saved = await chrome.storage.local.get(['w51_match_tab', 'w51_search_url']);
  let wTab = null;
  if (saved.w51_match_tab) {
    try {
      const t = await chrome.tabs.get(saved.w51_match_tab);
      if (t.url?.includes('we.51job.com')) wTab = t;
    } catch (_) {}
  }
  if (!wTab) wTab = all.find(t => t.url?.includes('we.51job.com/pc/search'));
  if (!wTab) {
    wSetStatus('请打开前程搜索页', 'er');
    err('请先打开 we.51job.com 搜索页并完成匹配');
    return;
  }
  const searchUrl = (wTab.url?.includes('/pc/search') ? wTab.url : '') || saved.w51_search_url || '';

  const cookies = await chrome.cookies.getAll({ domain: '.51job.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

  wIsRunning = true;
  document.getElementById('wStart').disabled = true;
  document.getElementById('wProg').style.display = '';
  showCancel();
  progressLogCursor.w51 = 0;
  chrome.runtime.sendMessage({
    action: 'w51_start', jobs, cookieStr, tabId: wTab.id, searchUrl, min: minInt, max: maxInt,
  });
  pollProgress('w51');
}

document.addEventListener('DOMContentLoaded', async () => {
  bindDegreePicker();
  bindDirectionPicker();
  const savedLogs = await chrome.storage.local.get('ui_logs');
  if (Array.isArray(savedLogs.ui_logs) && savedLogs.ui_logs.length) {
    sessionLogs = savedLogs.ui_logs.slice(-LOG_LIMIT);
    renderLogs();
  }
  await loadApiSettings();
  await renderResumeInfo();
  await refreshDayCounts();
  const foldSaved = await chrome.storage.local.get('ui_resume_open');
  if (foldSaved.ui_resume_open === false) setResumeFold(false);
  else setResumeFold(true);
  await restoreSaveFlashes();
  const s = await chrome.storage.local.get(['minInt', 'maxInt']);
  document.getElementById('min').value = s.minInt || 3;
  document.getElementById('max').value = s.maxInt || 5;
  document.getElementById('zMin').value = s.minInt || 3;
  document.getElementById('zMax').value = s.maxInt || 5;
  document.getElementById('wMin').value = s.minInt || 3;
  document.getElementById('wMax').value = s.maxInt || 5;

  const qTab = new URLSearchParams(location.search).get('tab');
  if (qTab === 'zhaopin' || qTab === '51job' || qTab === 'boss') switchTab(qTab);
  else await followActiveSite();

  const bossProg = await chrome.storage.local.get('boss_progress');
  if (bossProg.boss_progress && bossProg.boss_progress.running) {
    isRunning = true; document.getElementById('btnStart').disabled = true;
    document.getElementById('prog').style.display = ''; document.getElementById('cfg').style.display = '';
    showCancel(); pollProgress('boss');
  }
  const zpProg = await chrome.storage.local.get('zp_progress');
  if (zpProg.zp_progress && zpProg.zp_progress.running) {
    zIsRunning = true; document.getElementById('zStart').disabled = true;
    document.getElementById('zProg').style.display = ''; document.getElementById('zCfg').style.display = '';
    showCancel(); pollProgress('zp');
  }
  const wProg = await chrome.storage.local.get('w51_progress');
  if (wProg.w51_progress && wProg.w51_progress.running) {
    wIsRunning = true; document.getElementById('wStart').disabled = true;
    document.getElementById('wProg').style.display = ''; document.getElementById('wCfg').style.display = '';
    showCancel(); pollProgress('w51');
  }

  document.getElementById('tabBoss').addEventListener('click', () => switchTab('boss'));
  document.getElementById('tabZhaopin').addEventListener('click', () => switchTab('zhaopin'));
  document.getElementById('tab51').addEventListener('click', () => switchTab('51job'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[dayCountKey('boss')] || changes[dayCountKey('zp')] || changes[dayCountKey('w51')]) {
      refreshDayCounts();
    }
  });
  document.getElementById('btnApi').addEventListener('click', () => {
    document.getElementById('apiPanel').classList.toggle('open');
  });
  document.getElementById('btnSaveApi').addEventListener('click', saveApiSettings);
  document.getElementById('btnSaveProfile').addEventListener('click', saveProfileEdits);
  document.getElementById('clearAppliedBoss')?.addEventListener('click', () => clearAppliedIds('boss'));
  document.getElementById('clearAppliedZp')?.addEventListener('click', () => clearAppliedIds('zp'));
  document.getElementById('btnToggleResume').addEventListener('click', () => {
    const card = document.getElementById('resumeCard');
    const open = card && card.classList.contains('collapsed');
    setResumeFold(!!open);
  });
  document.getElementById('btnUploadResume').addEventListener('click', () => {
    document.getElementById('resumeFile').click();
  });
  document.getElementById('resumeFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) handleResumeUpload(file);
  });
  document.getElementById('btnParseResume').addEventListener('click', handleResumeParse);
  document.getElementById('btnDeleteResume').addEventListener('click', deleteResumeFile);
  document.getElementById('btnMatch').addEventListener('click', fetchBossByResume);
  document.getElementById('zBtnMatch').addEventListener('click', fetchZpByResume);
  document.getElementById('wBtnMatch').addEventListener('click', fetchW51ByResume);
  document.getElementById('btnStart').addEventListener('click', startBossBatch);
  document.getElementById('zStart').addEventListener('click', startZpBatch);
  document.getElementById('wStart').addEventListener('click', startW51Batch);
  document.getElementById('bCancel').addEventListener('click', () => {
    const key = activeTab === 'zhaopin' ? 'zp_cancel' : (activeTab === '51job' ? 'w51_cancel' : 'boss_cancel');
    chrome.storage.local.set({ [key]: true });
    err('⏹ 取消中...');
  });
  document.querySelector('.clear-log').addEventListener('click', () => {
    sessionLogs = [];
    persistLogs();
    renderLogs();
  });

  chrome.tabs.onActivated.addListener(() => { followActiveSite(); });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete' || info.url) followActiveSite();
  });
});
