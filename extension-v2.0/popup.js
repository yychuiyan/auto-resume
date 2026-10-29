let isRunning = false, zIsRunning = false, wIsRunning = false;
let allJobs = [], zAllJobs = [], wAllJobs = [];
// 列表清空动画的定时器，按平台各存一个，避免连点时旧定时器把新列表清掉
const jlTimers = {};
let sessionLogs = [];
let activeTab = 'boss';
const LOG_LIMIT = 300;
const progressLogCursor = { boss: 0, zp: 0, w51: 0 };
const PLATFORMS = ['boss', 'zp', 'w51'];
const PLAT_LABEL = { boss: 'BOSS', zp: '智联', w51: '前程' };
// 已投 / 忽略名单的本地缓存：列表渲染、投递守卫都读这里，写的时候同步回 storage
const appliedCache = { boss: new Set(), zp: new Set(), w51: new Set() };
const ignoredCache = { boss: new Set(), zp: new Set(), w51: new Set() };
const IGNORED_CAP = 10000;

// 用本地日期而不是 toISOString（UTC）：否则「今日」在北京时间早上 8 点就换天了
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function dayCountKey(platform) {
  return platform + '_cnt_' + todayKey();
}

async function refreshDayCounts() {
  const keys = [dayCountKey('boss'), dayCountKey('zp'), dayCountKey('w51'),
    'applied_ids_boss', 'applied_ids_zp', 'applied_ids_w51', 'w51_matched_ids',
    'ignored_ids_boss', 'ignored_ids_zp', 'ignored_ids_w51'];
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
  // 忽略名单同步进缓存，列表渲染与投递守卫都用它，不用每次再读 storage
  const ignored = {};
  for (const p of PLATFORMS) {
    const arr = Array.isArray(s['ignored_ids_' + p]) ? s['ignored_ids_' + p] : [];
    ignoredCache[p] = new Set(arr.map(String).filter(Boolean));
    ignored[p] = ignoredCache[p].size;
    const aarr = Array.isArray(s['applied_ids_' + p]) ? s['applied_ids_' + p] : [];
    appliedCache[p] = new Set(aarr.map(String).filter(Boolean));
  }
  // 前程的跳过来源有两份（本机已投 + 匹配已跳过），取并集才是真实去重数
  const w51Set = new Set([]
    .concat(Array.isArray(s.applied_ids_w51) ? s.applied_ids_w51 : [])
    .concat(Array.isArray(s.w51_matched_ids) ? s.w51_matched_ids : [])
    .map(String));
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  set('cntBoss', nums.boss);
  set('cntZp', nums.zp);
  set('cntW51', nums.w51);
  set('dayBoss', nums.boss);
  set('dayZp', nums.zp);
  set('dayW51', nums.w51);
  set('appliedBoss', applied.boss);
  set('appliedZp', applied.zp);
  set('appliedW51', w51Set.size);
  set('ignoredBoss', ignored.boss);
  set('ignoredZp', ignored.zp);
  set('ignoredW51', ignored.w51);
}

// 从 storage 重新同步某平台的已投/忽略名单到缓存（点投递前兜底一次，
// 防止 background 刚写入的 applied 还没反映到 popup 的缓存里）
async function loadGuardSets(platform) {
  const aKey = 'applied_ids_' + platform;
  const iKey = 'ignored_ids_' + platform;
  try {
    const s = await chrome.storage.local.get([aKey, iKey]);
    appliedCache[platform] = new Set((Array.isArray(s[aKey]) ? s[aKey] : []).map(String).filter(Boolean));
    ignoredCache[platform] = new Set((Array.isArray(s[iKey]) ? s[iKey] : []).map(String).filter(Boolean));
  } catch (_) { /* 读失败就沿用缓存，不阻断投递 */ }
}

// 忽略名单的单平台清空：清完要把列表里的删除线一起摘掉
async function clearIgnoredIds(platform) {
  await chrome.storage.local.remove('ignored_ids_' + platform);
  ignoredCache[platform] = new Set();
  await refreshDayCounts();
  reRenderJobList(platform);
  await refreshApplyGuard(platform);
  const label = PLAT_LABEL[platform] || platform;
  info(label + ' 忽略名单已清空，之前忽略的岗位重新参与投递');
}

async function clearAppliedIds(platform) {
  const key = 'applied_ids_' + platform;
  // 前程另外存了一份「匹配已跳过」，只清一半的话下一轮还是 0 条
  const keys = platform === 'w51'
    ? [key, 'w51_matched_ids', 'w51_matched_kw']
    : [key];
  await chrome.storage.local.remove(keys);
  appliedCache[platform] = new Set();
  await refreshDayCounts();
  await refreshApplyGuard(platform);
  const label = ({ boss: 'BOSS', zp: '智联', w51: '前程' })[platform] || platform;
  info(label + (platform === 'w51' ? ' 本机已投与已匹配记录已清空' : ' 本机已投名单已清空'));
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

// 提示消息默认几秒后自动消失，避免「已移出：xx」这类一次性反馈一直占着位置；
// 需要长期保留的（保存时间戳）传 { hold: true }。
const FLASH_HIDE_MS = 4000;
const flashTimers = {};

function setFlash(id, msg, kind, opts) {
  const el = document.getElementById(id);
  if (!el) return;
  if (flashTimers[id]) { clearTimeout(flashTimers[id]); delete flashTimers[id]; }
  el.textContent = msg || '';
  el.className = 'flash' + (kind ? ' ' + kind : '');
  if (!msg || (opts && opts.hold)) return;
  flashTimers[id] = setTimeout(() => {
    delete flashTimers[id];
    el.textContent = '';
    el.className = 'flash';
  }, (opts && opts.ms) || FLASH_HIDE_MS);
}

function formatSaveAt(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function setSavedFlash(id, label, ts) {
  if (!ts) return;
  setFlash(id, label + ' · ' + formatSaveAt(ts), 'ok', { hold: true });
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

// 学历 / 方向选择 / 排除词 三个下拉同一时间只开一个
const MSEL_IDS = ['pfDegree', 'pfDirection', 'pfExclude'];

function closeOtherMsels(keep) {
  for (const id of MSEL_IDS) {
    if (id === keep) continue;
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }
}

// 点页面空白处收起所有下拉，全局只注册一次
let mselOutsideBound = false;
function bindMselOutsideClick() {
  if (mselOutsideBound) return;
  mselOutsideBound = true;
  document.addEventListener('click', () => closeOtherMsels(''));
}

function bindDegreePicker() {
  const wrap = document.getElementById('pfDegree');
  const btn = document.getElementById('pfDegreeBtn');
  const list = document.getElementById('pfDegreeList');
  if (!wrap || !btn || !list || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeOtherMsels('pfDegree');
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
}

let directionOptionsCache = [];
// 方向名 → 关键词数组（AI 生成，用户可改）；筛选用它判断岗位属于哪个方向
let directionKeywordsCache = {};
// 同领域但不匹配的相邻方向（AI 给），只参与判定，不进下拉
let otherDirectionsCache = {};
// 排除词：真正参与判定的否定名单，与方向勾选完全解耦
let excludeKeywordList = [];
// 我删掉的排除词（墓碑）：重新解析时 AI 不会把它们再加回来
let removedKeywordsCache = [];
// 我取消勾选的方向（墓碑）：重新解析后不会被重新勾上
let directionsRemovedCache = [];
// 我手改过关键词的方向名：重新解析时保住我的版本，不被 AI 覆盖
let editedKeywordsCache = new Set();
// true = 不限方向（勾选「全部」），false = 只匹配勾选的方向
let directionUnlimited = true;
// 方向编辑器渲染过没有：没渲染过时缓存是空的，不能拿它回写覆盖已存画像
let directionEditorReady = false;

function directionWordsOf(name) {
  const n = String(name || '');
  const kw = directionKeywordsCache[n];
  if (Array.isArray(kw) && kw.length) return kw.slice();
  return [n];
}

function setDirectionWords(name, words) {
  const n = String(name || '').trim();
  if (!n) return;
  const list = String(words || '')
    .split(/[,，、;；|\s]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 14);
  if (list.length) directionKeywordsCache[n] = list;
  else delete directionKeywordsCache[n];
}

// 用户在「词」输入框里只填同义词；方向名本身永远算一个关键词
function commitKeywordEdit(name, typed) {
  const t = String(typed || '').trim();
  setDirectionWords(name, t ? name + ',' + t : name);
  // 记一笔：这行词是用户定的，重新解析时不能被 AI 冲掉
  editedKeywordsCache.add(String(name || '').trim());
  return directionWordsOf(name);
}

function directionFallbackOptions() {
  const RM = window.ResumeMatch;
  if (RM && typeof RM.directionOptionsOf === 'function') return RM.directionOptionsOf({});
  return [];
}

function directionBoxes() {
  return Array.from(document.querySelectorAll('#pfDirectionItems input[data-direction]'));
}

function pickedDirections() {
  return directionBoxes()
    .filter(el => el.checked && el.getAttribute('data-direction') !== '__all__')
    .map(el => el.getAttribute('data-direction'));
}

function directionSummary() {
  if (directionUnlimited) return '全部（不限方向）';
  const picked = pickedDirections();
  if (!picked.length) return '全部（不限方向）';
  const text = picked.join('、');
  return text.length > 12 ? picked.length + ' 项方向' : text;
}

function syncDirectionUI() {
  const allBox = document.getElementById('pfDirectionAll');
  if (allBox) allBox.checked = directionUnlimited;
  const btn = document.getElementById('pfDirectionBtn');
  if (btn) btn.textContent = directionSummary();
  // 排除词面板跟着方向勾选走：未勾选方向会实时反映到下半段只读区
  renderExcludePanel();
  syncExcludeUI();
}

// ===== 排除词 =====
// 排除词是与方向无关的自由词：命中岗位名/技能/标签/JD 就拦，优先级高于方向选择。
// 它与方向勾选解耦，所以这里不再有「勾上=排除某方向」的镜像关系。

const EXCLUDE_KW_MAX = 40;

// 清洗复用引擎那份（去注释、丢泛词、大小写去重、上限 40），
// 保证侧边栏显示的数量和实际生效的数量一致。
function normalizeExcludeWords(list) {
  const RM = window.ResumeMatch;
  if (RM && typeof RM.normalizeExcludeKeywords === 'function') {
    return RM.normalizeExcludeKeywords(list);
  }
  const out = [];
  for (const raw of [].concat(list || [])) {
    const w = String(raw || '').replace(/#.*$/, '').trim().slice(0, 20);
    if (!w) continue;
    if (out.some(x => x.toLowerCase() === w.toLowerCase())) continue;
    if (out.length >= EXCLUDE_KW_MAX) break;
    out.push(w);
  }
  return out;
}

// 一个方向的专属词：方向关键词 → 相邻方向词 → 名字本身
function excludeWordsOfDir(name) {
  const n = String(name || '');
  const kw = directionKeywordsCache[n];
  if (Array.isArray(kw) && kw.length) return kw.slice();
  const other = otherDirectionsCache[n];
  if (Array.isArray(other) && other.length) return other.slice();
  return [n];
}

// 未勾选的方向：只读展示，说明「这些正被白名单挡掉」，用户点一下才升级为文本级拦截。
// 相邻干扰方向（AI 给的 otherDirections）不在可选池里，但同样拦得住，一并列出来。
function unpickedDirections() {
  if (directionUnlimited) return [];
  const sel = new Set(pickedDirections());
  const extra = Object.keys(otherDirectionsCache).filter(n => directionOptionsCache.indexOf(n) < 0);
  return directionOptionsCache.concat(extra).filter(n => !sel.has(n));
}

function excludeSummary() {
  if (directionUnlimited) return '不限方向';
  const n = excludeKeywordList.length;
  return n ? '排除 ' + n + ' 词' : '未设置';
}

function syncExcludeUI() {
  const wrap = document.getElementById('pfExclude');
  const btn = document.getElementById('pfExcludeBtn');
  const hint = document.getElementById('pfExcludeHint');
  if (wrap) {
    wrap.classList.toggle('disabled', directionUnlimited);
    if (directionUnlimited) wrap.classList.remove('open');
  }
  if (btn) btn.textContent = excludeSummary();
  if (hint) hint.style.display = directionUnlimited ? '' : 'none';
}

// 上半段：可增删改的排除词
function renderExcludeItems() {
  const box = document.getElementById('pfExcludeItems');
  if (!box) return;
  if (!excludeKeywordList.length) {
    box.innerHTML = '<div class="msel-empty">还没有排除词。点「解析」让 AI 自动生成，或在下方手动添加。</div>';
    return;
  }
  box.innerHTML = excludeKeywordList.map(w =>
    '<label class="dir">'
    + '<span class="nm" data-kw-edit="' + escHtml(w) + '" title="点击修改">' + escHtml(w) + '</span>'
    + '<button type="button" class="msel-del" data-kw-del="' + escHtml(w) + '" title="删除该排除词">×</button>'
    + '</label>').join('');
}

// 下半段：未勾选方向（只读），可一键把它的行话转成排除词
function renderExcludeAuto() {
  const box = document.getElementById('pfExcludeAuto');
  const wrap = document.getElementById('pfExcludeAutoWrap');
  if (!box) return;
  const list = unpickedDirections();
  if (wrap) wrap.style.display = directionUnlimited ? 'none' : '';
  if (directionUnlimited) { box.innerHTML = ''; return; }
  if (!list.length) {
    box.innerHTML = '<div class="msel-empty">所有方向都勾上了，没有只读项</div>';
    return;
  }
  box.innerHTML = list.slice(0, 12).map((n) => {
    const words = excludeWordsOfDir(n);
    return '<label class="dir auto">'
      + '<span class="nm" title="' + escHtml(words.join('、')) + '">' + escHtml(n) + '</span>'
      + '<button type="button" class="msel-conv" data-conv="' + escHtml(n) + '" title="'
      + escHtml(words.join('、')) + '">转为排除词</button>'
      + '</label>';
  }).join('') + (list.length > 12 ? '<div class="msel-empty">还有 ' + (list.length - 12) + ' 个方向…</div>' : '');
}

function renderExcludePanel() {
  renderExcludeItems();
  renderExcludeAuto();
}

function addExcludeWords(words, opts) {
  const add = normalizeExcludeWords(words);
  if (!add.length) return 0;
  const silent = !!(opts && opts.silent);
  const before = excludeKeywordList.length;
  excludeKeywordList = normalizeExcludeWords([].concat(excludeKeywordList, add));
  // 加回来的词要从墓碑里摘掉，否则下次重新解析它又会被删掉
  for (const w of add) {
    removedKeywordsCache = removedKeywordsCache.filter(x => x.toLowerCase() !== w.toLowerCase());
  }
  renderExcludePanel();
  syncExcludeUI();
  const n = excludeKeywordList.length - before;
  if (!silent) {
    if (n > 0) setFlash('profileSaveMsg', '已加入 ' + n + ' 个排除词，点「保存规则」生效', 'ok');
    else setFlash('profileSaveMsg', '没有新增（可能已在名单里，或属于「测试/开发」这类泛词）', 'er');
  }
  return n;
}

function removeExcludeWord(word) {
  const w = String(word || '').trim();
  if (!w) return;
  excludeKeywordList = excludeKeywordList.filter(x => x.toLowerCase() !== w.toLowerCase());
  // 记墓碑：重新解析时 AI 再加回这个词也会被过滤掉
  if (!removedKeywordsCache.some(x => x.toLowerCase() === w.toLowerCase())) {
    removedKeywordsCache = removedKeywordsCache.concat([w]);
  }
  renderExcludePanel();
  syncExcludeUI();
}

function renameExcludeWord(oldWord, next) {
  const from = String(oldWord || '').trim();
  const to = String(next || '').trim().slice(0, 20);
  if (!from || !to) return;
  const idx = excludeKeywordList.findIndex(x => x.toLowerCase() === from.toLowerCase());
  if (idx < 0) return;
  if (from.toLowerCase() === to.toLowerCase()) return;
  // 旧词进墓碑：重解析时 AI 若还吐旧词，不该把它顶回来
  if (!removedKeywordsCache.some(x => x.toLowerCase() === from.toLowerCase())) {
    removedKeywordsCache = removedKeywordsCache.concat([from]);
  }
  excludeKeywordList = excludeKeywordList.slice();
  if (excludeKeywordList.some(x => x.toLowerCase() === to.toLowerCase())) {
    excludeKeywordList = excludeKeywordList.filter((_, i) => i !== idx);
  } else {
    excludeKeywordList[idx] = to;
  }
  excludeKeywordList = normalizeExcludeWords(excludeKeywordList);
  renderExcludePanel();
  syncExcludeUI();
}

// 点词就地把排除词改名：回车/失焦保存，Esc 取消
function beginExcludeWordEdit(span) {
  if (!span || !span.parentNode) return;
  const oldWord = span.getAttribute('data-kw-edit') || '';
  if (!oldWord) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'nm-edit';
  input.maxLength = 20;
  input.value = oldWord;
  span.replaceWith(input);
  input.focus();
  try { input.select(); } catch (_) {}
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) renameExcludeWord(oldWord, input.value);
    else renderExcludePanel();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// 平铺渲染：候选项来自简历解析 + 手工新增，每项带关键词与删除按钮
function renderDirectionList(options, selected, forceAll) {
  const box = document.getElementById('pfDirectionItems');
  if (!box) return;
  const opts = (Array.isArray(options) ? options : directionFallbackOptions()).slice();
  directionOptionsCache = opts;
  const sel = new Set([].concat(selected || []).map(String));
  directionUnlimited = !!forceAll || !sel.size;
  if (!opts.length) {
    box.innerHTML = '<div class="msel-empty">解析简历后自动列出方向，也可在下方手动添加</div>';
    syncDirectionUI();
    return;
  }
  const rows = opts.map(n => {
    const on = directionUnlimited || sel.has(n);
    const words = directionWordsOf(n);
    // 只有名字本身 = 还没设关键词，同义词认不出，标灰提示
    const bare = words.length === 1 && words[0] === n;
    return '<label class="dir' + (bare ? ' bare' : '') + '">'
      + '<input type="checkbox" data-direction="' + escHtml(n) + '"' + (on ? ' checked' : '') + '>'
      + '<span class="nm" data-edit="' + escHtml(n) + '" title="点击修改名称">' + escHtml(n) + '</span>'
      + '<button type="button" class="msel-kw" data-kw="' + escHtml(n) + '" title="'
      + (bare ? '未设关键词，只能字面匹配。点击设置' : escHtml(words.join('、')))
      + '">' + (bare ? '词' : words.length) + '</button>'
      + '<button type="button" class="msel-del" data-del="' + escHtml(n) + '" title="删除该方向">×</button>'
      + '</label>';
  });
  // 一个方向都没有专属关键词：筛选会退化成字面匹配，几乎不拦人，必须明说
  const allBare = opts.every(n => {
    const w = directionWordsOf(n);
    return w.length === 1 && w[0] === n;
  });
  if (allBare && !directionUnlimited) {
    rows.push('<div class="msel-warn">方向还没有关键词，只能按名字字面匹配，'
      + '认不出的岗位会全部放行。点上方「解析」重新生成，或点每行的「词」手填。</div>');
  }
  box.innerHTML = rows.join('');
  syncDirectionUI();
}

// 点「词」就地编辑关键词：逗号分隔，回车/失焦保存，Esc 取消
function beginKeywordEdit(btn) {
  if (!btn || !btn.parentNode) return;
  const name = btn.getAttribute('data-kw') || '';
  if (!name) return;
  const row = btn.closest('label.dir');
  if (!row) return;
  row.classList.add('editing');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'kw-edit';
  input.placeholder = '关键词，逗号分隔';
  input.value = directionWordsOf(name).filter(w => w !== name).join(', ');
  btn.replaceWith(input);
  input.focus();
  try { input.select(); } catch (_) {}
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) commitKeywordEdit(name, input.value);
    renderDirectionList(directionOptionsCache, pickedDirections(), directionUnlimited);
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// 点文字就地改名：回车/失焦保存，Esc 取消
function beginDirectionEdit(span) {
  if (!span || !span.parentNode) return;
  const oldName = span.getAttribute('data-edit') || '';
  if (!oldName) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'nm-edit';
  input.maxLength = 12;
  input.value = oldName;
  span.replaceWith(input);
  input.focus();
  try { input.select(); } catch (_) {}
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const next = String(input.value || '').trim().slice(0, 12);
    if (commit && next && next !== oldName) renameDirection(oldName, next);
    else renderDirectionList(directionOptionsCache, pickedDirections(), directionUnlimited);
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// 改名：保留勾选状态与位置；改成一个已存在的名字时合并，不留重复项
function renameDirection(oldName, next) {
  const names = directionOptionsCache;
  const idx = names.indexOf(oldName);
  if (idx < 0 || !next) return;
  const boxes = directionBoxes();
  const wasChecked = boxes.some(el => el.getAttribute('data-direction') === oldName && el.checked);
  const sel = pickedDirections().filter(n => n !== oldName);
  const dupIdx = names.findIndex((n, i) => i !== idx && n.toLowerCase() === next.toLowerCase());
  let opts;
  let target = next;
  if (dupIdx >= 0) {
    target = names[dupIdx];
    opts = names.filter((_, i) => i !== idx);
    const dupChecked = boxes.some(el => el.getAttribute('data-direction') === target && el.checked);
    if (wasChecked && !dupChecked && sel.indexOf(target) < 0) sel.push(target);
  } else {
    opts = names.slice();
    opts[idx] = next;
    if (wasChecked && sel.indexOf(target) < 0) sel.push(target);
  }
  directionOptionsCache = opts;
  // 关键词跟着改名走，原方向的同义词不能丢
  const words = directionKeywordsCache[oldName];
  if (words && words.length) {
    delete directionKeywordsCache[oldName];
    if (!directionKeywordsCache[target]) {
      directionKeywordsCache[target] = words.map(w => (w === oldName ? target : w));
    }
  }
  renderDirectionList(opts, sel, directionUnlimited);
}

// 新增自定义方向：立即勾选，名字本身作为匹配关键词
function addDirection(name) {
  const n = String(name || '').trim().slice(0, 12);
  if (!n || n === '__all__') return;
  if (!directionOptionsCache.some(x => x.toLowerCase() === n.toLowerCase())) {
    if (directionOptionsCache.length >= 40) return;
    directionOptionsCache = directionOptionsCache.concat([n]);
  }
  if (!directionKeywordsCache[n]) directionKeywordsCache[n] = [n];
  const sel = pickedDirections();
  if (sel.indexOf(n) < 0) sel.push(n);
  renderDirectionList(directionOptionsCache, sel, directionUnlimited);
}

function removeDirection(name) {
  const keep = pickedDirections().filter(x => x !== name);
  directionOptionsCache = directionOptionsCache.filter(x => x !== name);
  delete directionKeywordsCache[name];
  delete otherDirectionsCache[name];
  renderDirectionList(directionOptionsCache, keep, directionUnlimited);
}

// 「全部」勾上 → 存空数组（不限方向）；否则存勾选项，只匹配这些方向
function getSelectedDirections() {
  if (directionUnlimited) return [];
  return pickedDirections();
}

function bindDirectionPicker() {
  const wrap = document.getElementById('pfDirection');
  const btn = document.getElementById('pfDirectionBtn');
  const list = document.getElementById('pfDirectionList');
  if (!wrap || !btn || !list || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeOtherMsels('pfDirection');
    wrap.classList.toggle('open');
  });
  list.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target;
    const del = t && t.closest && t.closest('.msel-del');
    if (del) {
      e.preventDefault();
      removeDirection(del.getAttribute('data-del'));
      return;
    }
    if (t && t.closest && t.closest('#pfDirectionAdd')) {
      e.preventDefault();
      const input = document.getElementById('pfDirectionNew');
      if (input) { addDirection(input.value); input.value = ''; }
      return;
    }
    // 点「词」→ 就地编辑该方向的关键词（同样是阻止 label 的勾选切换）
    const kwBtn = t && t.closest && t.closest('.msel-kw');
    if (kwBtn) {
      e.preventDefault();
      beginKeywordEdit(kwBtn);
      return;
    }
    // 点方向名字 → 就地改名（阻止 label 默认的勾选切换）
    const nm = t && t.closest && t.closest('.nm');
    if (nm) {
      e.preventDefault();
      beginDirectionEdit(nm);
    }
  });
  list.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.id === 'pfDirectionAll') {
      if (t.checked) {
        // 回到不限方向：全部勾上，之前的取消记录也随之作废
        directionUnlimited = true;
        directionsRemovedCache = [];
        for (const el of directionBoxes()) el.checked = true;
      } else if (!directionBoxes().length) {
        // 没有任何候选项时「全部」就是唯一状态
        directionUnlimited = true;
      } else {
        // 进入筛选模式，先全部保留勾选，让用户取消不要的方向
        directionUnlimited = false;
      }
      syncDirectionUI();
      return;
    }
    const nm = t.getAttribute('data-direction');
    if (!nm) return;
    // 取消某一项 = 隐式进入筛选模式，并记墓碑（重新解析不会自动勾回来）
    if (!t.checked) {
      directionUnlimited = false;
      if (!directionsRemovedCache.some(x => x.toLowerCase() === nm.toLowerCase())) {
        directionsRemovedCache = directionsRemovedCache.concat([nm]);
      }
    } else {
      directionsRemovedCache = directionsRemovedCache
        .filter(x => x.toLowerCase() !== nm.toLowerCase());
    }
    // 一项都不剩时退回「全部」
    if (!pickedDirections().length) {
      directionUnlimited = true;
      directionsRemovedCache = [];
      for (const el of directionBoxes()) el.checked = true;
    }
    syncDirectionUI();
  });
  const inp = document.getElementById('pfDirectionNew');
  if (inp) {
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      addDirection(inp.value);
      inp.value = '';
    });
  }
}

// 「排除词」下拉：自由词黑名单，与方向勾选完全解耦。
// 上半段可增删改；下半段是「未勾选方向」只读提示，点「转为排除词」才升级为文本级拦截。
// 不限方向时整体置灰（用户显式选择「全都收」，排除词不生效）。
function bindExcludePicker() {
  const wrap = document.getElementById('pfExclude');
  const btn = document.getElementById('pfExcludeBtn');
  const list = document.getElementById('pfExcludeList');
  if (!wrap || !btn || !list || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (directionUnlimited) {
      setFlash('profileSaveMsg', '方向选了「全部」时排除词不生效，先取消「全部」再设置', 'er');
      return;
    }
    closeOtherMsels('pfExclude');
    renderExcludePanel();
    wrap.classList.toggle('open');
  });
  list.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target;
    if (!t || !t.closest) return;
    const del = t.closest('.msel-del');
    if (del) {
      e.preventDefault();
      removeExcludeWord(del.getAttribute('data-kw-del'));
      return;
    }
    const conv = t.closest('.msel-conv');
    if (conv) {
      e.preventDefault();
      const name = conv.getAttribute('data-conv') || '';
      const n = addExcludeWords(excludeWordsOfDir(name));
      if (!n) {
        setFlash('profileSaveMsg', '「' + name + '」的词都已在排除词里', 'er');
      }
      return;
    }
    const nm = t.closest('.nm');
    if (nm && nm.getAttribute && nm.getAttribute('data-kw-edit') !== null) {
      e.preventDefault();
      beginExcludeWordEdit(nm);
    }
  });
  const inp = document.getElementById('pfExcludeNew');
  const add = document.getElementById('pfExcludeAdd');
  const doAdd = () => {
    if (directionUnlimited) {
      setFlash('profileSaveMsg', '方向选了「全部」时排除词不生效，先取消「全部」再添加', 'er');
      return;
    }
    const raw = String((inp && inp.value) || '');
    // 支持一次粘一串：逗号/空格/顿号/换行都当分隔符
    const words = raw.split(/[,，、\s;；|]+/).map(x => x.trim()).filter(Boolean);
    if (!words.length) return;
    addExcludeWords(words);
    if (inp) inp.value = '';
  };
  if (add) add.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); doAdd(); });
  if (inp) {
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      doAdd();
    });
  }
}

// 文本域自适应高度：进入时按内容撑开，56~180px；
// 用户手动拖过高度之后就不再自动改，避免跟人抢。
function fitTextarea(el) {
  if (!el || el.dataset.manual === '1') return;
  const MIN = 56;
  const MAX = 180;
  // 当前高度和上次自动算的值对不上 = 用户拖过，交还控制权
  const last = Number(el.dataset.fitH || 0);
  if (last && el.style.height && Math.abs(el.offsetHeight - last) > 1) {
    el.dataset.manual = '1';
    return;
  }
  el.style.height = 'auto';
  const need = Math.max(MIN, Math.min(MAX, el.scrollHeight + 2));
  el.style.height = need + 'px';
  el.dataset.fitH = String(need);
}

function bindTextareaFit() {
  for (const id of ['pfSkills', 'pfWork']) {
    const el = document.getElementById(id);
    if (!el || el.dataset.fitBound) continue;
    el.dataset.fitBound = '1';
    el.addEventListener('input', () => fitTextarea(el));
    // 原生 resize 手柄拖完会触发 mouseup：记一笔，之后不再自动接管
    el.addEventListener('mouseup', () => {
      const h = el.offsetHeight;
      if (Math.abs(h - (parseFloat(el.style.height) || 0)) > 1) el.dataset.manual = '1';
    });
  }
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
  const dirOpts = (window.ResumeMatch && window.ResumeMatch.directionOptionsOf)
    ? window.ResumeMatch.directionOptionsOf(p)
    : directionFallbackOptions();
  // 老画像里的 excludeDirections 已废弃：名字并进候选池，让它们在「未勾选方向」只读区
  // 还能看到、还能一键转成排除词，不至于升级后凭空消失
  for (const n of [].concat((p && p.excludeDirections) || [])) {
    const nm = String(n || '').trim();
    if (nm && dirOpts.indexOf(nm) < 0) dirOpts.push(nm);
  }
  const dirSel = (window.ResumeMatch && window.ResumeMatch.selectedDirectionsOf)
    ? window.ResumeMatch.selectedDirectionsOf(p)
    : (p.directions || []);
  // 排除词与三份记忆：AI 生成的那份 + 用户手加/手删/手改的记录
  excludeKeywordList = normalizeExcludeWords(p && p.excludeKeywords);
  removedKeywordsCache = [].concat((p && p.excludeKeywordsRemoved) || []);
  directionsRemovedCache = [].concat((p && p.directionsRemoved) || []);
  editedKeywordsCache = new Set((p && p.directionKeywordsEdited) || []);
  // 方向关键词：AI 生成的那份，用户在「词」里改
  directionKeywordsCache = Object.assign({}, (p && p.directionKeywords) || {});
  otherDirectionsCache = Object.assign({}, (p && p.otherDirections) || {});
  // directions 为空 = 不限方向（「全部」勾上）
  renderDirectionList(dirOpts, dirSel, !(p.directions || []).length);
  directionEditorReady = true;
  box.style.display = 'block';
  for (const id of ['pfSkills', 'pfWork']) {
    const el = document.getElementById(id);
    if (el) { delete el.dataset.manual; fitTextarea(el); }
  }
}

function setResumeFold(open) {
  const card = document.getElementById('resumeCard');
  const caret = document.getElementById('resumeFoldCaret');
  if (!card) return;
  card.classList.toggle('collapsed', !open);
  // 日志高度跟着收起状态走（CSS 里 body.resume-collapsed #log）
  document.body.classList.toggle('resume-collapsed', !open);
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
  setFlash('resumeParseMsg', msg, 'er', { hold: true });
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
  // 守卫状态跟着清掉，别留着上一轮的「待投 K/N」文案
  const hintIds = ['applyHintBoss', 'applyHintZp', 'applyHintW51'];
  hintIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  const startIds = ['btnStart', 'zStart', 'wStart'];
  startIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
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
  setFlash('resumeParseMsg', NEED_RESUME_MSG, 'er', { hold: true });
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
    setFlash('resumeParseMsg', '已上传，请点击「解析」', 'ok', { hold: true });
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
    const titles = splitProfileList(document.getElementById('pfTitles').value);
    if (!titles.length) throw new Error('期望职位不能为空');
    const base = window.ResumeMatch.extractProfile(JSON.stringify({
      titles,
      city: document.getElementById('pfCity').value.trim(),
      skills: splitProfileList(document.getElementById('pfSkills').value),
      workKeywords: splitProfileList(document.getElementById('pfWork').value),
      salaryMin: parseInt(document.getElementById('pfSalary').value, 10) || 0,
      scaleMin: parseInt(document.getElementById('pfScale').value, 10) || 0,
      degrees: getSelectedDegrees(),
    }));
    // 只保留还在候选里的方向关键词，删掉的方向不再留残留
    const keywords = {};
    for (const n of directionOptionsCache) {
      const words = directionKeywordsCache[n];
      if (Array.isArray(words) && words.length) keywords[n] = words.slice();
    }
    const profile = Object.assign({}, base, {
      directions: getSelectedDirections(),
      excludeKeywords: excludeKeywordList.slice(),
      directionOptions: directionOptionsCache.slice(),
      directionKeywords: keywords,
      // AI 给的相邻干扰方向沿用上次解析结果
      otherDirections: (prev && prev.otherDirections) || {},
      // 三份用户记忆：重解析时挡住 AI 的覆盖
      excludeKeywordsRemoved: removedKeywordsCache.slice(),
      directionsRemoved: directionsRemovedCache.slice(),
      directionKeywordsEdited: Array.from(editedKeywordsCache),
    });
    await window.ResumeAI.saveProfile(profile, { fileName: (prev && prev.fileName) || '', keepParsedAt: true });
    fillProfileEditor(Object.assign({}, profile, { fileName: (prev && prev.fileName) || '' }));
    await markSaved('profile');
    ok('匹配规则已保存');
  } catch (e) {
    setFlash('profileSaveMsg', e.message || String(e), 'er');
    err(e.message || String(e));
  }
}

// ===== 公司黑名单 =====
// 数据源只有一份：chrome.storage.local.company_blacklist。
// 内置 txt 只在第一次（storage 为空）作为默认名单导入，之后完全由用户增删改。
const BL_KEY = 'company_blacklist';
let blkList = [];

function blkStorageKey() {
  return (window.ResumeMatch && window.ResumeMatch.BL_KEY) || BL_KEY;
}

function renderBlkSum() {
  const sum = document.getElementById('blkSum');
  if (sum) sum.textContent = blkList.length ? blkList.length + ' 家' : '未设置';
}

function renderBlkChips() {
  const box = document.getElementById('blkChips');
  if (!box) return;
  if (!blkList.length) {
    box.innerHTML = '<div class="msel-empty">名单为空，点「恢复默认」载入内置名单</div>';
    return;
  }
  box.innerHTML = blkList.map((n, i) =>
    '<span class="chip">'
    + '<span class="nm" data-blk-edit="' + i + '" title="点击改名">' + escHtml(n) + '</span>'
    + '<button type="button" class="x" data-blk-del="' + i + '" title="移除">×</button>'
    + '</span>').join('');
}

function renderBlk() {
  renderBlkSum();
  renderBlkChips();
}

function readBlkDefaults() {
  const RM = window.ResumeMatch;
  if (RM && typeof RM.loadBlacklistDefaults === 'function') return RM.loadBlacklistDefaults();
  return Promise.resolve([]);
}

async function saveBlk() {
  try {
    await chrome.storage.local.set({ [blkStorageKey()]: blkList });
  } catch (e) {
    setFlash('blkMsg', '黑名单保存失败：' + (e.message || e), 'er');
  }
  renderBlk();
}

function normalizeBlkInput(raw) {
  return String(raw || '').replace(/#.*$/, '').trim().slice(0, 30);
}

async function loadBlk() {
  try {
    const key = blkStorageKey();
    const s = await chrome.storage.local.get(key);
    let list = s && s[key];
    if (!Array.isArray(list)) {
      // 第一次用：把内置 txt 当默认名单导入 storage
      list = await readBlkDefaults();
      blkList = list.slice();
      await chrome.storage.local.set({ [key]: blkList });
      renderBlk();
      return;
    }
    blkList = list.slice();
  } catch (_) {
    blkList = [];
  }
  renderBlk();
}

async function addBlk(name) {
  const n = normalizeBlkInput(name);
  if (!n) return false;
  if (blkList.some(x => x.toLowerCase() === n.toLowerCase())) {
    setFlash('blkMsg', '「' + n + '」已经在名单里了', 'er');
    return false;
  }
  if (blkList.length >= 300) {
    setFlash('blkMsg', '名单最多 300 家', 'er');
    return false;
  }
  blkList = blkList.concat([n]);
  await saveBlk();
  setFlash('blkMsg', '已加入：' + n + '（共 ' + blkList.length + ' 家）', 'ok');
  return true;
}

async function removeBlk(idx) {
  const n = blkList[idx];
  if (n === undefined) return;
  blkList = blkList.filter((_, i) => i !== idx);
  await saveBlk();
  setFlash('blkMsg', '已移出：' + n, 'ok');
}

async function renameBlk(idx, next) {
  const v = normalizeBlkInput(next);
  if (!v) { renderBlk(); return; }
  if (blkList.some((x, i) => i !== idx && x.toLowerCase() === v.toLowerCase())) {
    setFlash('blkMsg', '「' + v + '」已存在', 'er');
    renderBlk();
    return;
  }
  blkList = blkList.map((x, i) => (i === idx ? v : x));
  await saveBlk();
}

function beginBlkEdit(span) {
  if (!span || !span.parentNode) return;
  const idx = parseInt(span.getAttribute('data-blk-edit'), 10);
  if (!isFinite(idx) || blkList[idx] === undefined) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'kw-edit';
  input.maxLength = 30;
  input.value = blkList[idx];
  span.replaceWith(input);
  input.focus();
  try { input.select(); } catch (_) {}
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) renameBlk(idx, input.value);
    else renderBlk();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function blkFileText() {
  const head = [
    '# 公司黑名单（一行一个，以 # 开头的行会被忽略）',
    '# 由「职位匹配助手」导出，可直接覆盖 extension-v2.0/blocklist/outsource-companies.txt',
    '# 导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
    '',
  ].join('\n');
  return head + blkList.join('\n') + (blkList.length ? '\n' : '');
}

function exportBlk() {
  try {
    const blob = new Blob([blkFileText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'outsource-companies.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFlash('blkMsg', '已导出 ' + blkList.length + ' 家黑名单', 'ok');
  } catch (e) {
    setFlash('blkMsg', '导出失败：' + (e.message || e), 'er');
  }
}

function bindBlocklist() {
  const toggle = document.getElementById('btnBlkToggle');
  const body = document.getElementById('blkBody');
  const caret = document.getElementById('blkCaret');
  // 标题行现在是 div（里面塞了「导出黑名单」按钮，button 不能嵌 button），
  // 所以键盘 Enter/Space 要自己接；点导出按钮时不能再顺带折叠。
  const setBlkOpen = (open) => {
    if (!body) return;
    body.style.display = open ? 'block' : 'none';
    if (caret) caret.textContent = open ? '收起' : '展开';
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { chrome.storage.local.set({ ui_blk_open: open }); } catch (_) {}
  };
  const toggleBody = () => {
    if (!body) return;
    setBlkOpen(body.style.display === 'none');
  };
  if (toggle && body && !toggle.dataset.bound) {
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('#blkExport')) return;
      toggleBody();
    });
    toggle.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleBody();
    });
  }
  const input = document.getElementById('blkNew');
  const addBtn = document.getElementById('blkAdd');
  const doAdd = async () => {
    if (!input) return;
    if (await addBlk(input.value)) input.value = '';
    input.focus();
  };
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => { doAdd(); });
  }
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      doAdd();
    });
  }
  const chips = document.getElementById('blkChips');
  if (chips && !chips.dataset.bound) {
    chips.dataset.bound = '1';
    chips.addEventListener('click', (e) => {
      const del = e.target.closest && e.target.closest('[data-blk-del]');
      if (del) {
        e.preventDefault();
        removeBlk(parseInt(del.getAttribute('data-blk-del'), 10));
        return;
      }
      const nm = e.target.closest && e.target.closest('[data-blk-edit]');
      if (nm) {
        e.preventDefault();
        beginBlkEdit(nm);
      }
    });
  }
  const exp = document.getElementById('blkExport');
  if (exp && !exp.dataset.bound) {
    exp.dataset.bound = '1';
    // 导出按钮在折叠标题行里：阻止冒泡，否则点导出会顺带折叠/展开整个面板
    exp.addEventListener('click', (e) => {
      e.stopPropagation();
      // 面板收起时导出成功提示在 #blkBody 里看不到，顺手展开让它可见
      if (body && body.style.display === 'none') setBlkOpen(true);
      exportBlk();
    });
    exp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    });
  }
  const reset = document.getElementById('blkReset');
  if (reset && !reset.dataset.bound) {
    reset.dataset.bound = '1';
    reset.addEventListener('click', async () => {
      const defs = await readBlkDefaults();
      if (!defs.length) {
        setFlash('blkMsg', '载入内置名单失败', 'er');
        return;
      }
      blkList = defs.slice();
      await saveBlk();
      setFlash('blkMsg', '已恢复内置默认名单 ' + blkList.length + ' 家', 'ok');
    });
  }
}

async function initBlocklist() {
  bindBlocklist();
  await loadBlk();
  try {
    const s = await chrome.storage.local.get('ui_blk_open');
    if (s && s.ui_blk_open) {
      const body = document.getElementById('blkBody');
      const caret = document.getElementById('blkCaret');
      const hd = document.getElementById('btnBlkToggle');
      if (body) body.style.display = 'block';
      if (caret) caret.textContent = '收起';
      if (hd) hd.setAttribute('aria-expanded', 'true');
    }
  } catch (_) {}
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
    return platform;
  } catch (_) { return ''; }
}

// 侧栏只服务 BOSS / 智联 / 前程。切到别的页面时自己收起来，
// background 也会做同一件事，这里是「点图标新开面板」等情况下的兜底。
async function closePanelIfUnsupported() {
  let tab = null;
  try {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0] || null;
  } catch (_) { return false; }
  if (!tab) return false;
  if (platformFromUrl(tab.url)) return false;
  const api = chrome.sidePanel;
  if (!api) return false;
  if (typeof api.close === 'function') {
    try { await api.close({ tabId: tab.id }); return true; } catch (_) {}
    try { await api.close({ windowId: tab.windowId }); return true; } catch (_) {}
  }
  // 老版本没有 close()：禁用这个 tab 的侧栏，面板会跟着收起
  try { await api.setOptions({ tabId: tab.id, enabled: false }); return true; } catch (_) {}
  return false;
}

// 三个平台的职位列表 DOM
function jobListEl(platform) {
  return document.getElementById({ boss: 'jobList', zp: 'zJobList', w51: 'wJobList' }[platform]);
}

function jobsOf(platform) {
  if (platform === 'boss') return allJobs;
  if (platform === 'zp') return zAllJobs;
  return wAllJobs;
}

// 统一走引擎那份 id 取值规则（BOSS 用 encryptId，智联/前程用 jobId）
function jobIdOf(job) {
  const rm = window.ResumeMatch;
  if (rm && typeof rm.jobAppliedId === 'function') return rm.jobAppliedId(job);
  return String((job && (job.encryptId || job.jobId)) || '').trim();
}

function pendingJobs(platform) {
  const rm = window.ResumeMatch;
  if (rm && typeof rm.pendingJobsOf === 'function') {
    return rm.pendingJobsOf(jobsOf(platform), appliedCache[platform], ignoredCache[platform]);
  }
  return jobsOf(platform).filter((j) => {
    const id = jobIdOf(j);
    return !!id && !appliedCache[platform].has(id) && !ignoredCache[platform].has(id);
  });
}

function reRenderJobList(platform) {
  const jobs = jobsOf(platform);
  if (platform === 'boss') renderBossList(jobs);
  else if (platform === 'zp') renderZpList(jobs);
  else renderW51List(jobs);
}

// 守卫用的统计：按「已投优先于忽略」的口径互斥计数（重叠的岗只算已投），
// 缺 id 的脏数据单独计，避免把 pending 数算错。
function guardStatsOf(platform) {
  const list = jobsOf(platform);
  const applied = appliedCache[platform];
  const ignored = ignoredCache[platform];
  let appliedN = 0, ignoredN = 0, missing = 0;
  let allApplied = list.length > 0, allIgnored = list.length > 0;
  for (const j of list) {
    const id = jobIdOf(j);
    if (!id) {
      missing++; allApplied = false; allIgnored = false;
      continue;
    }
    if (applied.has(id)) appliedN++; else allApplied = false;
    if (ignored.has(id)) ignoredN++; else allIgnored = false;
  }
  return { list, appliedN, ignoredN, missing, allApplied, allIgnored, total: list.length };
}

// 一条也说不出「还能投什么」时的原因文案（按钮提示与硬拦截共用）
function blockedReasonText(platform, stats) {
  const s = stats || guardStatsOf(platform);
  const n = s.total;
  if (s.allApplied) {
    return `本批 ${n} 条已全部投递成功，请重新匹配或点「清空」重置去重`;
  }
  if (s.allIgnored) {
    return `本批 ${n} 条岗位已全部忽略，可点「已忽略」旁的「清空」或在列表里点「恢复」`;
  }
  const parts = [];
  if (s.appliedN) parts.push('已投 ' + s.appliedN);
  if (s.ignoredN) parts.push('忽略 ' + s.ignoredN);
  if (s.missing) parts.push('缺 id ' + s.missing);
  // 只有缺 id：不是投递/忽略导致的，直接说清无法投递，别让用户以为被名单挡了
  if (!s.appliedN && !s.ignoredN && s.missing) {
    return `本批 ${n} 条都没有可用的岗位 id，无法投递，请重新匹配后再试`;
  }
  return `本批 ${n} 条已全部投递或忽略（${parts.join('、')}），请重新匹配后再投`;
}

// 投递守卫：把按钮置灰 + 在按钮下方说明原因/待投数量。
// 调用点：匹配完成、忽略切换、清空去重/忽略、投递结束、初始化。
async function refreshApplyGuard(platform) {
  const ids = {
    boss: { btn: 'btnStart', total: 'total', cnt: 'cnt', hint: 'applyHintBoss' },
    zp: { btn: 'zStart', total: 'zTotal', cnt: 'zCnt', hint: 'applyHintZp' },
    w51: { btn: 'wStart', total: 'wTotal', cnt: 'wCnt', hint: 'applyHintW51' },
  }[platform];
  if (!ids) return;
  const btn = document.getElementById(ids.btn);
  const hintEl = document.getElementById(ids.hint);
  const list = jobsOf(platform);
  const totalEl = document.getElementById(ids.total);
  if (totalEl) totalEl.textContent = list.length;

  const running = platform === 'boss' ? isRunning : platform === 'zp' ? zIsRunning : wIsRunning;
  if (running) return; // 投递中别抢按钮状态，由投递流程自己管

  if (!list.length) {
    if (btn) btn.disabled = true;
    if (hintEl) hintEl.textContent = '先点上方「读取简历并匹配职位」，拿到列表后才能批量投递。';
    return;
  }

  const pending = pendingJobs(platform);
  if (!pending.length) {
    if (btn) btn.disabled = true;
    if (hintEl) hintEl.textContent = blockedReasonText(platform) + '。';
    return;
  }

  const stats = guardStatsOf(platform);
  if (btn) btn.disabled = false;
  if (hintEl) {
    const parts = [];
    if (stats.appliedN) parts.push('已投 ' + stats.appliedN);
    if (stats.ignoredN) parts.push('忽略 ' + stats.ignoredN);
    if (stats.missing) parts.push('缺 id ' + stats.missing);
    hintEl.textContent = `待投 ${pending.length}/${list.length} 条`
      + (parts.length ? `（${parts.join('、')} 已剔除）` : '');
  }
  // 数量框默认值别超过待投数，避免用户以为要投 N 条却只发了 K 条
  const cntEl = document.getElementById(ids.cnt);
  if (cntEl) {
    const cur = parseInt(cntEl.value, 10);
    if (!cur || cur > pending.length) cntEl.value = pending.length;
    if (!(parseInt(cntEl.value, 10) >= 1)) cntEl.value = 1;
  }
}

// 点投递时的硬拦截：说明「为什么不能投」，并同步把按钮置灰
function blockApply(platform) {
  err(blockedReasonText(platform));
  const st = { boss: setStatus, zp: zSetStatus, w51: wSetStatus }[platform];
  if (st) st('无可投岗位', 'er');
  refreshApplyGuard(platform);
}

// 渲染：逐条淡入上浮，下标越靠后延迟越大（最多 320ms，长列表不会等太久）
// sub=true 才渲染公司/薪资第二行（BOSS 列表保持原来的单行紧凑）
function renderJobList(platform, jobs, accent, showSub) {
  const jl = jobListEl(platform);
  if (!jl) return;
  clearTimeout(jlTimers[platform]);
  jl.classList.remove('clearing');
  if (!jobs.length) {
    jl.innerHTML = '';
    jl.style.display = 'none';
    return;
  }
  jl.innerHTML = jobs.map((j, i) => {
    const delay = Math.min(i * 28, 320);
    const sub = showSub && !!(j.company || j.info);
    const jid = jobIdOf(j);
    const ignored = !!jid && ignoredCache[platform].has(jid);
    return `<div class="jrow${ignored ? ' ignored' : ''}" data-idx="${i}" style="animation-delay:${delay}ms">`
      + `<span class="jidx" style="color:${accent}">${i + 1}.</span>`
      + `<div class="jmain">`
      + `<div class="jname" title="${escHtml(j.name)}">${escHtml(j.name)}</div>`
      + (sub ? `<div class="jsub">${escHtml(j.company || '')} ${escHtml(j.info || '')}</div>` : '')
      + `</div>`
      + (jid ? `<button type="button" class="jignore${ignored ? ' on' : ''}" data-ign="${i}" title="${ignored ? '恢复：重新参与投递' : '忽略：本轮及后续匹配都跳过'}">${ignored ? '恢复' : '忽略'}</button>` : '')
      + (j.score != null ? `<span class="jscore">${j.score}</span>` : '')
      + '</div>';
  }).join('');
  jl.style.display = 'block';
  jl.scrollTop = 0;
}

// 只换某一行的忽略态，不整表重渲染（避免重复播放入场动画、丢滚动位置）
function paintIgnoreRow(platform, idx, ignored) {
  const jl = jobListEl(platform);
  if (!jl) return;
  const row = jl.querySelector('.jrow[data-idx="' + idx + '"]');
  if (!row) return;
  row.classList.toggle('ignored', ignored);
  const btn = row.querySelector('.jignore');
  if (!btn) return;
  btn.textContent = ignored ? '恢复' : '忽略';
  btn.classList.toggle('on', ignored);
  btn.title = ignored ? '恢复：重新参与投递' : '忽略：本轮及后续匹配都跳过';
}

// 忽略/恢复按钮走事件委托：列表每次 innerHTML 重渲染都不用重新绑定
function bindIgnoreButtons() {
  for (const p of PLATFORMS) {
    const jl = jobListEl(p);
    if (!jl || jl.dataset.ignBound) continue;
    jl.dataset.ignBound = '1';
    jl.addEventListener('click', (e) => {
      const target = e.target;
      const btn = target && target.closest ? target.closest('[data-ign]') : null;
      if (!btn || !jl.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-ign'), 10);
      if (!Number.isFinite(idx)) return;
      toggleIgnoreJob(p, idx);
    });
  }
}

// 点忽略/恢复：落库 ignored_ids_<平台>，再刷新守卫状态
async function toggleIgnoreJob(platform, idx) {
  const list = jobsOf(platform);
  const job = list[idx];
  if (!job) return;
  const jid = jobIdOf(job);
  if (!jid) { err('这条岗位没有可用 id，无法忽略'); return; }
  const set = ignoredCache[platform];
  const willIgnore = !set.has(jid);
  if (willIgnore) set.add(jid); else set.delete(jid);
  const arr = Array.from(set).slice(-IGNORED_CAP);
  await chrome.storage.local.set({ ['ignored_ids_' + platform]: arr });
  paintIgnoreRow(platform, idx, willIgnore);
  await refreshDayCounts();
  await refreshApplyGuard(platform);
  info((willIgnore ? '已忽略：' : '已恢复：') + (job.name || jid)
    + (willIgnore ? '（本轮及后续匹配都跳过）' : ''));
}

// 重新匹配前清掉上一轮结果：旧列表淡出收起，配置卡和计数一起归零，
// 免得匹配期间还能拿着上一轮的岗位去批量投递
function clearMatchResult(platform) {
  const cfgIds = { boss: 'cfg', zp: 'zCfg', w51: 'wCfg' };
  const infoIds = { boss: 'fetchInfo', zp: 'zFetchInfo', w51: 'wFetchInfo' };
  const totalIds = { boss: 'total', zp: 'zTotal', w51: 'wTotal' };
  const cntIds = { boss: 'cnt', zp: 'zCnt', w51: 'wCnt' };
  const stIds = { boss: 'pst', zp: 'zPst', w51: 'wPst' };
  if (platform === 'boss') allJobs = [];
  else if (platform === 'zp') zAllJobs = [];
  else if (platform === 'w51') wAllJobs = [];

  const cfg = document.getElementById(cfgIds[platform]);
  if (cfg) cfg.style.display = 'none';
  const total = document.getElementById(totalIds[platform]);
  if (total) total.textContent = '0';
  const cnt = document.getElementById(cntIds[platform]);
  if (cnt) cnt.value = '';
  const infoEl = document.getElementById(infoIds[platform]);
  if (infoEl) { infoEl.textContent = ''; infoEl.classList.remove('flash'); }
  const st = document.getElementById(stIds[platform]);
  if (st) { st.textContent = ''; st.className = 'st'; }
  const hintEl = document.getElementById({ boss: 'applyHintBoss', zp: 'applyHintZp', w51: 'applyHintW51' }[platform]);
  if (hintEl) hintEl.textContent = '';
  const startBtn = document.getElementById({ boss: 'btnStart', zp: 'zStart', w51: 'wStart' }[platform]);
  if (startBtn) startBtn.disabled = true;

  const jl = jobListEl(platform);
  if (!jl) return;
  clearTimeout(jlTimers[platform]);
  if (!jl.children.length) {
    jl.classList.remove('clearing');
    jl.style.display = 'none';
    return;
  }
  jl.classList.remove('clearing');
  void jl.offsetWidth; // 强制重排，让动画能重放
  jl.classList.add('clearing');
  jlTimers[platform] = setTimeout(() => {
    jl.innerHTML = '';
    jl.style.display = 'none';
    jl.classList.remove('clearing');
  }, 180);
}

function renderBossList(jobs) {
  renderJobList('boss', jobs, '#667eea', false);
}

function renderZpList(jobs) {
  renderJobList('zp', jobs, '#f5576c', true);
}

function renderW51List(jobs) {
  renderJobList('w51', jobs, '#34d399', true);
}

// 结果文案一出现就闪一下绿色，方便一眼看到新结果
function flashInfo(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
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
  document.getElementById('cnt').value = jobs.length || '';
  document.getElementById('cfg').style.display = jobs.length ? '' : 'none';
  renderBossList(jobs);
  flashInfo(infoEl);
  refreshApplyGuard('boss');
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
  document.getElementById('zCnt').value = jobs.length || '';
  document.getElementById('zCfg').style.display = jobs.length ? '' : 'none';
  renderZpList(jobs);
  flashInfo(infoEl);
  refreshApplyGuard('zp');
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
  document.getElementById('wCnt').value = jobs.length || '';
  document.getElementById('wCfg').style.display = jobs.length ? '' : 'none';
  renderW51List(jobs);
  flashInfo(infoEl);
  refreshApplyGuard('w51');
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

function progCountText(p) {
  const dup = p.dupC ? '/' + p.dupC + '🔁' : '';
  return `（${p.okC}✅${dup}/${p.failC}❌）`;
}
function allSettled(p) {
  // 前程的「简历投递/页面跳转」属于跳过，不记成功也不记失败，
  // 只靠 okC+dupC 判断会一直显示成红色失败
  if (p.failC) return false;
  if (p.idx >= p.total) return true;
  return p.okC + (p.dupC || 0) === p.total;
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
      document.getElementById('ptxt').textContent = `进度 ${p.idx}/${p.total}${progCountText(p)}`;
      document.getElementById('pfill').style.width = `${Math.round(p.idx / p.total * 100)}%`;
      setStatus(p.status, p.running ? '' : (allSettled(p) ? 'ok' : 'er'));
      if (!p.running) {
        clearInterval(timer); isRunning = false;
        document.getElementById('btnStart').disabled = false; hideCancel();
        // 投递结束后按最新 applied 名单重算守卫：全投完这里会把按钮置灰并说明原因
        loadGuardSets('boss').then(() => refreshApplyGuard('boss'));
      }
    } else if (platform === 'zp') {
      document.getElementById('zPtxt').textContent = `进度 ${p.idx}/${p.total}${progCountText(p)}`;
      document.getElementById('zPfill').style.width = `${Math.round(p.idx / p.total * 100)}%`;
      zSetStatus(p.status, p.running ? '' : (allSettled(p) ? 'ok' : 'er'));
      if (!p.running) {
        clearInterval(timer); zIsRunning = false;
        document.getElementById('zStart').disabled = false; hideCancel();
        loadGuardSets('zp').then(() => refreshApplyGuard('zp'));
      }
    } else {
      document.getElementById('wPtxt').textContent = `进度 ${p.idx}/${p.total}${progCountText(p)}`;
      document.getElementById('wPfill').style.width = `${Math.round(p.idx / p.total * 100)}%`;
      wSetStatus(p.status, p.running ? '' : (allSettled(p) ? 'ok' : 'er'));
      if (!p.running) {
        clearInterval(timer); wIsRunning = false;
        document.getElementById('wStart').disabled = false; hideCancel();
        loadGuardSets('w51').then(() => refreshApplyGuard('w51'));
      }
    }
  }, 500);
}

// 只改了方向勾选、没点「保存规则」就直接匹配，会让引擎读到上次的旧勾选。
// 匹配前把当前方向状态静默落库一次（其它字段沿用已保存的画像）。
async function persistDirections() {
  try {
    // 编辑器没渲染过 = 手上没有可信的勾选状态，直接沿用已存画像
    if (!directionEditorReady) return;
    const prev = await window.ResumeAI.loadProfile();
    if (!prev || !Array.isArray(prev.titles) || !prev.titles.length) return;
    const picked = getSelectedDirections();
    const opts = directionOptionsCache.slice();
    const keywords = {};
    for (const n of opts) {
      const words = directionKeywordsCache[n];
      if (Array.isArray(words) && words.length) keywords[n] = words.slice();
    }
    const same = JSON.stringify(picked) === JSON.stringify(prev.directions || [])
      && JSON.stringify(opts) === JSON.stringify(prev.directionOptions || [])
      && JSON.stringify(keywords) === JSON.stringify(prev.directionKeywords || {})
      && JSON.stringify(excludeKeywordList) === JSON.stringify(prev.excludeKeywords || []);
    if (same) return;
    await window.ResumeAI.saveProfile(Object.assign({}, prev, {
      directions: picked,
      excludeKeywords: excludeKeywordList.slice(),
      directionOptions: opts,
      directionKeywords: keywords,
      otherDirections: prev.otherDirections || {},
      excludeKeywordsRemoved: removedKeywordsCache.slice(),
      directionsRemoved: directionsRemovedCache.slice(),
      directionKeywordsEdited: Array.from(editedKeywordsCache),
    }), { fileName: prev.fileName || '', keepParsedAt: true });
  } catch (_) {}
}

async function fetchBossByResume() {
  await persistDirections();
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
  clearMatchResult('boss');
  btn.disabled = true; btn.textContent = '⏳ 匹配中...';
  const matchPoll = startMatchProgressPoll('boss');
  let loadedVer = '';
  try { loadedVer = chrome.runtime.getManifest().version; } catch (_) {}
  if (loadedVer) info('匹配引擎 v' + loadedVer);
  try {
    const { jobs, stopped, fallback, listCount, refineTotal, refinePassed } = await window.ResumeMatch.run({ tabId: tab.id, log: info });
    applyBossJobs(jobs, { fallback, listCount, refineTotal, refinePassed });
    if (!jobs.length) err('匹配后为 0 条。请看上方提示和日志。');
    else if (fallback) {
      err('精排后为 0 条，仅回退精排未判定的 ' + jobs.length + ' 条（已否决的不放回）。');
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
  await persistDirections();
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
  clearMatchResult('zp');
  btn.disabled = true; btn.textContent = '⏳ 匹配中...';
  const matchPoll = startMatchProgressPoll('zp');
  try {
    const { jobs, listCount, fallback, stopped, refineTotal, refinePassed } = await window.ResumeMatch.runZhaopin({ tabId: tab.id, log: info });
    applyZpJobs(jobs, { listCount, fallback, refineTotal, refinePassed });
    if (!jobs.length) err('智联匹配为 0 条。请看上方提示和日志（派遣/代招、精排或阈值）。');
    else if (fallback) {
      err('智联精排后为 0 条，仅回退精排未判定的 ' + jobs.length + ' 条（已否决的不放回）。');
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
  if (isRunning) return;
  if (!allJobs.length) {
    setStatus('请先匹配岗位', 'er');
    err('还没有匹配结果：请先点「读取简历并匹配职位」，拿到列表后再批量打招呼');
    return;
  }
  // 已投 / 忽略 都从缓存取（初始化与每次刷新计数时同步过）；保险起见再读一次 storage
  await loadGuardSets('boss');
  const pending = pendingJobs('boss');
  if (!pending.length) { blockApply('boss'); return; }
  const cnt = Math.min(parseInt(document.getElementById('cnt').value) || 5, pending.length);
  const jobs = pending.slice(0, cnt);
  info(`待投 ${pending.length} 条，本次发 ${jobs.length} 条（已投/忽略已剔除）`);
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
  if (zIsRunning) return;
  if (!zAllJobs.length) {
    zSetStatus('请先匹配岗位', 'er');
    err('还没有智联匹配结果：请先点「读取简历并匹配职位」，拿到列表后再批量投递');
    return;
  }
  await loadGuardSets('zp');
  const pending = pendingJobs('zp');
  if (!pending.length) { blockApply('zp'); return; }
  const cnt = Math.min(parseInt(document.getElementById('zCnt').value) || 5, pending.length);
  const jobs = pending.slice(0, cnt);
  info(`待投 ${pending.length} 条，本次发 ${jobs.length} 条（已投/忽略已剔除）`);
  const minInt = parseInt(document.getElementById('zMin').value) || 3;
  const maxInt = parseInt(document.getElementById('zMax').value) || 5;
  chrome.storage.local.set({ minInt, maxInt });

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

  let resolved;
  try {
    resolved = await resolveZpResume(zlTab, at, rt);
  } catch (e) {
    err('读取智联简历编号失败: ' + (e.message || e));
    return;
  }
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
  await persistDirections();
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
  clearMatchResult('w51');
  btn.disabled = true; btn.textContent = '⏳ 匹配中...';
  const matchPoll = startMatchProgressPoll('w51');
  try {
    const { jobs, listCount, fallback, stopped, refineTotal, refinePassed } = await window.ResumeMatch.run51job({ tabId: tab.id, log: info });
    applyW51Jobs(jobs, { listCount, fallback, refineTotal, refinePassed });
    if (!jobs.length) err('前程匹配为 0 条。请看上方提示和日志（校招、不可选中、派遣或阈值）。');
    else if (fallback) {
      err('前程精排后为 0 条，仅回退精排未判定的 ' + jobs.length + ' 条（已否决的不放回）。');
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
  if (wIsRunning) return;
  if (!wAllJobs.length) {
    wSetStatus('请先匹配岗位', 'er');
    err('还没有前程匹配结果：请先点「读取简历并匹配职位」，拿到列表后再批量投递');
    return;
  }
  await loadGuardSets('w51');
  const pending = pendingJobs('w51');
  if (!pending.length) { blockApply('w51'); return; }
  const cnt = Math.min(parseInt(document.getElementById('wCnt').value) || 5, pending.length);
  const jobs = pending.slice(0, cnt);
  info(`待投 ${pending.length} 条，本次发 ${jobs.length} 条（已投/忽略已剔除）`);
  const minInt = parseInt(document.getElementById('wMin').value) || 3;
  const maxInt = parseInt(document.getElementById('wMax').value) || 5;
  chrome.storage.local.set({ minInt, maxInt });

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

  wIsRunning = true;
  document.getElementById('wStart').disabled = true;
  document.getElementById('wProg').style.display = '';
  showCancel();
  progressLogCursor.w51 = 0;
  // 前程投递在页面上下文里点按钮，Cookie 自动带上，不需要传 cookieStr
  chrome.runtime.sendMessage({
    action: 'w51_start', jobs, tabId: wTab.id, searchUrl, min: minInt, max: maxInt,
  });
  pollProgress('w51');
}

document.addEventListener('DOMContentLoaded', async () => {
  bindMselOutsideClick();
  bindDegreePicker();
  bindDirectionPicker();
  bindExcludePicker();
  bindTextareaFit();
  await initBlocklist();
  // 显示已加载的版本，方便确认改动是否真的生效（没重载扩展会看到旧版本号）
  const verEl = document.getElementById('appVersion');
  if (verEl && chrome.runtime.getManifest) {
    try { verEl.textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
  }
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
  // 初次加载：把守卫状态算一遍（没匹配结果时按钮本就是灰的/隐藏的）
  for (const p of PLATFORMS) refreshApplyGuard(p);

  document.getElementById('tabBoss').addEventListener('click', () => switchTab('boss'));
  document.getElementById('tabZhaopin').addEventListener('click', () => switchTab('zhaopin'));
  document.getElementById('tab51').addEventListener('click', () => switchTab('51job'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const dayChanged = !!(changes[dayCountKey('boss')] || changes[dayCountKey('zp')] || changes[dayCountKey('w51')]);
    const appliedChanged = !!(changes.applied_ids_boss || changes.applied_ids_zp || changes.applied_ids_w51
      || changes.w51_matched_ids);
    const ignoredChanged = !!(changes.ignored_ids_boss || changes.ignored_ids_zp || changes.ignored_ids_w51);
    if (!dayChanged && !appliedChanged && !ignoredChanged) return;

    // 只有「别处改的」忽略名单才需要重画列表：本窗口自己点忽略时缓存已是最新，
    // 重画反而会让整行入场动画重播。已投名单在投递中会被频繁写入，也只重算守卫。
    const repaint = [];
    for (const p of PLATFORMS) {
      const ch = changes['ignored_ids_' + p];
      if (!ch) continue;
      const next = new Set((Array.isArray(ch.newValue) ? ch.newValue : []).map(String));
      const cur = ignoredCache[p];
      const same = next.size === cur.size && Array.from(next).every((x) => cur.has(x));
      if (!same) repaint.push(p);
    }
    Promise.resolve(refreshDayCounts()).then(() => {
      for (const p of repaint) reRenderJobList(p);
      for (const p of PLATFORMS) refreshApplyGuard(p);
    });
  });
  document.getElementById('btnApi').addEventListener('click', () => {
    document.getElementById('apiPanel').classList.toggle('open');
  });
  document.getElementById('btnSaveApi').addEventListener('click', saveApiSettings);
  document.getElementById('btnSaveProfile').addEventListener('click', saveProfileEdits);
  document.getElementById('clearAppliedBoss')?.addEventListener('click', () => clearAppliedIds('boss'));
  document.getElementById('clearAppliedZp')?.addEventListener('click', () => clearAppliedIds('zp'));
  document.getElementById('clearAppliedW51')?.addEventListener('click', () => clearAppliedIds('w51'));
  document.getElementById('clearIgnoredBoss')?.addEventListener('click', () => clearIgnoredIds('boss'));
  document.getElementById('clearIgnoredZp')?.addEventListener('click', () => clearIgnoredIds('zp'));
  document.getElementById('clearIgnoredW51')?.addEventListener('click', () => clearIgnoredIds('w51'));
  bindIgnoreButtons();
  document.getElementById('btnToggleResume').addEventListener('click', () => {
    const card = document.getElementById('resumeCard');
    const open = card && card.classList.contains('collapsed');
    setResumeFold(!!open);
    // 折叠状态下量不到内容高度，展开后重新撑一次
    if (open) {
      for (const id of ['pfSkills', 'pfWork']) {
        const el = document.getElementById(id);
        if (el) { delete el.dataset.manual; fitTextarea(el); }
      }
    }
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

  chrome.tabs.onActivated.addListener(async () => {
    if (await closePanelIfUnsupported()) return;
    followActiveSite();
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status !== 'complete' && !info.url) return;
    if (await closePanelIfUnsupported()) return;
    followActiveSite();
  });

  // 点图标新开面板时不会触发 tab 事件，加载完先自查一次
  await closePanelIfUnsupported();
});
