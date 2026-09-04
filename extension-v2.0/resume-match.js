// resume-match.js — 按本地简历匹配拉取 BOSS 职位（独立于搜索页抓取）
window.ResumeMatch = (() => {
  const LIST_THRESHOLD = 40;
  const REFINE_MAX = 20;
  const REFINE_CONCURRENCY = 4;
  const SEARCH_PAGES = 2;
  const DETAIL_GAP_MS = 1500;

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
  const DISPATCH = /派遣|代招|代聘|劳务派遣|岗位外包|人力外包|招聘外包|外包招聘|驻场外包|劳务外包/;
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
        return normalizeProfile({
          titles: j.titles || j.title || [],
          city: j.city || '',
          skills: j.skills || [],
          workKeywords: j.workKeywords || j.work || [],
          salaryMin: j.salaryMin,
          scaleMin: j.scaleMin,
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
    return { titles, city, cityCode: CITY_CODE[city] || '', skills, workKeywords, salaryMin: salaryMinK(p.salaryMin), scaleMin: salaryMinK(p.scaleMin) };
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
    const unitWan = /万/.test(s);
    const unitQian = /千/.test(s);
    const unitK = /[kK]/.test(s);
    const nums = [];
    const re = /(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(s))) nums.push(parseFloat(m[1]));
    if (!nums.length) return null;
    let lo = nums[0];
    let hi = nums.length > 1 ? nums[1] : nums[0];
    if (nums.length >= 3 && nums[2] >= 12 && nums[2] <= 16) hi = nums[1];
    const toK = (n) => {
      if (unitWan) return yearly ? (n * 10) / 12 : n * 10;
      if (unitQian || unitK) return yearly ? n / 12 : n;
      if (n >= 1000) return yearly ? n / 12 / 1000 : n / 1000;
      return yearly ? n / 12 : n;
    };
    return { min: toK(lo), max: toK(hi) };
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
    if (job.canSelect === false || job.disabled === true) return 'unselect';
    if (UNSELECT.test(blob)) return 'unselect';
    if (job.source === '51job' && is51ResumeFlow(job)) return 'resumeFlow';
    if (job.source === '51job' && (job.applyType === 1 || job.applyType === '1')) return 'unselect';
    return '';
  }

  function whyLabel(why) {
    return ({
      dispatch: '派遣/代招', campus: '校招', unselect: '不可选中',
      hunter: '猎头', applied: '已投/已沟通', resumeFlow: '简历投递', salary: '薪资过低', scale: '规模过小',
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
    const block = extraWhy(job) || (isDispatch(job) ? 'dispatch' : '')
      || (salaryTooLow(job, profile) ? 'salary' : '')
      || (scaleTooSmall(job, profile) ? 'scale' : '');
    if (block) {
      log('精排淘汰(' + whyLabel(block) + ') ' + job.name + (job.company ? ' | ' + job.company : ''));
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
      + (hasJd ? '/有JD' : '/无JD') + ')');
    return true;
  }

  function logExcludes(log, counts) {
    const parts = [];
    for (const k of ['dispatch', 'campus', 'unselect', 'hunter', 'applied', 'salary', 'scale']) {
      if (counts[k]) parts.push(whyLabel(k) + ' ' + counts[k]);
    }
    if (parts.length) log('已排除 ' + parts.join('、') + ' 条');
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
    const extra = extraWhy(job) || (isDispatch(job) ? 'dispatch' : '')
      || (salaryTooLow(job, profile) ? 'salary' : '')
      || (scaleTooSmall(job, profile) ? 'scale' : '');
    if (extra) return { score: 0, veto: true, title: 0, skill: 0, work: 0, why: extra };
    if (isVeto(profile, job.name)) return { score: 0, veto: true, title: 0, skill: 0, work: 0 };
    if (cityMismatch(profile, job)) return { score: 0, veto: true, title: 0, skill: 0, work: 0 };
    const hay = jobHaystack(job);
    const title = titleScore(profile.titles, job.name);
    const skill = overlapHits(profile.skills, hay, 3);
    const work = overlapHits(profile.workKeywords, hay, 2);
    const score = Math.round(title * 0.50 + skill * 0.20 + work * 0.30);
    return { score, veto: false, title, skill, work };
  }

  function scoreJd(job, profile) {
    const hay = jobHaystack(job);
    const title = titleScore(profile.titles, job.name);
    const skill = overlapHits(profile.skills, hay, 3);
    const work = overlapHits(profile.workKeywords, hay, 3);
    const score = Math.round(title * 0.40 + skill * 0.20 + work * 0.40);
    return { score, title, skill, work };
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
      jdText: '',
      tags: [].concat(j.jobLabels || j.labels || []).map(x => typeof x === 'string' ? x : (x && x.name) || '').filter(Boolean),
      goldHunter: !!j.goldHunter,
      friend: !!(j.friend || j.contact),
      applied: !!(j.friend),
      score: 0,
    };
  }

  async function searchJobs(tabId, profile, log) {
    const queries = profile.titles.slice(0, 3);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (params) => {
        const jobs = [];
        const seen = new Set();
        const diag = [];
        for (const query of params.queries) {
          for (let page = 1; page <= params.pages; page++) {
            const apiUrl = '/wapi/zpgeek/search/joblist.json?site=1&query=' + encodeURIComponent(query)
              + '&city=' + encodeURIComponent(params.cityCode || params.city || '')
              + '&page=' + page + '&pageSize=30&experience=&degree=&industry=&scale=&stage=&position=';
            try {
              const apiRes = await fetch(apiUrl);
              const json = await apiRes.json();
              const jl = (json.zpData && (json.zpData.jobList || json.zpData.list)) || [];
              diag.push(query + ' p' + page + ' code=' + json.code + ' n=' + jl.length);
              if (json.code !== 0) {
                const msg = JSON.stringify(json).slice(0, 200);
                if (/请稍候|captcha|hasCaptcha|验证码|极验/i.test(msg)) {
                  return { jobs, diag, stop: true, stopMsg: msg };
                }
              }
              for (const j of jl) jobs.push(j);
            } catch (e) {
              diag.push(query + ' p' + page + ' err=' + e.message);
            }
          }
        }
        return { jobs, diag, stop: false };
      },
      args: [{ queries, city: profile.city, cityCode: profile.cityCode, pages: SEARCH_PAGES }],
    });
    const raw = (res && res[0] && res[0].result) || { jobs: [], diag: [] };
    if (raw.diag && raw.diag.length) log('搜索: ' + raw.diag.join(' | '));
    if (raw.stop) throw new Error('搜索触发风控，已停止。' + (raw.stopMsg || ''));
    const mapped = [];
    const seen = new Set();
    for (const j of raw.jobs || []) {
      const job = mapApiJob(j);
      if (!job.encryptId || seen.has(job.encryptId)) continue;
      seen.add(job.encryptId);
      mapped.push(job);
    }
    return mapped;
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

  async function run({ tabId, log }) {
    const loaded = await loadResume();
    log('简历文件: ' + loaded.file);
    const profile = extractProfile(loaded.text);
    log('画像 职位=' + profile.titles.join('/') + ' 城市=' + (profile.city || '未识别')
      + ' 技能=' + profile.skills.slice(0, 8).join(',') + ' 工作词=' + profile.workKeywords.slice(0, 8).join(','));

    const listed = await searchJobs(tabId, profile, log);
    log('搜索到 ' + listed.length + ' 条，开始列表粗筛');

    const passed = [];
    const samples = [];
    const excludeCounts = {};
    for (const job of listed) {
      const s = scoreList(job, profile);
      job.score = s.score;
      job.scoreDetail = s;
      bumpWhy(excludeCounts, s.why);
      if (samples.length < 5) {
        samples.push((job.name || '(无标题)') + ' ' + s.score
          + '(职位' + s.title + '/技能' + s.skill + '/工作' + s.work
          + (s.why ? '/' + whyLabel(s.why) : (s.veto ? '/否决' : '')) + ')');
      }
      if (!s.veto && s.score >= LIST_THRESHOLD) passed.push(job);
    }
    passed.sort((a, b) => b.score - a.score);
    if (samples.length) log('粗筛样例: ' + samples.join(' | '));
    logExcludes(log, excludeCounts);
    log('粗筛留下 ' + passed.length + ' 条（阈值 ' + LIST_THRESHOLD + '），对前 ' + Math.min(REFINE_MAX, passed.length) + ' 条并发精排（' + REFINE_CONCURRENCY + ' 路）');

    if (!passed.length) return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };

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
      jobs, profile, stopped: refined.stopped, fallback, listCount: passed.length,
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

  async function searchZhaopinJobs(tabId, profile, log) {
    const queries = profile.titles.slice(0, 4);
    const cityId = ZHAOPIN_CITY[profile.city] || '';
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
        const postSearch = async (query, page) => {
          const body = {
            S_SOU_FULL_INDEX: query,
            pageIndex: page,
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
        const scrapeDom = () => {
          const out = [];
          const seen = new Set();
          const push = (id, name, company, href) => {
            if (!id || seen.has(id)) return;
            seen.add(id);
            out.push({ number: id, jobName: name, companyName: company, positionURL: href });
          };
          for (const card of document.querySelectorAll('.joblist-box__item, [class*="joblist"] [class*="item"]')) {
            const link = card.querySelector('a[href*="jobdetail"], a[href*="/job/"]');
            if (!link) continue;
            const href = link.href || '';
            const id = (href.match(/jobdetail\/([a-zA-Z0-9]+)/i) || href.match(/\/jobs?\/([a-zA-Z0-9]+)/i) || [])[1] || '';
            const nameEl = card.querySelector('[class*="job-name"], [class*="jobName"], [class*="title"], h3, .jobname');
            const coEl = card.querySelector('[class*="company"], [class*="corp"]');
            push(id, (nameEl && nameEl.textContent) || link.textContent || '', (coEl && coEl.textContent) || '', href);
          }
          if (!out.length) {
            for (const a of document.querySelectorAll('a[href*="jobdetail"]')) {
              const href = a.href || '';
              const id = (href.match(/jobdetail\/([a-zA-Z0-9]+)/i) || [])[1] || '';
              push(id, (a.textContent || '').trim(), '', href);
            }
          }
          return out;
        };
        for (const query of params.queries) {
          for (let page = 1; page <= params.pages; page++) {
            try {
              const r = await postSearch(query, page);
              if (r.html) {
                diag.push(query + ' p' + page + ' search/positions html');
              } else {
                diag.push(query + ' p' + page + ' positions code=' + (r.code || '?') + ' n=' + r.n
                  + (r.verify ? ' verify=' + r.verify : ''));
                for (const j of r.list || []) jobs.push(j);
              }
            } catch (e) {
              diag.push(query + ' p' + page + ' err=' + e.message);
            }
          }
        }
        if (!jobs.length) {
          const dom = scrapeDom();
          if (dom.length) {
            diag.push('dom n=' + dom.length);
            for (const j of dom) jobs.push(j);
          }
        }
        return { jobs, diag };
      },
      args: [{ queries, cityId, pages: SEARCH_PAGES }],
    });
    const raw = (res && res[0] && res[0].result) || { jobs: [], diag: [] };
    if (raw.diag && raw.diag.length) log('智联搜索: ' + raw.diag.join(' | '));
    let mapped = collectMappedZp(raw.jobs);
    if (mapped.length) return mapped;

    log('接口无职位，改为打开搜索页抓列表');
    for (const query of queries) {
      const pathKw = encodeURIComponent(query).replace(/%20/g, '');
      const url = 'https://www.zhaopin.com/sou/jl' + (cityId || '538') + '/kw' + pathKw + '/p1';
      try {
        await chrome.tabs.update(tabId, { url });
        await waitTabComplete(tabId, 15000);
        await sleep(2500);
        const pageRes = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const out = [];
            const seen = new Set();
            const add = (id, name, company, href) => {
              if (!id || seen.has(id)) return;
              seen.add(id);
              out.push({ number: id, jobName: (name || '').trim(), companyName: (company || '').trim(), positionURL: href });
            };
            for (const a of document.querySelectorAll('a[href*="jobdetail"]')) {
              const href = a.href || '';
              const id = (href.match(/jobdetail\/([a-zA-Z0-9]+)/i) || [])[1] || '';
              const card = a.closest('.joblist-box__item, li, article, [class*="job"]') || a;
              const nameEl = card.querySelector('[class*="job-name"], [class*="jobName"], [class*="title"], h3');
              const coEl = card.querySelector('[class*="company"], [class*="corp"]');
              add(id, (nameEl && nameEl.textContent) || a.textContent || '', (coEl && coEl.textContent) || '', href);
            }
            return { n: out.length, jobs: out, hrefCount: document.querySelectorAll('a[href*="jobdetail"]').length };
          },
        });
        const pageRaw = (pageRes && pageRes[0] && pageRes[0].result) || { n: 0, jobs: [] };
        log('搜索页 ' + query + ' n=' + pageRaw.n + ' links=' + (pageRaw.hrefCount || 0));
        mapped = mapped.concat(collectMappedZp(pageRaw.jobs));
      } catch (e) {
        log('打开搜索页失败 ' + query + ' ' + (e.message || e));
      }
    }
    const seen = new Set();
    return mapped.filter(j => { if (seen.has(j.jobId)) return false; seen.add(j.jobId); return true; });
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

  async function runZhaopin({ tabId, log }) {
    const loaded = await loadResume();
    log('简历文件: ' + loaded.file);
    const profile = extractProfile(loaded.text);
    log('画像 职位=' + profile.titles.join('/') + ' 城市=' + (profile.city || '未识别')
      + ' 技能=' + profile.skills.slice(0, 8).join(',') + ' 工作词=' + profile.workKeywords.slice(0, 8).join(','));

    const listed = await searchZhaopinJobs(tabId, profile, log);
    if (!listed.length) {
      log('智联搜索接口和搜索页都没有职位。请确认当前标签页已登录智联，并重新加载扩展后再试。');
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    log('智联搜索到 ' + listed.length + ' 条，开始粗筛');

    const passed = [];
    const samples = [];
    const excludeCounts = {};
    for (const job of listed) {
      const s = scoreList(job, profile);
      job.score = s.score;
      job.scoreDetail = s;
      bumpWhy(excludeCounts, s.why);
      if (samples.length < 5) {
        samples.push((job.name || '(无标题)') + ' ' + s.score
          + (job.company ? '|' + job.company : '')
          + (s.why ? '/' + whyLabel(s.why) : (s.veto ? '/否决' : '')));
      }
      if (!s.veto && s.score >= LIST_THRESHOLD) passed.push(job);
    }
    passed.sort((a, b) => b.score - a.score);
    if (samples.length) log('粗筛样例: ' + samples.join(' | '));
    logExcludes(log, excludeCounts);
    log('粗筛留下 ' + passed.length + ' 条，对前 ' + Math.min(REFINE_MAX, passed.length) + ' 条并发精排（' + REFINE_CONCURRENCY + ' 路后台标签）');
    if (!passed.length) {
      log('智联匹配结果为 0 条。看样例：可能被校招/不可选中/派遣规则排除，或未过阈值 ' + LIST_THRESHOLD + '。');
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
      jobs, profile, stopped: refined.stopped, fallback, listCount: passed.length,
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
        if (cards.length) {
          const apiUrl = 'https://we.51job.com/api/job/search-pc?api_key=51job'
            + '&timestamp=' + Date.now()
            + '&keyword=' + encodeURIComponent(keyword)
            + '&searchType=2&jobArea=' + encodeURIComponent(jobArea)
            + '&sortType=0&pageNum=1&pageSize=30&source=1&accountId=&scene=7';
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
    const loaded = await loadResume();
    log('简历文件: ' + loaded.file);
    const profile = extractProfile(loaded.text);
    log('画像 职位=' + profile.titles.join('/') + ' 城市=' + (profile.city || '未识别')
      + ' 技能=' + profile.skills.slice(0, 8).join(',') + ' 工作词=' + profile.workKeywords.slice(0, 8).join(','));

    await saveW51SearchCtx(profile);
    let tabUrl = '';
    try { tabUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    try {
      await chrome.storage.local.set({ w51_match_tab: tabId, w51_search_url: tabUrl });
    } catch (_) {}
    log('按当前页列表匹配；投递在后台标签进行，不影响本页');
    if (!tabUrl.includes('we.51job.com')) {
      log('请先打开 we.51job.com 搜索页并手动搜出结果');
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    await waitW51ListDom(tabId, log, 12000);
    const listed = await scrape51JobsFromDom(tabId, log);
    if (!listed.length) {
      log('当前页列表为 0。请在前程搜索页手动搜索（如「测试工程师」+ 上海），看到职位后再点匹配。');
      return { jobs: [], profile, stopped: false, fallback: false, listCount: 0 };
    }
    log('本页 ' + listed.length + ' 条，开始粗筛');

    const passed = [];
    const samples = [];
    const excludeCounts = {};
    for (const job of listed) {
      const s = scoreList(job, profile);
      job.score = s.score;
      job.scoreDetail = s;
      bumpWhy(excludeCounts, s.why);
      if (samples.length < 5) {
        samples.push((job.name || '(无标题)') + ' ' + s.score
          + (job.company ? '|' + job.company : '')
          + (s.why ? '/' + whyLabel(s.why) : (s.veto ? '/否决' : '')));
      }
      if (!s.veto && s.score >= LIST_THRESHOLD) passed.push(job);
    }
    passed.sort((a, b) => b.score - a.score);
    if (samples.length) log('粗筛样例: ' + samples.join(' | '));
    logExcludes(log, excludeCounts);
    log('粗筛留下 ' + passed.length + ' 条，对前 ' + Math.min(REFINE_MAX, passed.length) + ' 条精排');
    if (!passed.length) {
      log('前程匹配结果为 0 条。看样例：可能被校招/不可选中/派遣规则排除，或未过阈值 ' + LIST_THRESHOLD + '。');
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
    return {
      jobs, profile, stopped: refined.stopped, fallback, listCount: passed.length,
      refineTotal: refineTop.length, refinePassed: fallback ? 0 : jobs.length,
    };
  }

  return { loadResume, extractProfile, run, runZhaopin, run51job, LIST_THRESHOLD, REFINE_MAX };
})();
