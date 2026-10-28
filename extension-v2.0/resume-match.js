// resume-match.js — 按本地简历匹配拉取 BOSS 职位（独立于搜索页抓取）
window.ResumeMatch = (() => {
  const LIST_THRESHOLD = 40;
  const REFINE_MAX = 20;
  const REFINE_CONCURRENCY = 4;
  const SEARCH_PAGES = 2;
  const SEARCH_PAGES_MAX = 5;
  // 已投太多、池子被投空时自动加深翻页
  const SEARCH_PAGES_DEEP = 12;
  const SEARCH_FRESH_TARGET = 40;
  // 粗筛为 0 时换关键词兜底的触发阈值
  const FALLBACK_MIN = 1;
  const DETAIL_GAP_MS = 1500;
  const JOB51_SORT_LATEST = '1';

  function setMatchProgress(platform, data) {
    try { chrome.storage.local.set({ [platform + '_match_progress']: data }); } catch (_) {}
  }

  const CITY_CODE = {
    '北京': '101010100', '上海': '101020100', '广州': '101280100', '深圳': '101280600',
    '杭州': '101210100', '成都': '101270100', '南京': '101190100', '武汉': '101200100',
    '西安': '101110100', '苏州': '101190400', '重庆': '101040100', '天津': '101030100',
    '长沙': '101250100', '郑州': '101180100', '东莞': '101280800', '合肥': '101220100',
  };
  const SKILL_DICT = [
    'Java', 'Python', 'Go', 'Golang', 'C++', 'C#', 'JavaScript', 'TypeScript', 'Node',
    'Spring', 'SpringBoot', 'MyBatis', 'MySQL', 'Redis', 'Kafka', 'RabbitMQ', 'MongoDB',
    'ElasticSearch', 'ES', 'Docker', 'K8s', 'Kubernetes', 'Linux', 'Git', 'Nginx',
    'Vue', 'React', 'Android', 'iOS', 'Flutter', 'Spark', 'Flink', 'Hadoop',
    '微服务', '分布式', '高并发', '支付', '结算', '对账', '风控', '推荐', '广告',
  ];
  const VETO = /销售|客服|主播|带货|外卖|骑手|司机|美容|美发|淘宝客服|电销|保险经纪/;
  const DISPATCH = /派遣|代招|代聘|外包|外派|劳务派遣|岗位外包|人力外包|招聘外包|外包招聘|驻场外包|劳务外包/;
  const TECH = /开发|工程师|后端|前端|客户端|算法|Java|Python|Go|程序|软件|研发/;
  const ZHAOPIN_CITY = {
    '北京': '530', '上海': '538', '广州': '763', '深圳': '765',
    '杭州': '653', '成都': '801', '南京': '635', '武汉': '736',
    '西安': '854', '苏州': '639', '重庆': '551', '天津': '531',
    '长沙': '749', '郑州': '719', '东莞': '768', '合肥': '724',
  };
  const JOB51_CITY = {
    '北京': '010000', '上海': '020000', '广州': '030200', '深圳': '040000',
    '杭州': '080200', '成都': '090200', '南京': '070200', '武汉': '180200',
    '西安': '200200', '苏州': '070300', '重庆': '060000', '天津': '050000',
    '长沙': '190200', '郑州': '170200', '东莞': '030800', '合肥': '150200',
  };
  const CAMPUS = /校招|校园招聘|应届生专场|仅限应届|仅校招|高校招聘|大学生招聘|管培生专场/;
  const UNSELECT = /已申请|已投递|已沟通|停止招聘|职位下线|已结束|暂停招聘|网申|到官网申请|外部投递|不可投递|暂不支持|无法申请/;
  const NAME_EXTRA = /实习生|兼职|钟点工|临时工/;
  const RESUME_FLOW = /xyz\.51job\.com|consumer\/pc\/resume|External\/Apply|JobsSelect\.aspx/i;
  const RESUME_FLOW_BTN = /网申|官网申请|外部申请|完善简历|选择简历|填写简历|到官网|外部投递/;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── BOSS 限流（code=37）──────────────────────────────────────────────
  // 同一个页面文档里只够搜一轮：第二轮 joblist 接口一律回 code=37、n=0，
  // 必须刷新出新的页面令牌才能再搜。用 performance.timeOrigin 判断
  // 是不是同一个文档，比记时间戳准（用户手动刷新过就不会再白刷一次）。
  let lastSearchBlock = null;

  async function bossPageStamp(tabId) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => ({ t: Math.round(performance.timeOrigin), href: location.href }),
      });
      return (res && res[0] && res[0].result) || null;
    } catch (_) { return null; }
  }

  // 只存一份「当前标签页 + 文档」记录：按 tabId 分开存会在 storage 里越攒越多，
  // 而同一时间只会用到一个 BOSS 标签页。
  const STAMP_KEY = 'boss_used_page';

  async function readUsedStamp(tabId) {
    try {
      const s = await chrome.storage.local.get(STAMP_KEY);
      const rec = s[STAMP_KEY];
      return rec && Number(rec.tabId) === Number(tabId) ? rec : null;
    } catch (_) { return null; }
  }

  async function markUsedStamp(tabId) {
    try {
      const st = await bossPageStamp(tabId);
      if (!st) return;
      await chrome.storage.local.set({ [STAMP_KEY]: { tabId, t: st.t, href: st.href } });
    } catch (_) {}
  }

  // 刷新并等到「确实是新文档」：只看 status==='complete' 会误判——
  // 刚调 reload 的那一瞬间 status 还是旧的 complete。用 timeOrigin 变了才算数。
  async function reloadBossTab(tabId, log, why) {
    log(why + '，刷新页面拿到新令牌后重试');
    const before = await bossPageStamp(tabId);
    try { await chrome.tabs.reload(tabId); } catch (e) {
      log('刷新失败: ' + (e.message || e));
      return null;
    }
    const start = Date.now();
    let fresh = null;
    while (Date.now() - start < 20000) {
      await sleep(400);
      let tab = null;
      try { tab = await chrome.tabs.get(tabId); } catch (_) { return null; }
      if (!tab) return null;
      const st = await bossPageStamp(tabId);
      const changed = !before || (st && st.t !== before.t);
      if (changed && tab.status === 'complete') { fresh = st; break; }
    }
    if (!fresh) {
      log('页面刷新后还是旧文档，可能被别的操作打断，继续用当前页面搜索');
      return null;
    }
    // 页面自己的 joblist 请求先跑完，别跟它抢令牌
    await sleep(1500);
    log('页面已刷新，重新搜索');
    return fresh;
  }

  async function loadResume() {
    try {
      const s = await chrome.storage.local.get('ai_profile');
      const p = s.ai_profile;
      if (p && [].concat(p.titles || []).filter(Boolean).length) {
        return {
          file: 'AI:' + (p.fileName || 'docx'),
          text: JSON.stringify({
            titles: p.titles,
            city: p.city || '',
            skills: p.skills || [],
            workKeywords: p.workKeywords || [],
            salaryMin: p.salaryMin || 0,
            scaleMin: p.scaleMin || 0,
            degrees: p.degrees || [],
            directions: p.directions || [],
            directionOptions: p.directionOptions || [],
            directionKeywords: p.directionKeywords,
            otherDirections: p.otherDirections,
          }),
        };
      }
    } catch (_) {}
    throw new Error('请先上传 Word 简历并解析后再匹配职位');
  }

  function uniq(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const k = String(x || '').trim();
      if (!k || seen.has(k.toLowerCase())) continue;
      seen.add(k.toLowerCase());
      out.push(k);
    }
    return out;
  }

  function splitWords(s) {
    return String(s || '').split(/[\s,，、/|；;+]+/).map(x => x.trim()).filter(x => x.length >= 2 && x.length <= 16);
  }

  function extractProfile(text) {
    const raw = String(text || '').trim();
    if (raw.startsWith('{')) {
      try {
        const j = JSON.parse(raw);
        const dirFromAi = parseAiDirections(j.directions);
        const dirOpts = normalizeDirectionOptions(j.directionOptions);
        // directions 一律当作用户勾选原样保留：AI 解析出来的那一次就是「全部勾上」的默认值，
        // 之后由用户在 UI 里增删。清空它会让方向硬排除退化成「不限」。
        const dirs = dirFromAi ? dirFromAi.options : j.directions;
        // AI 可能直接给 [{name, keywords}]，关键词要一并接住
        const kwFromAi = directionKeywordsFromAi(j.directions);
        return normalizeProfile({
          titles: j.titles || j.title || [],
          city: j.city || '',
          skills: j.skills || [],
          workKeywords: j.workKeywords || j.work || [],
          salaryMin: j.salaryMin,
          scaleMin: j.scaleMin,
          degrees: j.degrees,
          directions: dirs,
          directionOptions: dirOpts.length ? dirOpts : (dirFromAi ? dirFromAi.options : undefined),
          directionKeywords: Object.keys(kwFromAi).length ? kwFromAi : j.directionKeywords,
          otherDirections: j.otherDirections,
        });
      } catch (_) {}
    }

    const titles = [];
    const intent = raw.match(/(?:求职意向|期望职位|目标职位|意向岗位)[：:\s]*([^\n]+)/);
    if (intent) titles.push(...splitWords(intent[1]).slice(0, 4));
    const roleLine = raw.match(/(?:职位|岗位)[：:\s]*([^\n]{2,20})/);
    if (roleLine) titles.push(...splitWords(roleLine[1]).slice(0, 2));

    let city = '';
    const cityM = raw.match(/(?:期望城市|意向城市|工作城市|所在地)[：:\s]*([^\n]{2,10})/)
      || raw.match(/(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|重庆|天津|长沙|郑州|东莞|合肥)/);
    if (cityM) city = (cityM[1] || cityM[0]).replace(/市$/, '');

    const skills = [];
    for (const s of SKILL_DICT) {
      const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(raw)) skills.push(s);
    }
    const skillSec = raw.match(/(?:专业技能|技能特长|掌握技能|技术栈)[：:\s]*([\s\S]{0,400})/);
    if (skillSec) skills.push(...splitWords(skillSec[1]).slice(0, 20));

    let workBlob = '';
    const workSec = raw.match(/(?:工作经历|工作内容|项目经历|职责)[：:\s]*([\s\S]+)/);
    if (workSec) workBlob = workSec[1].slice(0, 2500);
    else workBlob = raw.slice(0, 2500);
    const workKeywords = splitWords(workBlob.replace(/<[^>]+>/g, ' '))
      .filter(w => !/^(负责|参与|完成|进行|以及|或者|我们|公司|工作|项目|以上|以下|相关)$/.test(w))
      .slice(0, 40);

    if (!titles.length) {
      if (/后端|Java|服务端/.test(raw)) titles.push('Java', '后端');
      else if (/前端|Vue|React/.test(raw)) titles.push('前端');
      else if (/算法/.test(raw)) titles.push('算法');
      else if (/Android|安卓/.test(raw)) titles.push('Android');
      else if (TECH.test(raw)) titles.push('开发工程师');
    }

    return normalizeProfile({ titles, city, skills, workKeywords });
  }

  function normalizeProfile(p) {
    const titles = uniq([].concat(p.titles || [])).slice(0, 5);
    const skills = uniq([].concat(p.skills || [])).slice(0, 24);
    const workKeywords = uniq([].concat(p.workKeywords || [])).slice(0, 40);
    const city = String(p.city || '').replace(/市$/, '').trim();
    if (!titles.length) throw new Error('未能从简历抽出期望职位，请重新上传 Word 并用 AI 解析');
    return {
      titles, city, cityCode: CITY_CODE[city] || '', skills, workKeywords,
      salaryMin: salaryMinK(p.salaryMin), scaleMin: salaryMinK(p.scaleMin),
      degrees: p.degrees === undefined ? undefined : normalizeDegrees(p.degrees),
      directions: p.directions === undefined ? undefined : normalizeDirections(p.directions),
      directionOptions: p.directionOptions === undefined
        ? (p.directions === undefined ? undefined : normalizeDirectionOptions(p.directions))
        : normalizeDirectionOptions(p.directionOptions),
      // 方向名 → 专属关键词，AI 生成 + 用户可改
      directionKeywords: p.directionKeywords === undefined
        ? undefined
        : cleanKeywordMap(p.directionKeywords),
      // 同领域但不匹配的相邻方向，只参与判定、不进下拉
      otherDirections: p.otherDirections === undefined
        ? undefined
        : cleanKeywordMap(p.otherDirections),
    };
  }

  // 文字搜索词清洗：去掉泛词和空项
  function cleanKeywords(list) {
    const out = [];
    for (const raw of [].concat(list || [])) {
      const w = String(raw || '').trim();
      if (!w || w.length > 20) continue;
      if (DIRECTION_GENERIC_WORDS.has(w)) continue;
      if (out.some(x => x.toLowerCase() === w.toLowerCase())) continue;
      if (out.length >= 14) break;
      out.push(w);
    }
    return out;
  }

  function cleanKeywordMap(map) {
    const out = {};
    if (!map || typeof map !== 'object') return out;
    for (const k of Object.keys(map)) {
      const name = String(k || '').trim();
      if (!name) continue;
      const words = cleanKeywords(map[k]);
      if (words.length) out[name] = words;
    }
    return out;
  }

  const DEGREE_OPTS = ['高中', '中专', '大专', '本科', '硕士', '博士'];

  // 方向不再有内置词表：AI 按简历自由生成方向名 + 专属关键词，
  // 用户可改词、可新增。判定全部本地跑，匹配时不再调用 AI。
  const DIRECTION_MAX_OPTS = 40;

  // 泛词：对区分方向没有信息量，留着会让同族方向互相抢
  // （「座舱自动化测试工程师」里的「自动化」会把汽车岗吸到自动化测试上）
  const DIRECTION_GENERIC_TOKENS = [
    '高级', '资深', '中级', '初级', '首席', '专家', '主管', '助理', '专员', '经理',
    '工程师', '开发', '测试', '设计', '产品', '运营', '项目', '技术', '业务', '岗',
  ];
  const DIRECTION_GENERIC_WORDS = new Set([
    ...DIRECTION_GENERIC_TOKENS,
    '自动化', '智能化', '工程师', '实习', '全职', '兼职', '工作', '职位', '岗位',
    '相关', '经验', '方向', '领域', '行业', '综合', '体验', '管理', '服务',
  ]);

  // 方向关键词：AI 给的优先；没给过（老画像 / 用户新加还没填词）就退回名字本身。
  // 给了词也把名字带上——AI 漏写方向名时，「硬件测试工程师」这种直写方向名的
  // 岗位就一个词都命中不了，反而漏过。纯泛名（自动化测试/测试工程师）不带，
  // 带上只会跟同族方向抢。
  function directionKeywordsOf(name, profile) {
    const n = String(name || '').trim();
    if (!n) return [];
    const kw = profile && profile.directionKeywords && profile.directionKeywords[n];
    if (Array.isArray(kw) && kw.length) return withName(kw.slice(), n);
    const other = profile && profile.otherDirections && profile.otherDirections[n];
    if (Array.isArray(other) && other.length) return withName(other.slice(), n);
    return [n];
  }

  function withName(words, name) {
    if (directionCoreOf(name) === '') return words;
    const key = String(name).toLowerCase();
    if (words.some(w => String(w).toLowerCase() === key)) return words;
    words.push(name);
    return words;
  }



  function directionCoreOf(name) {
    let s = String(name || '').toLowerCase();
    for (const t of DIRECTION_GENERIC_TOKENS) s = s.split(t).join('');
    return s.replace(/[\s\-_/\\（）()·、,，]+/g, '');
  }

  // 名字去掉通用词后什么都不剩 → 泛名，不具判定力。
  // 但 AI 给过专属关键词的方向要照常参与判定（「产品经理」这种名字里带泛词，
  // 可它的关键词是有区分度的，不能因为名字被跳过）。
  function isGenericDirectionName(name, profile) {
    const n = String(name || '').trim();
    if (!n) return true;
    const words = directionKeywordsOf(n, profile);
    if (words.length > 1) return false;
    return directionCoreOf(n) === '';
  }

  // 最长命中词长度：命中数和位置都打平时用这个
  function longestHit(text, words) {
    const low = String(text || '').toLowerCase();
    let best = 0;
    for (const w of words || []) {
      const k = String(w || '').toLowerCase();
      if (k && low.includes(k) && k.length > best) best = k.length;
    }
    return best;
  }

  // 命中词在文本里首次出现的位置；越小越靠前。
  // 中文岗位名基本是「领域限定 + 职能」，「座舱自动化测试」里靠前的
  // 「座舱」才是区分方向的词，靠后的「自动化测试」只是职能。
  function firstHitIndex(text, words) {
    const low = String(text || '').toLowerCase();
    let best = -1;
    for (const w of words || []) {
      const k = String(w || '').toLowerCase();
      if (!k) continue;
      const i = low.indexOf(k);
      if (i < 0) continue;
      if (best < 0 || i < best) best = i;
    }
    return best < 0 ? 999 : best;
  }

  // 统一成一维方向名数组，兼容：字符串 / 字符串数组 / {name} 对象数组
  function normalizeDirectionOptions(list) {
    const out = [];
    for (const item of [].concat(list || [])) {
      if (item == null) continue;
      const n = typeof item === 'object'
        ? String(item.name || item.title || '').trim()
        : String(item || '').trim();
      if (!n || n === '__all__') continue;
      if (out.length >= DIRECTION_MAX_OPTS) continue;
      if (out.some(x => x.toLowerCase() === n.toLowerCase())) continue;
      out.push(n);
    }
    return out;
  }

  // AI 返回方向名数组 → 候选列表只保留简历命中的方向，不再补内置全量
  function directionOptionsFromAI(names) {
    const picked = normalizeDirectionOptions(names);
    return picked.length ? { options: picked, selected: picked } : null;
  }

  // AI 直接给成 [{name,keywords}] 时，把关键词也一起取出来
  function directionKeywordsFromAi(dir) {
    const out = {};
    if (!Array.isArray(dir)) return out;
    for (const item of dir) {
      if (!item || typeof item !== 'object') continue;
      const n = String(item.name || item.title || '').trim();
      if (!n) continue;
      const words = cleanKeywords([].concat(item.keywords || item.words || item.synonyms || []));
      if (words.length) out[n] = words;
    }
    return out;
  }

  // 兼容 AI 给出的多种形状：数组 / {categories,subs} / 字符串
  function parseAiDirections(dir) {
    if (!dir) return null;
    if (Array.isArray(dir)) return directionOptionsFromAI(dir);
    if (typeof dir !== 'object') return directionOptionsFromAI([String(dir)]);
    const subs = dir.subs || dir.subDirections || dir.details || dir.children || null;
    const cats = dir.categories || dir.cats || dir.main || null;
    if (subs && [].concat(subs).length) return directionOptionsFromAI([].concat(subs));
    return directionOptionsFromAI([].concat(cats || []));
  }

  // 候选方向 = AI 从简历解析出的 + 用户手工新增的，两处合并去重
  function directionOptionsOf(profile) {
    return uniq([].concat(
      normalizeDirectionOptions(profile && profile.directionOptions),
      normalizeDirectionOptions(profile && profile.directions),
    ));
  }

  function normalizeDegrees(list) {
    const want = uniq([].concat(list || []).filter(d => DEGREE_OPTS.indexOf(String(d)) >= 0));
    if (!want.length || want.length >= DEGREE_OPTS.length) return [];
    return want;
  }

  function normalizeDegreeOne(raw) {
    const s = String(raw || '');
    if (!s || /不限|不拘|无要求|学历不限/.test(s)) return '';
    if (/博士/.test(s)) return '博士';
    if (/硕士|研究生/.test(s)) return '硕士';
    if (/本科|学士/.test(s)) return '本科';
    if (/大专|专科|高职/.test(s)) return '大专';
    if (/中专|中技/.test(s)) return '中专';
    if (/高中|中学|中职/.test(s)) return '高中';
    return '';
  }

  function jobDegreeTags(raw) {
    const s = String(raw || '');
    const one = normalizeDegreeOne(s);
    if (!one) return [];
    if (/及以上|以上/.test(s)) {
      const i = DEGREE_OPTS.indexOf(one);
      return i >= 0 ? DEGREE_OPTS.slice(i) : [one];
    }
    return [one];
  }

  function jobDegreeText(job) {
    return String(job.degree || '');
  }

  function degreeMismatch(job, profile) {
    const want = normalizeDegrees(profile && profile.degrees);
    if (!want.length) return false;
    const tags = jobDegreeTags(jobDegreeText(job));
    if (!tags.length) return false;
    return !tags.some(t => want.indexOf(t) >= 0);
  }

  // 勾选集：只有「一条都没勾」才算不限方向；勾了就是只匹配这些方向
  function directionSelection(profile, opts) {
    const picked = normalizeDirections(profile && profile.directions);
    if (!picked.length) return { picked: new Set(opts), unlimited: true };
    return { picked: new Set(picked), unlimited: false };
  }

  function normalizeDirections(list) {
    const out = [];
    for (const item of [].concat(list || [])) {
      const n = typeof item === 'object'
        ? String((item && (item.name || item.title)) || '').trim()
        : String(item || '').trim();
      if (!n || n === '__all__') continue;
      if (out.some(x => x.toLowerCase() === n.toLowerCase())) continue;
      out.push(n);
    }
    return out;
  }

  function countHits(text, words) {
    const low = String(text || '').toLowerCase();
    let n = 0;
    for (const w of words || []) {
      const k = String(w || '').toLowerCase();
      if (k && low.includes(k)) n++;
    }
    return n;
  }

  function jobDirectionBlob(job) {
    const skills = Array.isArray(job.skills) ? job.skills.join(' ') : String(job.skills || '');
    const tags = Array.isArray(job.tags) ? job.tags.join(' ') : String(job.tags || '');
    return [job.name || '', skills, tags, job.info || '', job.jdText || ''].join(' ');
  }

  // 在给定方向名里找最贴近的一项，判断不出返回 null
  //
  // 一条规则，没有行业特例：
  //   标题命中权重更高，其余文本命中算一份，总分最高的方向胜出
  //   平局 → 命中词在标题里更靠前（领域限定词优先）
  //        → 命中词更长 → 方向名更长
  //
  // 关键词来自画像（AI 生成 / 用户手改），不含「测试」「工程师」这类泛词，
  // 所以「座舱自动化测试工程师」不会被「自动化测试」抢走。
  // 一个词都没命中 = 认不出，不猜也不误杀。
  function detectJobDirection(job, names, profile) {
    const text = jobDirectionBlob(job);
    const title = String(job.name || '');
    const list = [].concat(names || []);
    if (!text.trim() || !list.length) return null;

    let best = null;
    let bestRank = null;
    for (const name of list) {
      if (isGenericDirectionName(name, profile)) continue;
      const words = directionKeywordsOf(name, profile);
      const hits = countHits(text, words);
      if (!hits) continue;
      const rank = [
        countHits(title, words),                       // 标题命中权重更高
        hits,
        -firstHitIndex(title || text, words),           // 靠前 = 领域限定词
        longestHit(text, words),
        String(name).length,
      ];
      if (!bestRank || compareRank(rank, bestRank) > 0) {
        bestRank = rank;
        best = { name, hits, strong: longestHit(text, words) };
      }
    }
    return best;
  }

  // 按分量依次比较，返回 >0 表示 a 更优
  function compareRank(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  // 供侧边栏渲染：按候选顺序返回已勾选的方向
  function selectedDirectionsOf(profile) {
    const opts = directionOptionsOf(profile);
    const sel = directionSelection(profile, opts);
    return opts.filter(n => sel.picked.has(n));
  }

  // 方向关键词备好了吗：老画像 / 刚手加还没填词的方向都算「没备好」。
  // 没备好时识别力只剩字面匹配，绝大多数岗位会落到「认不出 → 放行」，
  // 看起来就像筛选没生效，必须在日志和 UI 里说清楚。
  function directionCoverageOf(profile) {
    const opts = directionOptionsOf(profile);
    const sel = directionSelection(profile, opts);
    const picked = opts.filter(n => sel.picked.has(n));
    const kw = (profile && profile.directionKeywords) || {};
    const other = (profile && profile.otherDirections) || {};
    const ready = picked.filter(n => (Array.isArray(kw[n]) && kw[n].length) || (Array.isArray(other[n]) && other[n].length));
    return {
      picked,
      total: picked.length,
      ready: ready.length,
      missing: picked.length - ready.length,
      hasNeighbors: Object.keys(other).length,
      // 一个方向都没有专属词 = 完全靠字面匹配
      blind: picked.length > 0 && ready.length === 0,
    };
  }

  // 匹配日志里回显本次生效的方向，勾选没落库时一眼能看出来
  function directionLogText(profile) {
    const opts = directionOptionsOf(profile);
    const sel = directionSelection(profile, opts);
    if (sel.unlimited) return '方向 不限（不做方向排除）';
    const cov = directionCoverageOf(profile);
    const head = '方向 ' + cov.total + ' 个: ' + cov.picked.join('/') + '（其余方向一律排除）';
    if (cov.blind) {
      return head + ' · 但这些方向都没有关键词，只能按名字字面匹配，'
        + '认不出的岗位会全部放行。请点「解析」重新生成关键词';
    }
    if (cov.missing) {
      return head + ' · 其中 ' + cov.missing + ' 个方向还没设关键词（只能字面匹配），'
        + '可以在方向右侧的「词」里补上';
    }
    return head;
  }

  // 方向识别池：所有候选方向（勾选的 + 没勾的都会参与识别）
  // 没勾的方向也必须能认出来，才能判成「不符」排除掉；否则它会被同族方向吸走放行。
  function directionPoolOf(profile, opts) {
    const hidden = Object.keys((profile && profile.otherDirections) || {});
    return uniq([].concat(opts || [], hidden));
  }

  // 一次算清方向相关的全部结论，避免同一岗位重复识别三遍
  // 返回 { score, blocked, got, reason }
  //   reason: 'unlimited' | 'notext' | 'weak' | 'hit' | 'miss'
  //
  // 方向只做「拦 / 不拦」，不参与打分：不拦就是 100，拦下来直接 veto。
  // 认不出方向的一律放行，不猜也不误杀。
  function directionInfo(job, profile) {
    const opts = directionOptionsOf(profile);
    const sel = directionSelection(profile, opts);
    if (sel.unlimited) return { score: 100, blocked: false, got: null, reason: 'unlimited' };
    if (!jobDirectionBlob(job).trim()) return { score: 100, blocked: false, got: null, reason: 'notext' };
    const got = detectJobDirection(job, directionPoolOf(profile, opts), profile);
    if (!got) return { score: 100, blocked: false, got: null, reason: 'weak' };
    if (sel.picked.has(got.name)) return { score: 100, blocked: false, got: got.name, reason: 'hit' };
    return { score: 40, blocked: true, got: got.name, reason: 'miss' };
  }

  // 精排拿到 JD 后的方向复核：先只按岗位名/技能/标签判定，
  // 认不出来才带上 JD —— 否则 JD 里顺口提一句「车载」就把软件测试岗误杀了。
  function directionInfoForRefine(job, profile) {
    const head = directionInfo(Object.assign({}, job, { jdText: '' }), profile);
    if (head.reason !== 'weak') return head;
    return directionInfo(job, profile);
  }

  function salaryMinK(v) {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n);
  }

  function parseSalaryRangeK(raw) {
    const s = String(raw || '').replace(/,/g, '').replace(/\s/g, '');
    if (!s || /面议|不限|保密|negotiable/i.test(s)) return null;
    const yearly = /年薪|\/年/.test(s) && !/\/月|月薪/.test(s);
    // 逐个数字带自己的单位，「6千-1.2万」才不会把 6 也当成万
    const re = /(\d+(?:\.\d+)?)(万|千|[kK])?/g;
    const items = [];
    let m;
    while ((m = re.exec(s))) items.push({ v: parseFloat(m[1]), unit: m[2] || '' });
    if (!items.length) return null;
    let lo = items[0];
    let hi = items.length > 1 ? items[1] : items[0];
    // 6-12K·13薪：第三个数字是发薪月数，不是薪资上限
    if (items.length >= 3) {
      const third = items[2];
      if (!third.unit && third.v >= 12 && third.v <= 16) hi = items[1];
    }
    // 只有一个显式单位时，没写单位的数字沿用它（「6-12万/年」的 6 也是万）
    const explicit = new Set(items.map(x => x.unit).filter(Boolean));
    const sole = explicit.size === 1 ? Array.from(explicit)[0] : '';
    const unitOf = (it) => it.unit || ((sole && it.v < 1000) ? sole : '');
    const toK = (it) => {
      const n = it.v;
      const unit = unitOf(it);
      if (unit === '万') return yearly ? (n * 10) / 12 : n * 10;
      if (unit === '千' || unit === 'k' || unit === 'K') return yearly ? n / 12 : n;
      if (n >= 1000) return yearly ? n / 12 / 1000 : n / 1000;
      return yearly ? n / 12 : n;
    };
    let a = toK(lo);
    let b = toK(hi);
    if (a > b) { const t = a; a = b; b = t; }
    // 日薪/时薪折算成月薪，否则「100-150元/天」会被当成 100-150K 放行
    if (/元?\s*\/\s*(天|日)|每天|日薪/.test(s)) {
      a = (a * 21.75) / 1000; b = (b * 21.75) / 1000;
    } else if (/元?\s*\/\s*(小时|时)|每小时|时薪/.test(s)) {
      a = (a * 8 * 21.75) / 1000; b = (b * 8 * 21.75) / 1000;
    }
    return { min: Math.round(a * 100) / 100, max: Math.round(b * 100) / 100 };
  }

  function jobSalaryText(job) {
    return String(job.salary || job.info || '');
  }

  function salaryTooLow(job, profile) {
    const need = Number(profile && profile.salaryMin || 0);
    if (!need) return false;
    const r = parseSalaryRangeK(jobSalaryText(job));
    if (!r) return false;
    return r.max + 0.01 < need;
  }

  function parseScaleRange(raw) {
    const s = String(raw || '').replace(/\s/g, '');
    if (!s) return null;
    if (/以上|及以上/.test(s)) {
      const n = parseInt(s.replace(/[^\d]/g, ''), 10);
      return n > 0 ? { min: n, max: n } : null;
    }
    const range = s.match(/(\d+)\s*[-~～到至]\s*(\d+)/);
    if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
    if (/少于|以下|以内/.test(s)) {
      const n = parseInt((s.match(/(\d+)/) || [])[1], 10);
      return n > 0 ? { min: 0, max: n } : null;
    }
    const one = parseInt((s.match(/(\d+)/) || [])[1], 10);
    return one > 0 ? { min: one, max: one } : null;
  }

  function jobScaleText(job) {
    return String(job.scale || '');
  }

  function scaleTooSmall(job, profile) {
    const need = Number(profile && profile.scaleMin || 0);
    if (!need) return false;
    const r = parseScaleRange(jobScaleText(job));
    if (!r) return false;
    return r.min < need;
  }

  function jobHaystack(job) {
    const skills = Array.isArray(job.skills) ? job.skills.join(' ') : String(job.skills || '');
    return [job.name || '', skills, job.cityName || '', job.company || '', job.info || '', job.jdText || ''].join(' ').toLowerCase();
  }

  function isDispatch(job) {
    const t = [job.name || '', job.company || '', job.info || '', job.jdText || ''].join(' ');
    return DISPATCH.test(t);
  }

  let outsourceNames = null;
  let outsourceLoadPromise = null;
  let appliedLocal = new Set();

  async function loadAppliedLocal(platform) {
    const key = 'applied_ids_' + platform;
    try {
      const s = await chrome.storage.local.get(key);
      const arr = Array.isArray(s[key]) ? s[key] : [];
      appliedLocal = new Set(arr.map(String).filter(Boolean));
    } catch (_) {
      appliedLocal = new Set();
    }
    return appliedLocal.size;
  }

  function jobAppliedId(job) {
    return String(job.encryptId || job.jobId || '').trim();
  }

  function normalizeCompany(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/(股份)?有限(责任)?公司|集团|控股|分公司$/g, '')
      .trim();
  }

  async function loadOutsourceCompanies() {
    if (outsourceNames) return outsourceNames;
    if (outsourceLoadPromise) return outsourceLoadPromise;
    outsourceLoadPromise = (async () => {
      try {
        const url = chrome.runtime.getURL('blocklist/outsource-companies.txt');
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        outsourceNames = String(text || '').split(/\r?\n/)
          .map(line => line.replace(/#.*$/, '').trim())
          .filter(Boolean)
          .map(normalizeCompany)
          .filter(n => n.length >= 2);
      } catch (_) {
        outsourceNames = [];
      }
      return outsourceNames;
    })();
    return outsourceLoadPromise;
  }

  function isBlockedOutsourceCompany(job) {
    const list = outsourceNames || [];
    if (!list.length) return false;
    const company = normalizeCompany(job && job.company);
    if (!company || company.length < 2) return false;
    for (const name of list) {
      if (company.includes(name) || name.includes(company)) return true;
    }
    return false;
  }

  function is51ResumeFlow(job) {
    if (job.resumeFlow === true) return true;
    const blob = [
      job.url || '', job.applyUrl || '',
      Array.isArray(job.tags) ? job.tags.join(' ') : String(job.tags || ''),
    ].join(' ');
    if (RESUME_FLOW.test(blob)) return true;
    const at = job.applyType;
    if (at === 1 || at === '1' || at === 2 || at === '2' || at === 3 || at === '3') return true;
    if (job.canDirectApply === false || job.canDirectApply === '0' || job.canDirectApply === 0) return true;
    return false;
  }

  function extraWhy(job) {
    const name = String(job.name || '');
    const url = String(job.url || '');
    const tags = Array.isArray(job.tags) ? job.tags.join(' ') : String(job.tags || '');
    const blob = [name, job.company || '', tags].join(' ');
    if (CAMPUS.test(blob) || /campus\.51job|xiaoyuan\.zhaopin|zhipin\.com\/campus/i.test(url)) return 'campus';
    if (NAME_EXTRA.test(name)) return 'unselect';
    if (job.goldHunter || /猎头/.test(name) || /猎头/.test(String(job.company || ''))) return 'hunter';
    if (job.applied === true || job.hasApplied === true || job.friend === true) return 'applied';
    const aid = jobAppliedId(job);
    if (aid && appliedLocal.has(aid)) return 'applied';
    if (job.canSelect === false || job.disabled === true) return 'unselect';
    if (UNSELECT.test(blob)) return 'unselect';
    if (job.source === '51job' && is51ResumeFlow(job)) return 'resumeFlow';
    if (job.source === '51job' && (job.applyType === 1 || job.applyType === '1')) return 'unselect';
    return '';
  }

  function whyLabel(why) {
    return ({
      dispatch: '派遣/外包/外派', outsource: '外包公司', campus: '校招', unselect: '不可选中',
      hunter: '猎头', applied: '已投/已沟通', resumeFlow: '简历投递', salary: '薪资过低', scale: '规模过小', degree: '学历不符', direction: '方向不符',
    })[why] || why;
  }

  function bumpWhy(counts, why) {
    if (!why) return;
    counts[why] = (counts[why] || 0) + 1;
  }

  function tryRefinePass(job, profile, meta, log, tag) {
    const r = meta || {};
    if (r.jdText) job.jdText = r.jdText;
    if (r.skills && r.skills.length) job.skills = uniq(job.skills.concat(r.skills));
    if (r.name && !job.name) job.name = r.name;
    if (r.cityName && !job.cityName) job.cityName = r.cityName;
    const hasJd = !!(job.jdText && job.jdText.length >= 40);
    const dinfo = directionInfoForRefine(job, profile);
    const block = extraWhy(job) || (isDispatch(job) ? 'dispatch' : '')
      || (isBlockedOutsourceCompany(job) ? 'outsource' : '')
      || (salaryTooLow(job, profile) ? 'salary' : '')
      || (scaleTooSmall(job, profile) ? 'scale' : '')
      || (degreeMismatch(job, profile) ? 'degree' : '')
      // 精排拿到 JD 后方向判定更准，这里必须二次校验
      || (dinfo.blocked ? 'direction' : '');
    if (block) {
      log('精排淘汰(' + whyLabel(block) + ') ' + job.name + (job.company ? ' | ' + job.company : '')
        + (block === 'direction' && dinfo.got ? ' → 判成「' + dinfo.got + '」，没勾它' : ''));
      return false;
    }
    if (jdCityMismatch(profile, r.cityName || job.cityName)) {
      log('精排淘汰(城市) ' + job.name + ' ' + (r.cityName || job.cityName));
      return false;
    }
    const s = scoreJd(job, profile);
    job.score = s.score;
    job.scoreDetail = s;
    job.refined = hasJd;
    if (isVeto(profile, job.name) || s.title < 50) {
      log('精排淘汰 ' + job.name + ' ' + s.score + '(职位' + s.title + ')');
      return false;
    }
    log(tag + ' ' + job.name + ' ' + s.score + '(职位' + s.title + '/技能' + s.skill + '/工作' + s.work
      + (s.dir < 100 ? '/方向' + s.dir : '') + (hasJd ? '/有JD' : '/无JD') + ')');
    return true;
  }

  function logExcludes(log, counts) {
    const parts = [];
    for (const k of ['dispatch', 'outsource', 'campus', 'unselect', 'hunter', 'applied', 'salary', 'scale', 'degree', 'direction']) {
      if (counts[k]) parts.push(whyLabel(k) + ' ' + counts[k]);
    }
    if (parts.length) log('已排除 ' + parts.join('、') + ' 条');
  }

  // 「方向不符明细」里用到的方向名清单，给 0 条时的提示复用
  function dirNamesText(dirStats) {
    if (!dirStats) return '';
    const rows = Object.keys(dirStats)
      .map(k => ({ name: k, ...dirStats[k] }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count);
    if (!rows.length) return '';
    const names = rows.slice(0, 6).map(r => '「' + r.name + '」');
    return '（' + names.join('、') + (rows.length > 6 ? ' 等' : '') + '）';
  }

  // 方向排除明细：把「被判成哪个方向 + 几个岗位 + 岗位名样例」列出来，
  // 用户照着这里的名字补勾就能放行
  function logDirectionDetail(log, dirStats) {
    if (!dirStats) return;
    const rows = Object.keys(dirStats)
      .map(k => ({ name: k, ...dirStats[k] }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count);
    if (!rows.length) return;
    const parts = rows.slice(0, 6).map(r => {
      const eg = (r.samples || []).slice(0, 3).join('、');
      return '「' + r.name + '」' + r.count + ' 条' + (eg ? '（' + eg + '）' : '');
    });
    if (rows.length > 6) parts.push('等 ' + rows.length + ' 个方向');
    log('方向不符明细: ' + parts.join('；'));
    log('补勾上面这些方向名就能放行（下拉里没有，就在下方输入框添加）；想全部不筛，勾回「全部（不限方向）」。');
  }

  // 0 条时的方向兜底提示，三端共用
  function directionTipText(dirStats, total) {
    return '被方向筛掉 ' + total + ' 条' + dirNamesText(dirStats)
      + '：当前只匹配勾选的方向。补勾上面这些方向名就能放行'
      + '（下拉里没有，就在下方输入框添加），或勾回「全部（不限方向）」。';
  }

  function overlapScore(needles, haystack) {
    if (!needles.length) return 0;
    let hit = 0;
    for (const n of needles) {
      if (n && haystack.includes(String(n).toLowerCase())) hit++;
    }
    return Math.round(hit / needles.length * 100);
  }

  function overlapHits(needles, haystack, hitsForFull) {
    if (!needles.length) return 0;
    let hit = 0;
    for (const n of needles) {
      if (n && haystack.includes(String(n).toLowerCase())) hit++;
    }
    return Math.min(100, Math.round(hit / hitsForFull * 100));
  }

  function titleScore(titles, name) {
    const n = String(name || '').toLowerCase();
    if (!n) return 0;
    let best = 0;
    for (const t of titles) {
      const tt = String(t).toLowerCase();
      if (!tt) continue;
      if (n.includes(tt) || tt.includes(n)) best = Math.max(best, 100);
      else {
        const parts = splitWords(t);
        const h = overlapScore(parts, n);
        best = Math.max(best, h);
      }
    }
    if (/后端|服务端/.test(n) && titles.some(t => /java|后端|服务端/i.test(t))) best = Math.max(best, 80);
    if (/前端/.test(n) && titles.some(t => /前端|vue|react/i.test(t))) best = Math.max(best, 80);
    if (/测试/.test(n) && titles.some(t => /测试|qa|质量/i.test(t))) best = Math.max(best, 80);
    return best;
  }

  function isVeto(profile, jobName) {
    const name = String(jobName || '');
    if (!VETO.test(name)) return false;
    const look = (profile.titles || []).join(' ') + ' ' + (profile.skills || []).join(' ');
    return TECH.test(look);
  }

  function cityMismatch(profile, job) {
    if (!profile.city) return false;
    if (profile.cityCode) return false;
    const c = String(job.cityName || '');
    if (!c) return false;
    return !c.includes(profile.city) && !profile.city.includes(c.replace(/市$/, ''));
  }

  function scoreList(job, profile) {
    // 方向先算一次：粗筛阶段的排除明细要把「被判成哪个方向」显示出来
    const dinfo = directionInfo(job, profile);
    const extra = extraWhy(job) || (isDispatch(job) ? 'dispatch' : '')
      || (isBlockedOutsourceCompany(job) ? 'outsource' : '')
      || (salaryTooLow(job, profile) ? 'salary' : '')
      || (scaleTooSmall(job, profile) ? 'scale' : '')
      || (degreeMismatch(job, profile) ? 'degree' : '')
      || (dinfo.blocked ? 'direction' : '');
    if (extra) {
      return { score: 0, veto: true, title: 0, skill: 0, work: 0, dir: 100, why: extra, dirName: dinfo.got };
    }
    if (isVeto(profile, job.name)) return { score: 0, veto: true, title: 0, skill: 0, work: 0, dir: 100 };
    if (cityMismatch(profile, job)) return { score: 0, veto: true, title: 0, skill: 0, work: 0, dir: 100 };
    const hay = jobHaystack(job);
    const title = titleScore(profile.titles, job.name);
    const skill = overlapHits(profile.skills, hay, 3);
    const work = overlapHits(profile.workKeywords, hay, 2);
    const dir = dinfo.score;
    const base = Math.round(title * 0.50 + skill * 0.20 + work * 0.30);
    const score = dir >= 100 ? base : Math.round(base * (0.85 + (0.15 * dir) / 100));
    return { score, veto: false, title, skill, work, dir };
  }

  function scoreJd(job, profile) {
    const hay = jobHaystack(job);
    const title = titleScore(profile.titles, job.name);
    const skill = overlapHits(profile.skills, hay, 3);
    const work = overlapHits(profile.workKeywords, hay, 3);
    const dir = directionInfoForRefine(job, profile).score;
    const base = Math.round(title * 0.40 + skill * 0.20 + work * 0.40);
    const score = dir >= 100 ? base : Math.round(base * (0.85 + (0.15 * dir) / 100));
    return { score, title, skill, work, dir };
  }

  function jdCityMismatch(profile, cityName) {
    if (!profile.city || !cityName) return false;
    const c = String(cityName).replace(/市/g, '');
    if (c.includes(profile.city) || profile.city.includes(c)) return false;
    return Object.keys(CITY_CODE).some(x => x !== profile.city && c.includes(x));
  }

  function mapApiJob(j) {
    const encryptId = j.encryptJobId || j.encryptId || '';
    const skills = j.skills || j.skillList || [];
    return {
      url: 'https://www.zhipin.com/job_detail/' + encryptId + '.html',
      name: (j.jobName || j.title || '').trim().substring(0, 50),
      encryptId,
      securityId: j.securityId || '',
      lid: j.lid || '',
      skills: Array.isArray(skills) ? skills.map(s => typeof s === 'string' ? s : (s.name || s.skillName || '')).filter(Boolean) : [],
      cityName: j.cityName || j.city || j.locationName || j.areaDistrict || '',
      jobExperience: j.jobExperience || j.experienceName || '',
      company: j.brandName || j.brand || '',
      salary: j.salaryDesc || '',
      scale: String(j.brandScaleName || j.scaleName || j.brandScale || j.companySize || '').trim(),
      degree: String(j.jobDegree || j.degreeName || j.degree || j.eduLevel || '').trim(),
      jdText: '',
      tags: [].concat(j.jobLabels || j.labels || []).map(x => typeof x === 'string' ? x : (x && x.name) || '').filter(Boolean),
      goldHunter: !!j.goldHunter,
      friend: !!(j.friend || j.contact),
      applied: !!(j.friend),
      score: 0,
    };
  }

  const BOSS_FILTER_KEYS = [
    'experience', 'degree', 'industry', 'scale', 'stage', 'position',
    'salary', 'jobType', 'partTime', 'payType', 'multiBusinessDistrict', 'multiSubway',
  ];

  function parseBossPageFilters(url) {
    let u;
    try { u = new URL(url || ''); } catch (_) {
      return { hasFilter: false, active: [], params: {}, query: '', city: '', encryptExpectId: '', path: '' };
    }
    const sp = u.searchParams;
    const params = {};
    for (const k of ['query', 'city', 'encryptExpectId', 'expectId', 'mixExpectType', 'expectInfo'].concat(BOSS_FILTER_KEYS)) {
      const v = sp.get(k);
      if (v != null && String(v).trim() !== '') params[k] = String(v).trim();
    }
    const active = BOSS_FILTER_KEYS.filter((k) => {
      const v = String(params[k] || '').trim();
      return v && v !== '0';
    });
    return {
      hasFilter: active.length > 0,
      active,
      params,
      query: params.query || '',
      city: params.city || '',
      encryptExpectId: params.encryptExpectId || params.expectId || '',
      path: u.pathname || '',
    };
  }

  async function readBossPageContext(tabId) {
    const empty = {
      hasFilter: false, active: [], params: {}, query: '', city: '',
      encryptExpectId: '', expectName: '', onRecommend: false, path: '',
      hasExpectUi: false, diag: '',
    };
    try {
      const tab = await chrome.tabs.get(tabId);
      let ctx = parseBossPageFilters(tab.url || '');
      let expectName = '';
      let hasExpectUi = false;
      let diag = '';
      let onRecommend = /job-recommend|\/geek\/recommend/i.test(ctx.path || tab.url || '');
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async () => {
            const takeId = (v) => {
              const s = String(v || '').trim();
              if (s && s.length >= 6 && s !== '0' && s !== 'null' && s !== 'undefined') return s;
              return '';
            };
            const takeName = (v) => {
              let s = String(v || '').replace(/\s+/g, ' ').trim()
                .replace(/^求职期望[:：\s]*/, '')
                .replace(/^求职意向[:：\s]*/, '');
              s = s.split(/[|｜\n]/)[0].trim();
              if (s.length > 24) s = s.slice(0, 24);
              if (!s) return '';
              if (/添加|管理期望|切换|全部职位|推荐职位|筛选|经验要求|学历要求/.test(s)) return '';
              return s;
            };
            const normName = (s) => String(s || '')
              .replace(/[（(][^）)]*[）)]/g, '')
              .replace(/[·・.\s\-_/]/g, '')
              .toLowerCase();
            const nameScore = (selected, candidate) => {
              const a = normName(selected);
              const b = normName(candidate);
              if (!a || !b) return 0;
              if (a === b) return 100;
              if (a.includes(b) || b.includes(a)) return 85;
              if (a.length >= 4 && b.includes(a.slice(0, 4))) return 70;
              if (b.length >= 4 && a.includes(b.slice(0, 4))) return 70;
              return 0;
            };
            const titleOf = (x) => takeName(
              x && (x.positionName || x.expectName || x.jobName || x.position || x.name || x.positionNameStr),
            );
            const idOf = (x) => takeId(
              x && (x.encryptExpectId || x.encryptId || x.expectId || x.id),
            );

            const href = location.href || '';
            const sp = new URLSearchParams(location.search || (location.hash || '').replace(/^#/, '?'));
            let encryptExpectId = takeId(sp.get('encryptExpectId') || sp.get('expectId') || '');
            let expectName = '';
            let city = sp.get('city') || '';
            let query = sp.get('query') || '';
            const onRecommend = /job-recommend|\/geek\/recommend/i.test(location.pathname || href);
            const notes = [];
            let nameSource = '';
            let idSource = encryptExpectId ? 'url' : '';

            // A) 当前选中名称：优先 active 项，再取顶部短文案（避免列表第一项）
            const actives = document.querySelectorAll(
              '[class*="expect"] .active, [class*="expect"] .selected, [class*="Expect"] .active,'
              + '[class*="expect"] [aria-selected="true"], .expect-list .active, .expect-item.active,'
              + 'li.active[class*="expect"], [ka*="expect"].active, [class*="expect-select"] .active',
            );
            for (const el of actives) {
              const nm = takeName(el.getAttribute('title') || el.textContent);
              if (!nm || !/测试|开发|工程师|产品|设计|运营|算法|前端|后端|QA|质量|Java|经理|专员/.test(nm)) continue;
              expectName = nm;
              nameSource = 'domActive';
              const id = takeId(
                el.getAttribute('data-id')
                || el.getAttribute('data-expectid')
                || el.getAttribute('data-encrypt-id')
                || el.getAttribute('encryptExpectId'),
              );
              if (id) { encryptExpectId = id; idSource = 'domActive'; }
              break;
            }
            if (!expectName) {
              const cands = [];
              const nodes = document.querySelectorAll('span, a, div, p, button, label');
              for (const el of nodes) {
                if (el.children && el.children.length > 3) continue;
                const raw = el.getAttribute('title')
                  || (el.childElementCount === 0 ? el.textContent : '')
                  || '';
                const nm = takeName(raw);
                if (!nm || nm.length < 2 || nm.length > 18) continue;
                if (!/测试|开发|工程师|产品|设计|运营|算法|前端|后端|QA|质量|Java|经理|专员/.test(nm)) continue;
                const big = String(el.textContent || '').replace(/\s+/g, ' ');
                if ((big.match(/测试|开发|工程师|产品/g) || []).length >= 3) continue;
                const rect = el.getBoundingClientRect();
                if (!rect || rect.width < 4 || rect.height < 4) continue;
                if (rect.top < 0 || rect.top > 170) continue;
                const cls = String(el.className || '') + ' '
                  + String(el.parentElement && el.parentElement.className || '');
                const boost = /expect|意向|job-select|select-expect/i.test(cls) ? 40 : 0;
                // 越靠左上越像当前选中展示
                cands.push({
                  nm,
                  score: boost + (rect.left < 480 ? 20 : 0) + Math.max(0, 120 - rect.top),
                });
              }
              cands.sort((a, b) => b.score - a.score);
              // 若出现多个不同名字，优先带 expect 类的；不要默默拿「列表第一项」长容器
              if (cands[0] && cands[0].score >= 40) {
                expectName = cands[0].nm;
                nameSource = 'domTop';
              }
            }

            const expectRoots = Array.from(document.querySelectorAll(
              '[class*="expect"], [class*="Expect"], [ka*="expect"], [data-expect], .job-expect, .expect-list',
            )).slice(0, 50);
            const hasExpectUi = expectRoots.some((el) => /求职期望|求职意向|期望职位/.test(el.textContent || ''))
              || /求职期望|求职意向/.test(document.body ? document.body.innerText.slice(0, 2500) : '');

            // B) 期望列表接口 / 页面 JSON（用名称对齐 id，绝不默认第一项）
            const expectApis = [
              '/wapi/zpgeek/expect/list.json',
              '/wapi/zpgeek/expect/list',
              '/wapi/zpgeek/pc/expect/list.json',
              '/wapi/zpgeek/home/data/info.json',
              '/wapi/zprelation/expect/list.json',
              '/wapi/zpgeek/expect/query/list.json',
            ];
            let expectList = [];
            for (const url of expectApis) {
              try {
                const r = await fetch(url, { credentials: 'include' });
                const j = await r.json();
                const zp = j.zpData || {};
                const list = zp.expectList || zp.list || zp.expectQueryList
                  || zp.expectInfos || zp.expects
                  || (Array.isArray(zp) ? zp : null);
                if (Array.isArray(list) && list.length) {
                  expectList = list;
                  notes.push('api:' + url.split('/').pop());
                  break;
                }
              } catch (_) {}
            }
            if (!expectList.length) {
              try {
                const html = (document.documentElement && document.documentElement.innerHTML || '').slice(0, 500000);
                const re = /"encryptExpectId"\s*:\s*"([^"]+)"([\s\S]{0,240}?)"(?:positionName|expectName|jobName|position)"\s*:\s*"([^"]+)"/g;
                const re2 = /"(?:positionName|expectName|jobName|position)"\s*:\s*"([^"]+)"([\s\S]{0,240}?)"encryptExpectId"\s*:\s*"([^"]+)"/g;
                const map = new Map();
                let m;
                while ((m = re.exec(html))) map.set(m[1], m[3]);
                while ((m = re2.exec(html))) map.set(m[3], m[1]);
                for (const [id, name] of map.entries()) {
                  expectList.push({ encryptExpectId: id, positionName: name });
                }
                if (expectList.length) notes.push('htmlJson:' + expectList.length);
              } catch (_) {}
            }

            const pickByName = (list, name) => {
              if (!name || !list.length) return null;
              let best = null;
              let bestScore = 0;
              for (const x of list) {
                const sc = nameScore(name, titleOf(x));
                if (sc > bestScore) { bestScore = sc; best = x; }
              }
              return bestScore >= 70 ? best : null;
            };

            if (expectList.length && expectName) {
              const hit = pickByName(expectList, expectName);
              if (hit) {
                const id = idOf(hit);
                if (id) { encryptExpectId = id; idSource = 'nameMatch'; }
                const tn = titleOf(hit);
                if (tn) { expectName = tn; nameSource = nameSource || 'nameMatch'; }
                if (!city) city = String(hit.locationName || hit.cityCode || hit.city || hit.location || '');
              }
            }

            // C) 最近 joblist/recommend 请求：仅作无名称匹配时的兜底；有名称时优先用「与名称匹配」的列表 id
            let perfId = '';
            try {
              const entries = performance.getEntriesByType('resource') || [];
              for (let i = entries.length - 1; i >= 0; i--) {
                const name = entries[i].name || '';
                if (!/(?:joblist\.json|recommend\/job\/list)/i.test(name)) continue;
                try {
                  const u = new URL(name, location.origin);
                  const id = takeId(u.searchParams.get('encryptExpectId') || u.searchParams.get('expectId'));
                  if (id) { perfId = id; break; }
                } catch (_) {}
              }
            } catch (_) {}

            // 若已有 nameMatch id，不要被旧 perf 覆盖
            if (!encryptExpectId && perfId) {
              encryptExpectId = perfId;
              idSource = 'perf';
            } else if (encryptExpectId && perfId && idSource !== 'nameMatch' && idSource !== 'domActive' && !expectName) {
              // 无可靠名称时用最新 perf
              encryptExpectId = perfId;
              idSource = 'perf';
            }

            // D) 有 id 无名称时，用列表反查名称（避免显示成第一项）
            if (encryptExpectId && expectList.length) {
              const hit = expectList.find((x) => idOf(x) === encryptExpectId);
              if (hit) {
                const tn = titleOf(hit);
                if (tn && (!expectName || nameSource === 'domTop' || nameSource === '')) {
                  // 若 domTop 名字和 id 对不上，以 id 对应名为准？更稳：以 nameMatch 为准。
                  // 这里仅在还没名字时补名
                }
                if (tn && !expectName) {
                  expectName = tn;
                  nameSource = 'idLookup';
                }
                // 关键：dom 名字与 id 所属期望不一致 → 以名字重新匹配 id
                if (expectName && tn && nameScore(expectName, tn) < 70) {
                  const byName = pickByName(expectList, expectName);
                  if (byName && idOf(byName)) {
                    encryptExpectId = idOf(byName);
                    idSource = 'nameOverride';
                    expectName = titleOf(byName) || expectName;
                    notes.push('fixIdNameMismatch');
                  }
                }
              }
            }

            if (nameSource) notes.push('name:' + nameSource);
            if (idSource) notes.push('id:' + idSource);

            return {
              href,
              encryptExpectId: String(encryptExpectId || '').trim(),
              expectName: String(expectName || '').trim().slice(0, 40),
              city: String(city || '').trim(),
              query: String(query || '').trim(),
              onRecommend,
              hasExpectUi,
              expectCount: expectList.length,
              notes: notes.join(','),
            };
          },
        });
        const page = (res && res[0] && res[0].result) || {};
        if (page.href) ctx = parseBossPageFilters(page.href);
        if (page.encryptExpectId) ctx.encryptExpectId = page.encryptExpectId;
        if (page.city && !ctx.city) ctx.city = page.city;
        if (page.query && !ctx.query) ctx.query = page.query;
        expectName = page.expectName || '';
        hasExpectUi = !!page.hasExpectUi;
        onRecommend = !!(page.onRecommend || onRecommend);
        diag = 'ui=' + (hasExpectUi ? 1 : 0)
          + ' expectN=' + (page.expectCount || 0)
          + ' id=' + (page.encryptExpectId ? 'Y' : 'N')
          + ' name=' + (expectName || '-')
          + ' path=' + (ctx.path || '-')
          + (page.notes ? (' via=' + page.notes) : '');
      } catch (e) {
        diag = 'readErr:' + (e && e.message || e);
      }
      return {
        ...ctx,
        encryptExpectId: ctx.encryptExpectId || '',
        expectName,
        onRecommend,
        hasExpectUi,
        diag,
      };
    } catch (_) {
      return empty;
    }
  }

  async function searchJobsByRecommend(tabId, profile, log, opts) {
    const city = (opts && opts.city) || profile.cityCode || profile.city || '';
    const encryptExpectId = (opts && opts.encryptExpectId) || '';
    const filters = (opts && opts.filters) || {};
    const mapped = [];
    const seen = new Set();
    let blockCode = 0;
    lastSearchBlock = null;
    let usedPages = 0;
    let maxPages = SEARCH_PAGES_MAX;
    for (let page = 1; page <= maxPages; page++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (params) => {
          const jobs = [];
          const diag = [];
          let stop = false;
          let stopMsg = '';
          let blockCode = 0;
          const qs = new URLSearchParams();
          qs.set('page', String(params.page));
          qs.set('pageSize', '15');
          qs.set('city', params.city || '');
          qs.set('encryptExpectId', params.encryptExpectId || '');
          qs.set('mixExpectType', params.filters.mixExpectType || '');
          qs.set('expectInfo', params.filters.expectInfo || '');
          for (const k of params.filterKeys || []) {
            const v = params.filters[k];
            qs.set(k, v != null && String(v) !== '0' ? String(v) : '');
          }
          const tryUrls = [
            '/wapi/zpgeek/pc/recommend/job/list.json?' + qs.toString(),
            '/wapi/zpgeek/search/joblist.json?site=1&scene=1&query=&'
              + qs.toString(),
          ];
          for (const apiUrl of tryUrls) {
            try {
              const apiRes = await fetch(apiUrl, { credentials: 'include' });
              const json = await apiRes.json();
              const jl = (json.zpData && (json.zpData.jobList || json.zpData.list)) || [];
              const tag = apiUrl.includes('recommend') ? 'recommend' : 'joblist';
              diag.push(tag + ' p' + params.page + ' code=' + json.code + ' n=' + jl.length);
              if (json.code !== 0) {
                const msg = JSON.stringify(json).slice(0, 200);
                if (/请稍候|captcha|hasCaptcha|验证码|极验/i.test(msg)) {
                  stop = true;
                  stopMsg = msg;
                  break;
                }
                if (!jobs.length) blockCode = blockCode || json.code;
                continue;
              }
              for (const j of jl) jobs.push(j);
              if (jl.length) break;
            } catch (e) {
              diag.push('err=' + e.message);
            }
          }
          return { jobs, diag, stop, stopMsg, blockCode };
        },
        args: [{
          page,
          city,
          encryptExpectId,
          filters,
          filterKeys: BOSS_FILTER_KEYS,
        }],
      });
      const raw = (res && res[0] && res[0].result) || { jobs: [], diag: [] };
      if (raw.diag && raw.diag.length) log('期望推荐: ' + raw.diag.join(' | '));
      if (raw.stop) throw new Error('搜索触发风控，已停止。' + (raw.stopMsg || ''));
      if (raw.blockCode) blockCode = raw.blockCode;
      let added = 0;
      for (const j of raw.jobs || []) {
        const job = mapApiJob(j);
        if (!job.encryptId || seen.has(job.encryptId)) continue;
        seen.add(job.encryptId);
        mapped.push(job);
        added++;
      }
      usedPages = page;
      const fresh = mapped.filter((j) => !appliedLocal.has(String(j.encryptId || ''))).length;
      // 整页被限流（一个岗位都没拿到）：再翻页也只会继续 code=37，交给上层刷页面
      if (raw.blockCode && !mapped.length) break;
      if (page >= SEARCH_PAGES && fresh >= SEARCH_FRESH_TARGET) break;
      // 没有新增说明池子翻到底了
      if (!added && page >= SEARCH_PAGES) break;
      // 前几页新岗位不够（多半是已投太多），自动加深到更深页数
      if (page >= SEARCH_PAGES && fresh < SEARCH_FRESH_TARGET && maxPages < SEARCH_PAGES_DEEP) {
        maxPages = SEARCH_PAGES_DEEP;
        log('未投岗位只有 ' + fresh + ' 条，加深翻页到 ' + maxPages + ' 页');
      }
    }
    log('BOSS 搜索共 ' + mapped.length + ' 条（求职期望，' + usedPages + ' 页，目标未投≥' + SEARCH_FRESH_TARGET + '）');
    if (!mapped.length && blockCode) lastSearchBlock = { code: blockCode };
    return mapped;
  }

  async function readBossPageFilters(tabId) {
    return readBossPageContext(tabId);
  }

  async function searchJobsByApi(tabId, profile, log, opts) {
    const queries = (opts && opts.queries && opts.queries.length)
      ? opts.queries
      : profile.titles.slice(0, 3);
    const city = (opts && opts.city) || profile.cityCode || profile.city || '';
    const filters = (opts && opts.filters) || {};
    const noDeep = !!(opts && opts.noDeep);
    const mapped = [];
    const seen = new Set();
    let usedPages = 0;
    let blockCode = 0;
    lastSearchBlock = null;
    let maxPages = (opts && opts.maxPages) || SEARCH_PAGES_MAX;
    for (let page = 1; page <= maxPages; page++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (params) => {
          const jobs = [];
          const diag = [];
          let stop = false;
          let stopMsg = '';
          let blockCode = 0;
          const filterKeys = params.filterKeys || [];
          for (const query of params.queries) {
            const qs = new URLSearchParams();
            qs.set('site', '1');
            qs.set('query', query || '');
            qs.set('city', params.city || '');
            qs.set('page', String(params.page));
            qs.set('pageSize', '30');
            for (const k of filterKeys) {
              qs.set(k, params.filters[k] != null ? String(params.filters[k]) : '');
            }
            // 无筛选时与旧逻辑一致，显式带空筛选字段
            if (!params.usePageFilters) {
              for (const k of ['experience', 'degree', 'industry', 'scale', 'stage', 'position']) {
                if (!qs.has(k)) qs.set(k, '');
              }
            }
            const apiUrl = '/wapi/zpgeek/search/joblist.json?' + qs.toString();
            try {
              const apiRes = await fetch(apiUrl);
              const json = await apiRes.json();
              const jl = (json.zpData && (json.zpData.jobList || json.zpData.list)) || [];
              diag.push(query + ' p' + params.page + ' code=' + json.code + ' n=' + jl.length);
              if (json.code !== 0) {
                const msg = JSON.stringify(json).slice(0, 200);
                if (/请稍候|captcha|hasCaptcha|验证码|极验/i.test(msg)) {
                  stop = true;
                  stopMsg = msg;
                  break;
                }
                if (!jobs.length) blockCode = blockCode || json.code;
              }
              for (const j of jl) jobs.push(j);
            } catch (e) {
              diag.push(query + ' p' + params.page + ' err=' + e.message);
            }
          }
          return { jobs, diag, stop, stopMsg, blockCode };
        },
        args: [{
          queries,
          city,
          page,
          filters,
          filterKeys: BOSS_FILTER_KEYS,
          usePageFilters: !!(opts && opts.usePageFilters),
        }],
      });
      const raw = (res && res[0] && res[0].result) || { jobs: [], diag: [] };
      if (raw.diag && raw.diag.length) log('搜索: ' + raw.diag.join(' | '));
      if (raw.stop) throw new Error('搜索触发风控，已停止。' + (raw.stopMsg || ''));
      if (raw.blockCode) blockCode = raw.blockCode;
      let added = 0;
      for (const j of raw.jobs || []) {
        const job = mapApiJob(j);
        if (!job.encryptId || seen.has(job.encryptId)) continue;
        seen.add(job.encryptId);
        mapped.push(job);
        added++;
      }
      usedPages = page;
      const fresh = mapped.filter((j) => !appliedLocal.has(String(j.encryptId || ''))).length;
      // 整页被限流（一个岗位都没拿到）：再翻页也只会继续 code=37，交给上层刷页面
      if (raw.blockCode && !mapped.length) break;
      if (page >= SEARCH_PAGES && fresh >= SEARCH_FRESH_TARGET) break;
      // 没有新增说明池子翻到底了
      if (!added && page >= SEARCH_PAGES) break;
      // 前几页新岗位不够（多半是已投太多），自动加深到更深页数
      if (!noDeep && page >= SEARCH_PAGES && fresh < SEARCH_FRESH_TARGET && maxPages < SEARCH_PAGES_DEEP) {
        maxPages = SEARCH_PAGES_DEEP;
        log('未投岗位只有 ' + fresh + ' 条，加深翻页到 ' + maxPages + ' 页');
      }
    }
    const mode = (opts && opts.mode) || ((opts && opts.usePageFilters) ? '页面筛选' : '画像接口');
    log('BOSS 搜索共 ' + mapped.length + ' 条（' + mode + '，' + usedPages + ' 页，目标未投≥' + SEARCH_FRESH_TARGET + '）');
    if (!mapped.length && blockCode) lastSearchBlock = { code: blockCode };
    return mapped;
  }

  async function searchJobs(tabId, profile, log) {
    const pageCtx = await readBossPageContext(tabId);
    if (pageCtx.diag) log('页面期望诊断: ' + pageCtx.diag);
    // 有期望 id / 推荐页 / 页面上已展示求职期望选中项 → 走期望推荐
    const useExpect = !!(pageCtx.encryptExpectId || pageCtx.onRecommend
      || (pageCtx.hasExpectUi && pageCtx.expectName));
    if (useExpect) {
      const name = pageCtx.expectName || pageCtx.encryptExpectId || '当前期望';
      log('按求职期望拉列表: ' + name
        + (pageCtx.encryptExpectId ? (' id=' + pageCtx.encryptExpectId.slice(0, 12) + '…') : '（默认期望）'));
      if (pageCtx.hasFilter) {
        log('同时沿用页面筛选: ' + pageCtx.active.map((k) => k + '=' + (pageCtx.params[k] || '')).join(', '));
      }
      return searchJobsByRecommend(tabId, profile, log, {
        encryptExpectId: pageCtx.encryptExpectId || '',
        city: pageCtx.city || profile.cityCode || profile.city || '',
        filters: pageCtx.params,
      });
    }
    if (pageCtx.hasFilter) {
      const label = pageCtx.active.map((k) => k + '=' + (pageCtx.params[k] || '')).join(', ');
      log('检测到页面筛选，按筛选条件拉列表: ' + label);
      const queries = pageCtx.query
        ? [pageCtx.query]
        : profile.titles.slice(0, 3);
      if (pageCtx.query) log('沿用页面关键词: ' + pageCtx.query);
      else log('页面无关键词，改用画像职位: ' + queries.join('/'));
      return searchJobsByApi(tabId, profile, log, {
        queries,
        city: pageCtx.city || profile.cityCode || profile.city || '',
        filters: pageCtx.params,
        usePageFilters: true,
      });
    }
    // 搜索页只有关键词、没点下拉筛选：沿用页面关键词，别退回画像职位
    if (pageCtx.query && !pageCtx.onRecommend && !pageCtx.encryptExpectId) {
      log('沿用页面关键词拉列表: ' + pageCtx.query
        + (pageCtx.city ? ' · 城市 ' + pageCtx.city : ''));
      return searchJobsByApi(tabId, profile, log, {
        queries: [pageCtx.query],
        city: pageCtx.city || profile.cityCode || profile.city || '',
        filters: pageCtx.params,
        usePageFilters: false,
        mode: '页面关键词',
      });
    }
    log('未识别到求职期望/筛选，按画像职位走接口搜索');
    return searchJobsByApi(tabId, profile, log, {
      queries: profile.titles.slice(0, 3),
      city: profile.cityCode || profile.city || '',
      filters: {},
      usePageFilters: false,
    });
  }

  // 任何一次 BOSS 接口搜索：0 条且带错误码 → 刷新页面重试一次。
  // 同一次点击里最多刷一次：已经刷过还是 code=37 就是账号级频率限制，再刷也没用。
  // 备用关键词这类「额外多搜一轮」也走这里，搜完同样要更新页面标记，
  // 否则下一次点击会拿旧标记去比新文档，白跑一轮才触发补救刷新。
  async function searchWithReload(tabId, log, fn) {
    try {
      return await searchWithReloadOnce(tabId, log, fn, true);
    } finally {
      await markUsedStamp(tabId);
    }
  }

  async function searchWithReloadOnce(tabId, log, fn, allowReload) {
    let list = await fn();
    if (!list.length && lastSearchBlock && allowReload) {
      const code = lastSearchBlock.code;
      lastSearchBlock = null;
      const stamp = await reloadBossTab(tabId, log, '搜索被限流(code=' + code + ')');
      list = await fn();
      if (stamp) await markUsedStamp(tabId);
      if (!list.length && lastSearchBlock) {
        lastSearchBlock = { code: lastSearchBlock.code, hard: true };
        log('刷新后仍是 code=' + lastSearchBlock.code + '，这是账号级频率限制，等一分钟再点。');
      }
    }
    return list;
  }

  // 同一个页面文档里连搜第二轮一定被限流：第一轮吃的是页面刚加载时发的令牌，
  // 第二轮 joblist 全部回 code=37、n=0，手动刷新页面才好——所以这里自动刷。
  // 先按页面标记预判（timeOrigin 相同 = 这个文档已经搜过）；
  // 预判刷过之后不再补刷，避免一次点击刷两遍。
  async function searchJobsWithReload(tabId, profile, log) {
    let reloaded = false;
    const before = await bossPageStamp(tabId);
    if (before) {
      const used = await readUsedStamp(tabId);
      if (used && used.t === before.t && used.href === before.href) {
        reloaded = !!(await reloadBossTab(tabId, log, '这个页面已经搜过一轮，BOSS 接口会限流(code=37)'));
      }
    }
    try {
      return await searchWithReloadOnce(tabId, log, () => searchJobs(tabId, profile, log), !reloaded);
    } finally {
      // 标记「这个页面已经搜过」，下次点会自动先刷新
      await markUsedStamp(tabId);
    }
  }

  async function refineJobs(tabId, jobs, profile, log) {
    const total = jobs.length;
    let done = 0;
    let passedCount = 0;
    const refined = [];
    let stopped = false;
    let nextIdx = 0;

    const report = () => setMatchProgress('boss', {
      done, total, passed: passedCount, running: done < total && !stopped,
    });
    report();

    const take = () => {
      if (stopped) return null;
      const i = nextIdx++;
      return i < total ? jobs[i] : null;
    };

    async function worker() {
      while (true) {
        const job = take();
        if (!job) break;
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (params) => {
          try {
            const url = '/wapi/zpgeek/job/detail.json?jobId=' + encodeURIComponent(params.encryptId)
              + '&securityId=' + encodeURIComponent(params.securityId || '') + '&source=1';
            const r = await fetch(url);
            const json = await r.json();
            const blob = JSON.stringify(json);
            if (/请稍候|hasCaptcha=true|验证码|极验|captcha/i.test(blob)) {
              return { stop: true, msg: (json.message || blob).slice(0, 160) };
            }
            const d = json.zpData || {};
            const info = d.jobInfo || d.job || d;
            const desc = info.postDescription || info.jobDesc || info.description || d.postDescription || '';
            const skills = info.skills || info.skillList || d.skills || [];
            return {
              stop: false,
              jdText: String(desc).replace(/<[^>]+>/g, ' ').slice(0, 4000),
              skills: Array.isArray(skills) ? skills.map(s => typeof s === 'string' ? s : (s.name || '')).filter(Boolean) : [],
              name: info.jobName || '',
              cityName: info.cityName || info.locationName || '',
            };
          } catch (e) {
            return { stop: false, err: e.message };
          }
        },
        args: [{ encryptId: job.encryptId, securityId: job.securityId }],
      });
      const r = (res && res[0] && res[0].result) || {};
      if (r.stop) {
          stopped = true;
        log('详情风控，停止精排：' + (r.msg || ''));
        } else if (tryRefinePass(job, profile, r, log, '精排')) {
          refined.push(job);
          passedCount++;
        }
        done++;
        report();
        if (!stopped && done < total) await sleep(DETAIL_GAP_MS / REFINE_CONCURRENCY);
      }
    }

    const n = Math.min(REFINE_CONCURRENCY, total || 1);
    await Promise.all(Array.from({ length: n }, () => worker()));
    setMatchProgress('boss', { done, total, passed: passedCount, running: false });
    return { jobs: refined, stopped };
  }

  // 列表粗筛：打分 + 阈值过滤，返回通过的岗位和排除原因统计
  // 记一条方向排除明细：方向名 → { count, samples }，样例最多留 3 个岗位名
  function bumpDirStat(stats, dirName, jobName) {
    if (!dirName) return;
    const key = String(dirName);
    const cur = stats[key] || (stats[key] = { count: 0, samples: [] });
    cur.count++;
    const nm = String(jobName || '').trim();
    if (nm && cur.samples.length < 3 && cur.samples.indexOf(nm) < 0) cur.samples.push(nm);
  }

  function coarseFilter(listed, profile, log) {
    const passed = [];
    const samples = [];
    const excludeCounts = {};
    const dirStats = {};
    for (const job of listed) {
      const s = scoreList(job, profile);
      job.score = s.score;
      job.scoreDetail = s;
      bumpWhy(excludeCounts, s.why);
      if (s.why === 'direction') bumpDirStat(dirStats, s.dirName, job.name);
      if (samples.length < 5) {
        samples.push((job.name || '(无标题)') + ' ' + s.score
          + '(职位' + s.title + '/技能' + s.skill + '/工作' + s.work
          + (s.why === 'direction' && s.dirName ? '/方向:' + s.dirName : '')
          + (s.why ? '/' + whyLabel(s.why) : (s.veto ? '/否决' : '')) + ')');
      }
      if (!s.veto && s.score >= LIST_THRESHOLD) passed.push(job);
    }
    passed.sort((a, b) => b.score - a.score);
    if (samples.length) log('粗筛样例: ' + samples.join(' | '));
    logExcludes(log, excludeCounts);
    logDirectionDetail(log, dirStats);
    return { passed, excludeCounts, dirStats };
  }

  // 粗筛为 0 时的备用关键词：画像里还没用过的职位名 + 少量技能组合
  function fallbackQueries(profile, used) {
    const have = new Set([].concat(used || []).map(s => String(s || '').toLowerCase()));
    const out = [];
    const push = (q) => {
      const n = String(q || '').trim();
      if (!n || n.length > 20) return;
      const low = n.toLowerCase();
      if (have.has(low)) return;
      have.add(low);
      out.push(n);
    };
    for (const t of profile.titles || []) push(t);
    // 职位名补上「工程师」，能搜到另一批岗位；已经以它结尾的不重复加
    for (const t of (profile.titles || []).slice(0, 2)) {
      if (!/工程师$/.test(t)) push(t + '工程师');
      push('资深' + t);
    }
    for (const s of (profile.skills || []).slice(0, 2)) push(s);
    return out.slice(0, 8);
  }

  async function run({ tabId, log }) {
    await loadOutsourceCompanies();
    const appliedN = await loadAppliedLocal('boss');
    const loaded = await loadResume();
    log('简历文件: ' + loaded.file);
    const profile = extractProfile(loaded.text);
    log('画像 职位=' + profile.titles.join('/') + ' 城市=' + (profile.city || '未识别')
      + ' 技能=' + profile.skills.slice(0, 8).join(',') + ' 工作词=' + profile.workKeywords.slice(0, 8).join(','));
    log(directionLogText(profile));
    if ((outsourceNames || []).length) log('外包公司黑名单 ' + outsourceNames.length + ' 家');
    if (appliedN) log('本地已投去重 ' + appliedN + ' 条');

    const listed = await searchJobsWithReload(tabId, profile, log);
    log('搜索到 ' + listed.length + ' 条，开始列表粗筛');

    let coarse = coarseFilter(listed, profile, log);
    let passed = coarse.passed;

    // 粗筛 0 条：多半是搜索池里的岗位都投过了，换关键词再搜一轮
    const appliedBlocked = coarse.excludeCounts.applied || 0;
    if (passed.length < FALLBACK_MIN && listed.length && appliedBlocked) {
      log('被「已投/已沟通」挡掉 ' + appliedBlocked + ' 条，换关键词再搜一轮');
      const queries = fallbackQueries(profile, profile.titles.slice(0, 3)).slice(0, 3);
      if (queries.length) {
        log('备用关键词: ' + queries.join('/'));
        try {
          const more = await searchWithReload(tabId, log, () => searchJobsByApi(tabId, profile, log, {
            queries,
            city: profile.cityCode || profile.city || '',
            filters: {},
            usePageFilters: false,
            maxPages: SEARCH_PAGES,
            noDeep: true,
          }));
          const seen = new Set(listed.map(j => String(j.encryptId || '')).filter(Boolean));
          const extra = more.filter(j => j.encryptId && !seen.has(String(j.encryptId)));
          if (extra.length) {
            log('备用关键词新增 ' + extra.length + ' 条，重新粗筛');
            const again = coarseFilter(extra, profile, log);
            passed = again.passed;
            // 合并两轮的排除原因，最后的提示才不会漏掉已投数量
            for (const k of Object.keys(again.excludeCounts)) {
              coarse.excludeCounts[k] = (coarse.excludeCounts[k] || 0) + again.excludeCounts[k];
            }
            for (const k of Object.keys(again.dirStats || {})) {
              const tar = coarse.dirStats[k] || (coarse.dirStats[k] = { count: 0, samples: [] });
              const src = again.dirStats[k];
              tar.count += src.count;
              for (const nm of src.samples) {
                if (tar.samples.length < 3 && tar.samples.indexOf(nm) < 0) tar.samples.push(nm);
              }
            }
          } else {
            log('备用关键词没有搜到新岗位');
          }
        } catch (e) {
          log('备用关键词搜索失败: ' + (e.message || e));
        }
      }
    }

    const listCount = passed.length;
    log('粗筛留下 ' + passed.length + ' 条（阈值 ' + LIST_THRESHOLD + '），对前 ' + Math.min(REFINE_MAX, passed.length) + ' 条并发精排（' + REFINE_CONCURRENCY + ' 路）');

    if (!passed.length) {
      if (!listed.length) {
        if (lastSearchBlock) {
          log('BOSS 接口返回 code=' + lastSearchBlock.code + '（限流），刷新页面也没解开。'
            + '这是账号级频率限制，等一分钟再点，或先手动翻一下职位页。');
        } else {
          log('搜索接口返回 0 条：可能页面未登录、触发了风控，或该城市当前没有匹配岗位。换城市/职位词后重试。');
        }
      } else if (coarse.excludeCounts.applied) {
        log('本次搜索到的岗位都在本机已投名单里。可点「清空」重置去重，或换城市/职位词后重试。');
      } else if (coarse.excludeCounts.direction) {
        log(directionTipText(coarse.dirStats, coarse.excludeCounts.direction));
      } else {
        log('本次搜索到的岗位都被排除规则挡掉了，看上面的「已排除」明细。');
      }
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }

    const refineTop = passed.slice(0, REFINE_MAX);
    const refined = await refineJobs(tabId, refineTop, profile, log);
    let jobs = refined.jobs.slice().sort((a, b) => b.score - a.score);
    let fallback = false;
    if (!jobs.length) {
      fallback = true;
      log('精排后为 0 条，已回退粗筛前 ' + refineTop.length + ' 条');
      jobs = refineTop;
    }
    return {
      jobs, profile, stopped: refined.stopped, fallback, listCount,
      refineTotal: refineTop.length, refinePassed: fallback ? 0 : jobs.length,
    };
  }

  function parseZpRootOrgId(jobNumber) {
    const s = String(jobNumber || '');
    const m0 = s.match(/^CC(\d+)0J/i);
    if (m0) return Number(m0[1]) || m0[1];
    const m1 = s.match(/^CC(\d+)J/i);
    if (m1) return Number(m1[1]) || m1[1];
    return '';
  }

  function mapZpJob(j) {
    let custom = (j && j.cardCustomJson) || {};
    if (typeof custom === 'string') {
      try { custom = JSON.parse(custom); } catch (_) { custom = {}; }
    }
    const inner = (j && (j.job || j.position)) || j || {};
    const id = inner.number || inner.jobNumber || j.number || custom.number || custom.jobNumber
      || inner.jobId || j.jobId || inner.id || inner.positionId
      || (String(inner.positionURL || inner.jobUrl || j.positionURL || j.jobUrl || '').match(/jobdetail\/([a-zA-Z0-9]+)/i) || [])[1]
      || '';
    let skills = inner.skillLabel || inner.skillLabels || inner.skills || inner.skillList
      || custom.skillLabel || j.skillLabel || [];
    if (typeof skills === 'string') skills = skills.split(/[,，、]/);
    const jdRaw = inner.jobDesc || inner.jobDescription || inner.positionDetail || inner.description
      || inner.jobSummary || custom.jobDesc || j.jobDesc || '';
    const jdText = String(jdRaw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const companyObj = inner.company || j.company;
    const cityObj = inner.city || j.city;
    const staffCard = inner.staffCard || j.staffCard || custom.staffCard || {};
    const company = (typeof companyObj === 'string' ? companyObj : (companyObj && (companyObj.name || companyObj.companyName)))
      || inner.companyName || custom.companyName || j.companyName || j.corpName || '';
    const cityName = (typeof cityObj === 'string' ? cityObj : (cityObj && (cityObj.display || cityObj.name || cityObj.items)))
      || inner.cityName || inner.workCity || custom.cityName || custom.address || j.cityName || '';
    const salary = inner.salary || inner.salaryDesc || custom.salary60 || custom.salary
      || (inner.salaryRange && inner.salaryRange.salary) || j.salary || '';
    const scale = (typeof companyObj === 'object' && companyObj && (companyObj.companySize || companyObj.scale || companyObj.sizeName || companyObj.staffSize))
      || inner.companySize || inner.companyScale || inner.scaleName || custom.companySize
      || j.companySize || j.companyScale || j.companySizeString || '';
    let rootOrgId = inner.rootOrgId || inner.companyRootId || j.rootOrgId || j.companyRootId
      || inner.companyNumber || j.companyNumber
      || (companyObj && (companyObj.rootOrgId || companyObj.companyRootId || companyObj.number || companyObj.id))
      || custom.rootOrgId || custom.companyRootId || custom.companyNumber || '';
    let staffId = inner.staffId || j.staffId || custom.staffId || inner.hrId || j.hrId
      || staffCard.id || staffCard.staffId || inner.publisherId || j.publisherId || custom.publisherId || 0;
    if (!rootOrgId) rootOrgId = parseZpRootOrgId(id);
    const cityId = inner.cityId || j.cityId || custom.cityId
      || (cityObj && (cityObj.code || cityObj.cityId))
      || (Array.isArray(cityObj) && cityObj[0] && (cityObj[0].code || cityObj[0].cityId)) || '';
    return {
      url: inner.positionURL || inner.jobUrl || j.positionURL || j.jobUrl || ('https://www.zhaopin.com/jobdetail/' + id + '.html'),
      name: (inner.jobName || inner.positionName || inner.title || inner.name || custom.jobName || j.jobName || j.name || '').trim().substring(0, 50),
      jobId: String(id),
      company: String(company || '').trim().substring(0, 40),
      info: String(salary || cityName || '').trim().substring(0, 40),
      cityName: String(Array.isArray(cityName) ? cityName.join(' ') : cityName || '').trim(),
      salary: String(salary || '').trim(),
      scale: String(scale || '').trim(),
      degree: String(inner.eduLevel
        || (typeof inner.education === 'string' ? inner.education : (inner.education && (inner.education.name || inner.education.label)))
        || inner.degree || inner.minEducation
        || custom.eduLevel || custom.education || j.eduLevel || j.education || j.degree
        || '').trim(),
      skills: Array.isArray(skills) ? skills.map(s => typeof s === 'string' ? s : (s.name || s.skillName || '')).filter(Boolean) : [],
      tags: Array.isArray(inner.jobType) ? [].concat(inner.jobType) : [],
      jdText,
      source: 'zhaopin',
      applied: inner.applied === true || inner.hasApplied === true || j.applied === true,
      rootOrgId: String(rootOrgId || ''),
      staffId: Number(staffId) || 0,
      cityId: String(cityId || ''),
      score: 0,
    };
  }

  function collectMappedZp(rawJobs) {
    const mapped = [];
    const seen = new Set();
    for (const j of rawJobs || []) {
      const job = mapZpJob(j);
      if (!job.jobId || seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      mapped.push(job);
    }
    return mapped;
  }

  async function waitTabComplete(tabId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 15000)) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete' && /zhaopin\.com/i.test(tab.url || '')) return;
      } catch (_) { return; }
      await sleep(300);
    }
  }

  async function scrapeZhaopinCurrentList(tabId, log) {
    try {
      const pageRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const out = [];
          const seenDom = new Set();
          const add = (id, name, company, href) => {
            if (!id || seenDom.has(id)) return;
            seenDom.add(id);
            out.push({
              number: id,
              jobName: (name || '').trim(),
              companyName: (company || '').trim(),
              positionURL: href,
            });
          };
          for (const a of document.querySelectorAll('a[href*="jobdetail"]')) {
            const href = a.href || '';
            const id = (href.match(/jobdetail\/([a-zA-Z0-9]+)/i) || [])[1] || '';
            const card = a.closest('.joblist-box__item, li, article, [class*="job"]') || a;
            const nameEl = card.querySelector('[class*="job-name"], [class*="jobName"], [class*="title"], h3');
            const coEl = card.querySelector('[class*="company"], [class*="corp"]');
            add(id, (nameEl && nameEl.textContent) || a.textContent || '', (coEl && coEl.textContent) || '', href);
          }
          return {
            n: out.length,
            jobs: out,
            hrefCount: document.querySelectorAll('a[href*="jobdetail"]').length,
            url: location.href.slice(0, 160),
          };
        },
      });
      const pageRaw = (pageRes && pageRes[0] && pageRes[0].result) || { n: 0, jobs: [] };
      if (pageRaw.url) log('意向页: ' + pageRaw.url);
      return collectMappedZp(pageRaw.jobs);
    } catch (e) {
      log('抓取当前智联列表失败: ' + (e.message || e));
      return [];
    }
  }

  async function searchZhaopinByQueries(tabId, profile, log, opts) {
    const queries = (opts && opts.queries && opts.queries.length)
      ? opts.queries
      : profile.titles.slice(0, 4);
    const cityId = (opts && opts.cityId) || ZHAOPIN_CITY[profile.city] || '';
    const mode = (opts && opts.mode) || '画像接口';
    const noDeep = !!(opts && opts.noDeep);
    const mappedAll = [];
    const seen = new Set();
    let usedPages = 0;
    let maxPages = SEARCH_PAGES_MAX;
    for (let page = 1; page <= maxPages; page++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (params) => {
          const jobs = [];
          const diag = [];
          const cookieVal = (name) => {
            const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
            return m ? decodeURIComponent(m[1]) : '';
          };
          const extractList = (json) => {
            const d = json && json.data;
            if (!d) return json.list || json.results || [];
            return d.list || d.results || d.jobList || d.positions || [];
          };
          const postSearch = async (query, pageNum) => {
            const body = {
              S_SOU_FULL_INDEX: query,
              pageIndex: pageNum,
              pageSize: 30,
              eventScenario: 'pcSearchedSou',
            };
            if (params.cityId) body.S_SOU_WORK_CITY = String(params.cityId);
            const at = cookieVal('at');
            const rt = cookieVal('rt');
            if (at) body.at = at;
            if (rt) body.rt = rt;
            const apiRes = await fetch('https://fe-api.zhaopin.com/c/i/search/positions', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const t = await apiRes.text();
            if (!t || t.trim().charAt(0) === '<') return { html: true, status: apiRes.status, n: 0, list: [] };
            const json = JSON.parse(t);
            const list = extractList(json);
            const data = json.data || {};
            return {
              html: false,
              status: apiRes.status,
              code: json.code || json.status || json.apiCode,
              n: list.length,
              list,
              verify: data.isVerification,
            };
          };
          for (const query of params.queries) {
            try {
              const r = await postSearch(query, params.page);
              if (r.html) {
                diag.push(query + ' p' + params.page + ' search/positions html');
              } else {
                diag.push(query + ' p' + params.page + ' positions code=' + (r.code || '?') + ' n=' + r.n
                  + (r.verify ? ' verify=' + r.verify : ''));
                for (const j of r.list || []) jobs.push(j);
              }
            } catch (e) {
              diag.push(query + ' p' + params.page + ' err=' + e.message);
            }
          }
          return { jobs, diag };
        },
        args: [{ queries, cityId, page }],
      });
      const raw = (res && res[0] && res[0].result) || { jobs: [], diag: [] };
      if (raw.diag && raw.diag.length) log('智联搜索: ' + raw.diag.join(' | '));
      const batch = collectMappedZp(raw.jobs);
      let added = 0;
      for (const job of batch) {
        if (!job.jobId || seen.has(job.jobId)) continue;
        seen.add(job.jobId);
        mappedAll.push(job);
        added++;
      }
      usedPages = page;
      const fresh = mappedAll.filter((j) => !appliedLocal.has(String(j.jobId || ''))).length;
      if (page >= SEARCH_PAGES && fresh >= SEARCH_FRESH_TARGET) break;
      if (!added && page >= SEARCH_PAGES) break;
      if (!noDeep && page >= SEARCH_PAGES && fresh < SEARCH_FRESH_TARGET && maxPages < SEARCH_PAGES_DEEP) {
        maxPages = SEARCH_PAGES_DEEP;
        log('未投岗位只有 ' + fresh + ' 条，加深翻页到 ' + maxPages + ' 页');
      }
    }
    if (mappedAll.length) {
      log('智联搜索共 ' + mappedAll.length + ' 条（' + mode + '，' + usedPages + ' 页，目标未投≥' + SEARCH_FRESH_TARGET + '）');
      return mappedAll;
    }

    // 接口空：打开搜索页抓 DOM（仅画像兜底时多关键词；意向模式只开一个词）
    log('接口无职位，改为打开搜索页抓列表');
    for (const query of queries) {
      const pathKw = encodeURIComponent(query).replace(/%20/g, '');
      const url = 'https://www.zhaopin.com/sou/jl' + (cityId || '538') + '/kw' + pathKw + '/p1';
      try {
        await chrome.tabs.update(tabId, { url });
        await waitTabComplete(tabId, 15000);
        await sleep(2500);
        const pageJobs = await scrapeZhaopinCurrentList(tabId, log);
        log('搜索页 ' + query + ' n=' + pageJobs.length);
        for (const job of pageJobs) {
          if (!job.jobId || seen.has(job.jobId)) continue;
          seen.add(job.jobId);
          mappedAll.push(job);
        }
      } catch (e) {
        log('打开搜索页失败 ' + query + ' ' + (e.message || e));
      }
    }
    return mappedAll;
  }

  async function searchZhaopinJobs(tabId, profile, log) {
    log('按画像职位走接口搜索');
    return searchZhaopinByQueries(tabId, profile, log, {
      queries: profile.titles.slice(0, 4),
      cityId: ZHAOPIN_CITY[profile.city] || '',
      mode: '画像接口',
    });
  }

  async function waitRefineTab(tabId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return true;
      } catch (_) { return false; }
      await sleep(300);
    }
    return false;
  }

  // 智联 JD：指定后台标签页读详情
  async function zpJdOnTab(tabId, jobId) {
    const url = 'https://www.zhaopin.com/jobdetail/' + encodeURIComponent(jobId) + '.htm';
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (e) {
      return { desc: '', diag: 'tab更新失败:' + (e.message || ''), blocked: false };
    }
    const ok = await waitRefineTab(tabId, 15000);
    if (!ok) return { desc: '', diag: 'tab超时', blocked: false };
    await sleep(900);
    let res;
    try {
      res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const strip = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          const body = strip(document.body ? document.body.innerText : '');
          if (/Security Verification|滑动验证|请完成安全验证/.test(body) && body.length < 1200) {
            return { desc: '', blocked: true, len: body.length };
          }
          let desc = '';
          const sels = [
            '[class*="describtion__detail-content"]', '[class*="describtion"]',
            '[class*="job-description"]', '[class*="jobDescription"]', '[class*="description"]',
          ];
          for (const sel of sels) {
            document.querySelectorAll(sel).forEach((el) => {
              const t = strip(el.innerText);
              if (t.length > desc.length) desc = t;
            });
            if (desc.length >= 80) break;
          }
          if (desc.length < 40) {
            const m = body.match(/职位描述([\s\S]{40,4000}?)(?:工作地址|地图|举报|相似职位|公司信息)/)
              || body.match(/岗位职责([\s\S]{40,4000}?)(?:工作地址|举报|公司信息)/);
            if (m) desc = strip(m[1]);
          }
          const nameEl = document.querySelector('[class*="summary-plane__title"], [class*="job-name"], h1');
          const cityEl = document.querySelector('[class*="summary-plane__info"] li, [class*="job-address"]');
          const skills = Array.from(document.querySelectorAll('[class*="tag"], [class*="skill"]'))
            .map((e) => strip(e.innerText)).filter((t) => t && t.length <= 12).slice(0, 20);
          return {
            desc: desc.slice(0, 4000),
            name: nameEl ? strip(nameEl.innerText).slice(0, 50) : '',
            city: cityEl ? strip(cityEl.innerText).slice(0, 20) : '',
            skills,
            blocked: false,
            len: body.length,
          };
        },
      });
    } catch (e) {
      return { desc: '', diag: 'tab注入失败:' + (e.message || ''), blocked: false };
    }
    const r = (res && res[0] && res[0].result) || {};
    r.diag = 'tab body=' + (r.len || 0) + ' desc=' + ((r.desc && r.desc.length) || 0);
    return r;
  }

  async function refineZhaopinJobs(_tabId, jobs, profile, log) {
    const total = jobs.length;
    let done = 0;
    let passedCount = 0;
    const refined = [];
    let stopped = false;
    let nextIdx = 0;

    const report = () => setMatchProgress('zp', {
      done, total, passed: passedCount, running: done < total && !stopped,
    });
    report();

    const concurrency = Math.min(REFINE_CONCURRENCY, total || 1);
    const tabIds = [];
    for (let i = 0; i < concurrency; i++) {
      const t = await chrome.tabs.create({ url: 'about:blank', active: false });
      tabIds.push(t.id);
    }

    const take = () => {
      if (stopped) return null;
      const i = nextIdx++;
      return i < total ? jobs[i] : null;
    };

    async function worker(tabId) {
      while (true) {
        const job = take();
        if (!job) break;
        let meta = { cityName: job.cityName, name: job.name };
        if (!(job.jdText && job.jdText.length >= 40)) {
          const t = await zpJdOnTab(tabId, job.jobId);
          if (t.blocked) {
            stopped = true;
            log('智联详情页安全验证，停止精排（后台标签页）');
          } else if (t.desc && t.desc.length >= 40) {
            meta = {
              jdText: t.desc,
              name: t.name || job.name,
              cityName: t.city || job.cityName,
              skills: t.skills || [],
            };
          } else if (!job.jdText) {
            log('精排无JD ' + job.name + ' id=' + job.jobId + ' ' + (t.diag || ''));
          }
        } else {
          meta.jdText = job.jdText;
        }
        if (!stopped && tryRefinePass(job, profile, meta, log, '智联精排')) {
          refined.push(job);
          passedCount++;
        }
        done++;
        report();
        if (!stopped && done < total) await sleep(DETAIL_GAP_MS / REFINE_CONCURRENCY);
      }
    }

    try {
      await Promise.all(tabIds.map((id) => worker(id)));
    } finally {
      for (const id of tabIds) {
        try { await chrome.tabs.remove(id); } catch (_) {}
      }
      setMatchProgress('zp', { done, total, passed: passedCount, running: false });
    }
    return { jobs: refined, stopped };
  }

  // 智联列表粗筛（含公司名，方便对照）
  function coarseFilterZp(listed, profile, log) {
    const passed = [];
    const samples = [];
    const excludeCounts = {};
    const dirStats = {};
    for (const job of listed) {
      const s = scoreList(job, profile);
      job.score = s.score;
      job.scoreDetail = s;
      bumpWhy(excludeCounts, s.why);
      if (s.why === 'direction') bumpDirStat(dirStats, s.dirName, job.name);
      if (samples.length < 5) {
        samples.push((job.name || '(无标题)') + ' ' + s.score
          + (job.company ? '|' + job.company : '')
          + (s.why === 'direction' && s.dirName ? '/方向:' + s.dirName : '')
          + (s.why ? '/' + whyLabel(s.why) : (s.veto ? '/否决' : '')));
      }
      if (!s.veto && s.score >= LIST_THRESHOLD) passed.push(job);
    }
    passed.sort((a, b) => b.score - a.score);
    if (samples.length) log('粗筛样例: ' + samples.join(' | '));
    logExcludes(log, excludeCounts);
    logDirectionDetail(log, dirStats);
    return { passed, excludeCounts, dirStats };
  }

  async function runZhaopin({ tabId, log }) {
    await loadOutsourceCompanies();
    const appliedN = await loadAppliedLocal('zp');
    const loaded = await loadResume();
    log('简历文件: ' + loaded.file);
    const profile = extractProfile(loaded.text);
    log('画像 职位=' + profile.titles.join('/') + ' 城市=' + (profile.city || '未识别')
      + ' 技能=' + profile.skills.slice(0, 8).join(',') + ' 工作词=' + profile.workKeywords.slice(0, 8).join(','));
    log(directionLogText(profile));
    if ((outsourceNames || []).length) log('外包公司黑名单 ' + outsourceNames.length + ' 家');
    if (appliedN) log('本地已投去重 ' + appliedN + ' 条');

    const listed = await searchZhaopinJobs(tabId, profile, log);
    if (!listed.length) {
      log('智联搜索接口和搜索页都没有职位。请确认当前标签页已登录智联，并重新加载扩展后再试。');
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    log('智联搜索到 ' + listed.length + ' 条，开始粗筛');

    let coarse = coarseFilterZp(listed, profile, log);
    let passed = coarse.passed;

    // 粗筛 0 条且被「已投」挡掉：换关键词再搜一轮（同 BOSS）
    const appliedBlocked = coarse.excludeCounts.applied || 0;
    if (passed.length < FALLBACK_MIN && appliedBlocked) {
      log('被「已投/已沟通」挡掉 ' + appliedBlocked + ' 条，换关键词再搜一轮');
      const queries = fallbackQueries(profile, profile.titles.slice(0, 4)).slice(0, 3);
      if (queries.length) {
        log('备用关键词: ' + queries.join('/'));
        try {
          const more = await searchZhaopinByQueries(tabId, profile, log, {
            queries,
            cityId: ZHAOPIN_CITY[profile.city] || '',
            mode: '备用关键词',
            noDeep: true,
          });
          const seen = new Set(listed.map(j => String(j.jobId || '')).filter(Boolean));
          const extra = more.filter(j => j.jobId && !seen.has(String(j.jobId)));
          if (extra.length) {
            log('备用关键词新增 ' + extra.length + ' 条，重新粗筛');
            const again = coarseFilterZp(extra, profile, log);
            passed = again.passed;
            for (const k of Object.keys(again.excludeCounts)) {
              coarse.excludeCounts[k] = (coarse.excludeCounts[k] || 0) + again.excludeCounts[k];
            }
            for (const k of Object.keys(again.dirStats || {})) {
              const tar = coarse.dirStats[k] || (coarse.dirStats[k] = { count: 0, samples: [] });
              const src = again.dirStats[k];
              tar.count += src.count;
              for (const nm of src.samples) {
                if (tar.samples.length < 3 && tar.samples.indexOf(nm) < 0) tar.samples.push(nm);
              }
            }
          } else {
            log('备用关键词没有搜到新岗位');
          }
        } catch (e) {
          log('备用关键词搜索失败: ' + (e.message || e));
        }
      }
    }

    const listCount = passed.length;
    log('粗筛留下 ' + passed.length + ' 条，对前 ' + Math.min(REFINE_MAX, passed.length) + ' 条并发精排（' + REFINE_CONCURRENCY + ' 路后台标签）');
    if (!passed.length) {
      if (coarse.excludeCounts.applied) {
        log('本次搜到的岗位都在本机已投名单里。可点「清空」重置去重，或换城市/职位词后重试。');
      } else if (coarse.excludeCounts.direction) {
        log(directionTipText(coarse.dirStats, coarse.excludeCounts.direction));
      } else {
        log('智联匹配结果为 0 条。看样例：可能被校招/不可选中/派遣规则排除，或未过阈值 ' + LIST_THRESHOLD + '。');
      }
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    const refineTop = passed.slice(0, REFINE_MAX);
    const refined = await refineZhaopinJobs(tabId, refineTop, profile, log);
    let jobs = refined.jobs.slice().sort((a, b) => b.score - a.score);
    let fallback = false;
    if (!jobs.length) {
      fallback = true;
      log('智联精排后为 0 条，已回退粗筛前 ' + refineTop.length + ' 条');
      jobs = refineTop;
    }
    return {
      jobs, profile, stopped: refined.stopped, fallback, listCount,
      refineTotal: refineTop.length, refinePassed: fallback ? 0 : jobs.length,
    };
  }

  function map51Job(j) {
    const id = String(j.jobId || j.jobid || '');
    const tags = [].concat(j.jobTags || []).map(t => typeof t === 'string' ? t : (t && (t.name || t.label)) || '').filter(Boolean);
    const href = j.jobHref || j.jobUrl || (id ? ('https://we.51job.com/job?jobId=' + id) : '');
    const ctmFromHref = (String(href).match(/[?&]ctmid=(\d+)/i) || [])[1] || '';
    const applyType = j.applyType;
    const applyUrl = String(j.applyUrl || j.jobApplyUrl || j.applyHref || '');
    const applied = j.isApply === '1' || j.isApply === 1 || j.isApplied === true;
    const resumeFlow = j.resumeFlow === true || is51ResumeFlow({
      source: '51job', applyType, applyUrl, url: href, tags,
    });
    const jd = String(j.jobDescribe || j.jobDescription || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      url: href,
      name: (j.jobName || j.jobTitle || '').trim().substring(0, 50),
      jobId: id,
      company: String(j.fullCompanyName || j.companyName || '').trim().substring(0, 40),
      info: String(j.provideSalaryString || j.providesalaryString || j.jobAreaString || '').trim().substring(0, 40),
      salary: String(j.provideSalaryString || j.providesalaryString || '').trim(),
      scale: String(j.companySizeString || j.companySize || '').trim(),
      degree: String(j.degreeString || j.degreeName || j.degree || j.eduLevel || '').trim(),
      cityName: String(j.jobAreaString || '').trim(),
      skills: tags,
      tags,
      jdText: jd.slice(0, 4000),
      source: '51job',
      applyType,
      applyUrl,
      applied,
      resumeFlow,
      canDirectApply: j.canDirectApply,
      ctmId: String(j.ctmId || j.ctmid || j.coId || j.companyId || j.encCoId || ctmFromHref || ''),
      canSelect: !(applied || resumeFlow || applyType === 1 || applyType === '1'),
      listIndex: j.listIndex != null ? j.listIndex : undefined,
      score: 0,
    };
  }

  async function waitTabLoad51(tabId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 25000);
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          await sleep(1200);
          return true;
        }
      } catch (_) { return false; }
      await sleep(300);
    }
    return false;
  }

  async function waitW51ListDom(tabId, log, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 18000);
    let lastDiag = '';
    while (Date.now() < deadline) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          window.scrollTo(0, Math.min(800, document.body.scrollHeight));
          const list = document.querySelector('.joblist');
          const items = list ? list.querySelectorAll('.joblist-item') : document.querySelectorAll('.joblist-item');
          const applyN = document.querySelectorAll('button.btn.apply, button[class*="apply"]').length;
          return {
            applyN,
            itemN: items.length,
            hasList: !!list,
            url: location.href.slice(0, 120),
          };
        },
      });
      const d = (res && res[0] && res[0].result) || {};
      lastDiag = 'applyBtn=' + (d.applyN || 0) + ' item=' + (d.itemN || 0) + ' list=' + (d.hasList ? 1 : 0);
      if ((d.applyN || 0) > 0 || (d.itemN || 0) > 0) return d;
      await sleep(700);
    }
    if (log) log('等待列表超时: ' + lastDiag);
    return null;
  }

  async function ensureW51SearchPage(tabId, profile, log) {
    const keyword = (profile.titles && profile.titles[0]) || '';
    const jobArea = JOB51_CITY[profile.city] || '020000';
    const url = 'https://we.51job.com/pc/search?keyword=' + encodeURIComponent(keyword)
      + '&jobArea=' + encodeURIComponent(jobArea);
    log('同步搜索页: ' + (keyword || '默认'));
    await chrome.tabs.update(tabId, { url });
    await waitTabLoad51(tabId, 30000);
    await waitW51ListDom(tabId, log, 18000);
    return true;
  }

  async function scrape51JobsFromDom(tabId, log) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const cards = document.querySelectorAll('.joblist-item');
        const pickJobId = (html, root, apiItem) => {
          const fromApi = String(apiItem?.jobId || apiItem?.jobid || '');
          if (fromApi) return fromApi;
          if (root) {
            for (const el of root.querySelectorAll('[sensorsdata], [data-sensors], [data-jobid]')) {
              const raw = el.getAttribute('sensorsdata') || el.getAttribute('data-sensors') || el.getAttribute('data-jobid') || '';
              try {
                const j = raw.startsWith('{') ? JSON.parse(raw) : null;
                if (j?.jobId || j?.jobid) return String(j.jobId || j.jobid);
              } catch (_) {}
              const dm = raw.match(/(\d{6,})/);
              if (dm) return dm[1];
            }
            for (const a of root.querySelectorAll('a[href]')) {
              const h = a.getAttribute('href') || a.href || '';
              const hm = h.match(/jobId=(\d+)/i)
                || h.match(/\/(\d{6,})\.html/i)
                || h.match(/\/job\/(\d+)/i);
              if (hm) return hm[1];
            }
          }
          for (const re of [
            /jobId["':=\s]+(\d{6,})/i,
            /data-jobid=["'](\d+)/i,
            /jobid["':=\s]+(\d{6,})/i,
            /"jobId"\s*:\s*"?(\d{6,})/i,
          ]) {
            const m = html.match(re);
            if (m) return m[1];
          }
          return '';
        };

        let apiItems = [];
        const params = new URLSearchParams(location.search);
        const keyword = params.get('keyword') || '';
        const jobArea = params.get('jobArea') || '020000';
        const sortType = params.get('sortType') || '0';
          const activePageEl = document.querySelector('.el-pager li.number.active, .el-pagination li.active, .pager .active');
        let pageNum = parseInt(String(activePageEl && activePageEl.textContent || params.get('pageNum') || '1').trim(), 10);
        if (!Number.isFinite(pageNum) || pageNum < 1) pageNum = 1;
        if (cards.length) {
          const apiUrl = 'https://we.51job.com/api/job/search-pc?api_key=51job'
            + '&timestamp=' + Date.now()
            + '&keyword=' + encodeURIComponent(keyword)
            + '&searchType=2&jobArea=' + encodeURIComponent(jobArea)
            + '&sortType=' + encodeURIComponent(sortType)
            + '&pageNum=' + pageNum + '&pageSize=20&source=1&accountId=&scene=7';
          try {
            const apiRes = await fetch(apiUrl, {
              credentials: 'include',
              headers: { Accept: 'application/json, text/plain, */*', Referer: location.href },
            });
            const t = await apiRes.text();
            if (t && t.trim().charAt(0) === '{') {
              const json = JSON.parse(t);
              apiItems = (json.resultbody && json.resultbody.job && json.resultbody.job.items)
                || (json.resultbody && json.resultbody.jobList)
                || json.jobList || [];
            }
          } catch (_) {}
        }

        const jobs = [];
        const seenIds = new Set();
        cards.forEach((card, listIndex) => {
          const html = card.outerHTML || '';
          const api = apiItems[listIndex] || {};
          let jobId = pickJobId(html, card, api);
          if (!jobId) jobId = 'L' + listIndex;
          if (seenIds.has(jobId)) jobId = 'L' + listIndex;
          seenIds.add(jobId);
          const nameEl = card.querySelector('.jname, a[title], a');
          const companyEl = card.querySelector('.cname');
          const infoEl = card.querySelector('.sal');
          const btn = card.querySelector('button.btn.apply');
          const btnText = (btn?.textContent || btn?.innerText || '').trim();
          const applied = !!(btn && /已申请|已投递/.test(btnText));
          const cardHtml = html;
          const applyUrl = String(api.applyUrl || api.jobApplyUrl || api.applyHref || '');
          let applyType = api.applyType;
          for (const el of card.querySelectorAll('[sensorsdata], [data-sensors]')) {
            try {
              const raw = el.getAttribute('sensorsdata') || el.getAttribute('data-sensors') || '';
              if (!raw.startsWith('{')) continue;
              const j = JSON.parse(raw);
              if (j.applyType != null && applyType == null) applyType = j.applyType;
              if (j.jobApplyType != null && applyType == null) applyType = j.jobApplyType;
            } catch (_) {}
          }
          const resumeFlowRe = /xyz\.51job\.com|consumer\/pc\/resume|External\/Apply|JobsSelect\.aspx/i;
          const resumeBtnRe = /网申|官网申请|外部申请|完善简历|选择简历|填写简历|到官网|外部投递/;
          const resumeFlow = resumeFlowRe.test(cardHtml + ' ' + applyUrl)
            || resumeBtnRe.test(btnText)
            || applyType === 1 || applyType === '1' || applyType === 2 || applyType === '2'
            || applyType === 3 || applyType === '3'
            || api.canDirectApply === false || api.canDirectApply === '0' || api.canDirectApply === 0;
          const jd = String(api.jobDescribe || api.jobDescription || '').replace(/<[^>]+>/g, ' ').trim()
            || (card.innerText || '').slice(0, 800);
          jobs.push({
            jobId: String(api.jobId || api.jobid || jobId),
            listIndex,
            jobName: (nameEl?.textContent || nameEl?.getAttribute('title') || api.jobName || '').trim(),
            fullCompanyName: (companyEl?.textContent || api.fullCompanyName || api.companyName || '').trim(),
            provideSalaryString: (infoEl?.textContent || api.provideSalaryString || '').trim(),
            companySizeString: String(api.companySizeString || api.companySize || '').trim(),
            jobAreaString: String(api.jobAreaString || '').trim(),
            isApply: applied ? '1' : '0',
            jobDescribe: jd,
            jobHref: api.jobHref || api.jobUrl || '',
            applyUrl,
            applyType,
            resumeFlow,
            canDirectApply: api.canDirectApply,
            ctmId: String(api.ctmId || api.ctmid || api.coId || ''),
            jobTags: api.jobTags || [],
          });
        });
        return {
          jobs,
          diag: {
            listItems: cards.length,
            applyBtns: document.querySelectorAll('button.btn.apply').length,
            apiItems: apiItems.length,
            url: location.href.slice(0, 120),
          },
        };
      },
    });
    const pack = (res && res[0] && res[0].result) || { jobs: [], diag: {} };
    const raw = pack.jobs || [];
    if (pack.diag) {
      if (!raw.length && (pack.diag.listItems || 0) > 0) {
        log('列表有 ' + pack.diag.listItems + ' 条但未合并成功，api=' + (pack.diag.apiItems || 0));
      } else if (!raw.length) {
        log('列表 DOM 诊断 items=' + (pack.diag.listItems || 0)
          + ' applyBtn=' + (pack.diag.applyBtns || 0));
      } else if ((pack.diag.apiItems || 0) > 0) {
        log('列表 ' + pack.diag.listItems + ' 条，API 对齐 ' + pack.diag.apiItems + ' 条');
      }
      if (pack.diag.url) log('页面: ' + pack.diag.url);
    }
    log('当前搜索列表可见 ' + raw.length + ' 个');
    const mapped = [];
    const seen = new Set();
    for (const j of raw) {
      const job = map51Job(j);
      if (!job.jobId || seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      job.onPage = true;
      if (j.listIndex != null) job.listIndex = j.listIndex;
      mapped.push(job);
    }
    return mapped;
  }

  async function list51JobsFromPage(tabId, profile, log) {
    await ensureW51SearchPage(tabId, profile, log);
    return scrape51JobsFromDom(tabId, log);
  }

  async function clickW51NextPage(tabId) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const next = document.querySelector(
            '.btn-next:not(.disabled), button.btn-next:not([disabled]), .el-pagination .btn-next:not(.disabled), li.number.active + li.number, a.next:not(.disabled)',
          );
          if (!next || next.disabled || /disabled|is-disabled/.test(next.className || '')) return false;
          next.click();
          return true;
        },
      });
      return !!(res && res[0] && res[0].result);
    } catch (_) {
      return false;
    }
  }

  /** 当前页无职位 / 无新可投时翻页，最多 SEARCH_PAGES_MAX 页 */
  async function collect51JobsPaging(tabId, profile, log) {
    const passed = [];
    const samples = [];
    const excludeCounts = {};
    const dirStats = {};
    let listedTotal = 0;
    const pageSeen = new Set();

    for (let page = 1; page <= SEARCH_PAGES_MAX; page++) {
      if (page > 1) {
        log('本页无新岗位，翻到第 ' + page + ' 页');
        const moved = await clickW51NextPage(tabId);
        if (!moved) {
          log('没有下一页，停止翻页');
          break;
        }
        await sleep(1200);
        await waitW51ListDom(tabId, log, 12000);
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url) await chrome.storage.local.set({ w51_search_url: tab.url });
        } catch (_) {}
      }

      const listed = await scrape51JobsFromDom(tabId, log);
      if (!listed.length) {
        log('第 ' + page + ' 页列表为 0');
        continue;
      }
      listedTotal += listed.length;
      let pageNew = 0;
      for (const job of listed) {
        const id = String(job.jobId || '');
        if (id && pageSeen.has(id)) continue;
        if (id) pageSeen.add(id);
        const s = scoreList(job, profile);
        job.score = s.score;
        job.scoreDetail = s;
        bumpWhy(excludeCounts, s.why);
        if (s.why === 'direction') bumpDirStat(dirStats, s.dirName, job.name);
        if (samples.length < 5) {
          samples.push((job.name || '(无标题)') + ' ' + s.score
            + (job.company ? '|' + job.company : '')
            + (s.why === 'direction' && s.dirName ? '/方向:' + s.dirName : '')
            + (s.why ? '/' + whyLabel(s.why) : (s.veto ? '/否决' : '')));
        }
        if (!s.veto && s.score >= LIST_THRESHOLD) {
          passed.push(job);
          pageNew++;
        }
      }
      log('第 ' + page + ' 页可见 ' + listed.length + '，新增可投 ' + pageNew + '（累计 ' + passed.length + '）');
      if (passed.length >= REFINE_MAX) break;
      if (pageNew > 0) break; // 本页已有新岗，先精排这批；再点匹配会跳过它们并继续翻页
    }

    passed.sort((a, b) => b.score - a.score);
    return { passed, samples, excludeCounts, dirStats, listedTotal };
  }

  async function loadW51SkipIds(tabUrl) {
    const appliedN = await loadAppliedLocal('w51');
    let matchedN = 0;
    try {
      let kw = '';
      try { kw = new URL(tabUrl || '').searchParams.get('keyword') || ''; } catch (_) {}
      const s = await chrome.storage.local.get(['w51_matched_ids', 'w51_matched_kw']);
      if (kw && s.w51_matched_kw && s.w51_matched_kw !== kw) {
        await chrome.storage.local.set({ w51_matched_ids: [], w51_matched_kw: kw });
      } else if (kw && !s.w51_matched_kw) {
        await chrome.storage.local.set({ w51_matched_kw: kw });
      }
      const s2 = await chrome.storage.local.get('w51_matched_ids');
      const arr = Array.isArray(s2.w51_matched_ids) ? s2.w51_matched_ids.map(String) : [];
      matchedN = arr.length;
      for (const id of arr) {
        if (id) appliedLocal.add(id);
      }
    } catch (_) {}
    return { appliedN, matchedN };
  }

  async function rememberW51Matched(jobs, tabUrl) {
    try {
      let kw = '';
      try { kw = new URL(tabUrl || '').searchParams.get('keyword') || ''; } catch (_) {}
      const s = await chrome.storage.local.get('w51_matched_ids');
      let arr = Array.isArray(s.w51_matched_ids) ? s.w51_matched_ids.map(String) : [];
      for (const j of jobs || []) {
        const id = String(j.jobId || '').trim();
        if (id && !arr.includes(id)) arr.push(id);
      }
      if (arr.length > 800) arr = arr.slice(-800);
      const payload = { w51_matched_ids: arr };
      if (kw) payload.w51_matched_kw = kw;
      await chrome.storage.local.set(payload);
    } catch (_) {}
  }

  async function search51Jobs(tabId, profile, log) {
    const queries = profile.titles.slice(0, 4);
    const jobArea = JOB51_CITY[profile.city] || '020000';
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (params) => {
        const jobs = [];
        const diag = [];
        for (const query of params.queries) {
          for (let page = 1; page <= params.pages; page++) {
            const url = 'https://we.51job.com/api/job/search-pc?api_key=51job'
              + '&timestamp=' + Date.now()
              + '&keyword=' + encodeURIComponent(query)
              + '&searchType=2&jobArea=' + encodeURIComponent(params.jobArea)
              + '&sortType=0&pageNum=' + page + '&pageSize=30&source=1&accountId=&scene=7';
            try {
              const apiRes = await fetch(url, {
                credentials: 'include',
                headers: {
                  Accept: 'application/json, text/plain, */*',
                  Referer: 'https://we.51job.com/pc/search',
                },
              });
              const t = await apiRes.text();
              if (!t || t.trim().charAt(0) === '<') {
                diag.push(query + ' p' + page + ' html');
                continue;
              }
              const json = JSON.parse(t);
              const items = (json.resultbody && json.resultbody.job && json.resultbody.job.items)
                || (json.resultbody && json.resultbody.jobList)
                || json.jobList || [];
              diag.push(query + ' p' + page + ' status=' + (json.status || json.code || apiRes.status) + ' n=' + items.length);
              for (const j of items) jobs.push(j);
            } catch (e) {
              diag.push(query + ' p' + page + ' err=' + e.message);
            }
          }
        }
        return { jobs, diag };
      },
      args: [{ queries, jobArea, pages: SEARCH_PAGES }],
    });
    const raw = (res && res[0] && res[0].result) || { jobs: [], diag: [] };
    if (raw.diag && raw.diag.length) log('前程搜索: ' + raw.diag.join(' | '));
    const mapped = [];
    const seen = new Set();
    for (const j of raw.jobs || []) {
      const job = map51Job(j);
      if (!job.jobId || seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      mapped.push(job);
    }
    return mapped;
  }

  async function refine51Jobs(_tabId, jobs, profile, log) {
    const total = jobs.length;
    let done = 0;
    let passedCount = 0;
    const refined = [];
    const report = () => setMatchProgress('w51', {
      done, total, passed: passedCount, running: done < total,
    });
    report();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (tryRefinePass(job, profile, { cityName: job.cityName }, log, '前程精排')) {
        refined.push(job);
        passedCount++;
      }
      done++;
      if (done % 4 === 0 || done === total) report();
    }
    setMatchProgress('w51', { done, total, passed: passedCount, running: false });
    return { jobs: refined, stopped: false };
  }

  async function saveW51SearchCtx(profile) {
    const jobArea = JOB51_CITY[profile.city] || '020000';
    try {
      await chrome.storage.local.set({
        w51_ctx: {
          keyword: (profile.titles && profile.titles[0]) || '',
          jobArea,
          queries: (profile.titles || []).slice(0, 4),
        },
      });
    } catch (_) {}
  }

  async function run51job({ tabId, log }) {
    await loadOutsourceCompanies();
    const loaded = await loadResume();
    log('简历文件: ' + loaded.file);
    const profile = extractProfile(loaded.text);
    log('画像 职位=' + profile.titles.join('/') + ' 城市=' + (profile.city || '未识别')
      + ' 技能=' + profile.skills.slice(0, 8).join(',') + ' 工作词=' + profile.workKeywords.slice(0, 8).join(','));
    log(directionLogText(profile));
    if ((outsourceNames || []).length) log('外包公司黑名单 ' + outsourceNames.length + ' 家');

    await saveW51SearchCtx(profile);
    let tabUrl = '';
    try { tabUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    const skip = await loadW51SkipIds(tabUrl);
    if (skip.appliedN) log('本地已投去重 ' + skip.appliedN + ' 条');
    if (skip.matchedN) log('上次匹配已跳过 ' + skip.matchedN + ' 条');
    try {
      await chrome.storage.local.set({ w51_match_tab: tabId, w51_search_url: tabUrl });
    } catch (_) {}
    log('按列表匹配；本页无新岗会自动翻页（最多 ' + SEARCH_PAGES_MAX + ' 页）');
    if (!tabUrl.includes('we.51job.com')) {
      log('请先打开 we.51job.com 搜索页并手动搜出结果');
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    await waitW51ListDom(tabId, log, 12000);
    const collected = await collect51JobsPaging(tabId, profile, log);
    const passed = collected.passed;
    if (collected.samples.length) log('粗筛样例: ' + collected.samples.join(' | '));
    logExcludes(log, collected.excludeCounts);
    logDirectionDetail(log, collected.dirStats);
    if (!collected.listedTotal) {
      log('前 ' + SEARCH_PAGES_MAX + ' 页列表均为 0。请在前程搜索页手动搜索后看到职位再匹配。');
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    log('粗筛留下 ' + passed.length + ' 条，对前 ' + Math.min(REFINE_MAX, passed.length) + ' 条精排');
    if (!passed.length) {
      if (collected.excludeCounts.direction) {
        log('前程匹配结果为 0 条：' + directionTipText(collected.dirStats, collected.excludeCounts.direction));
      } else {
        log('前程匹配结果为 0 条。本页新岗已跳过或被规则排除，可手动翻页后再匹配。');
      }
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    const refineTop = passed.slice(0, REFINE_MAX);
    const refined = await refine51Jobs(tabId, refineTop, profile, log);
    let jobs = refined.jobs.slice().sort((a, b) => b.score - a.score);
    let fallback = false;
    if (!jobs.length) {
      fallback = true;
      log('前程精排后为 0 条，已回退粗筛前 ' + refineTop.length + ' 条');
      jobs = refineTop;
    }
    try { tabUrl = (await chrome.tabs.get(tabId)).url || tabUrl; } catch (_) {}
    await rememberW51Matched(jobs, tabUrl);
    return {
      jobs, profile, stopped: refined.stopped, fallback, listCount: passed.length,
      refineTotal: refineTop.length, refinePassed: fallback ? 0 : jobs.length,
    };
  }

  return { loadResume, extractProfile, run, runZhaopin, run51job, LIST_THRESHOLD, REFINE_MAX, DEGREE_OPTS, DIRECTION_MAX_OPTS, directionOptionsOf, selectedDirectionsOf, directionKeywordsOf, isGenericDirectionName };
})();
