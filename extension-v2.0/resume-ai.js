// resume-ai.js — Word 抽正文 + DeepSeek 解析画像
window.ResumeAI = (() => {
  const DEFAULT_BASE = 'https://api.deepseek.com';
  const DEFAULT_MODEL = 'deepseek-v4-flash';
  const MAX_DOCX_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT = 16000;

  function readU16(u, o) { return u[o] | (u[o + 1] << 8); }
  function readU32(u, o) {
    return (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持解压 Word，请升级 Chrome');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function zipReadFile(buf, wantName) {
    const u = new Uint8Array(buf);
    let eocd = -1;
    const min = Math.max(0, u.length - 65557);
    for (let i = u.length - 22; i >= min; i--) {
      if (u[i] === 0x50 && u[i + 1] === 0x4b && u[i + 2] === 0x05 && u[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 .docx（请用 Word 另存为 docx）');
    let p = readU32(u, eocd + 16);
    const cdEnd = p + readU32(u, eocd + 12);
    while (p <= cdEnd - 46) {
      if (readU32(u, p) !== 0x02014b50) break;
      const method = readU16(u, p + 10);
      const compSize = readU32(u, p + 20);
      const nameLen = readU16(u, p + 28);
      const extraLen = readU16(u, p + 30);
      const commentLen = readU16(u, p + 32);
      const localOff = readU32(u, p + 42);
      const fname = new TextDecoder('utf-8').decode(u.subarray(p + 46, p + 46 + nameLen));
      if (fname === wantName) {
        const fnLen = readU16(u, localOff + 26);
        const exLen = readU16(u, localOff + 28);
        const dataStart = localOff + 30 + fnLen + exLen;
        const data = u.subarray(dataStart, dataStart + compSize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error('不支持的 Word 压缩方式: ' + method);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('Word 里没有找到正文');
  }

  function decodeXml(s) {
    return String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function documentXmlToText(xml) {
    const lines = [];
    const paras = String(xml || '').split(/<\/w:p>/i);
    for (const para of paras) {
      const parts = [];
      const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gi;
      let m;
      while ((m = re.exec(para))) parts.push(decodeXml(m[1]));
      const line = parts.join('').replace(/\s+/g, ' ').trim();
      if (line) lines.push(line);
    }
    return lines.join('\n').trim();
  }

  function isDocxFile(file) {
    const name = String(file && file.name || '').toLowerCase();
    const type = String(file && file.type || '');
    if (name.endsWith('.doc') && !name.endsWith('.docx')) return false;
    return name.endsWith('.docx')
      || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  async function extractDocxText(file) {
    if (!file) throw new Error('请选择 Word 文件');
    if (!isDocxFile(file)) throw new Error('只支持 .docx，旧版 .doc 请先另存为 docx');
    if (file.size <= 0) throw new Error('文件是空的');
    if (file.size > MAX_DOCX_BYTES) throw new Error('文件超过 8MB，请压缩后再传');
    const buf = await file.arrayBuffer();
    const xmlBytes = await zipReadFile(buf, 'word/document.xml');
    const xml = new TextDecoder('utf-8').decode(xmlBytes);
    const text = documentXmlToText(xml);
    if (!text || text.length < 40) throw new Error('未能从 Word 抽出足够正文');
    return text.slice(0, MAX_TEXT);
  }

  function mapModel(model) {
    const m = String(model || '').trim();
    if (!m || m === 'deepseek-chat') return DEFAULT_MODEL;
    if (m === 'deepseek-reasoner') return 'deepseek-v4-pro';
    return m;
  }

  function completionsUrl(baseUrl) {
    const b = String(baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
    if (!b) throw new Error('API 地址不能为空');
    if (!/^https:\/\//i.test(b)) throw new Error('API 地址必须是 https');
    if (/\/chat\/completions$/i.test(b)) return b;
    if (/\/v1$/i.test(b)) return b + '/chat/completions';
    return b + '/chat/completions';
  }

  function altCompletionsUrl(url) {
    const u = String(url || '');
    if (/\/v1\/chat\/completions$/i.test(u)) return u.replace(/\/v1\/chat\/completions$/i, '/chat/completions');
    if (/\/chat\/completions$/i.test(u) && !/\/v1\/chat\/completions$/i.test(u)) {
      return u.replace(/\/chat\/completions$/i, '/v1/chat/completions');
    }
    return '';
  }

  function parseJsonObject(raw) {
    const s = String(raw || '').trim();
    if (!s) throw new Error('模型返回为空，请再点一次「解析」');
    let payload = s;
    if (s.charAt(0) !== '{') {
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('模型未返回 JSON，请再点一次「解析」');
      payload = m[0];
    }
    try {
      return JSON.parse(payload);
    } catch (_) {
      throw new Error('模型返回的 JSON 不完整，请再点一次「解析」');
    }
  }

  // 方向关键词过滤：泛词对区分方向没有任何信息量，
  // 留着会让「座舱自动化测试工程师」被判成「自动化测试」。AI 偶尔仍会吐出来，这里兜一层。
  const GENERIC_KEYWORDS = new Set([
    '工程师', '测试', '开发', '设计', '经理', '主管', '专员', '助理', '专家',
    '产品', '运营', '项目', '高级', '资深', '中级', '初级', '首席', '实习', '全职',
    '工作', '岗位', '职位', '技术', '业务', '相关', '经验',
  ]);

  function cleanKeywords(list) {
    const out = [];
    for (const raw of [].concat(list || [])) {
      const w = String(raw || '').trim();
      if (!w || w.length > 20) continue;
      if (GENERIC_KEYWORDS.has(w)) continue;
      if (out.some(x => x.toLowerCase() === w.toLowerCase())) continue;
      if (out.length >= 14) break;
      out.push(w);
    }
    return out;
  }

  // 名字 → 关键词数组，去掉泛词与空项
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

  // AI 的方向输出兼容三种形状：
  //   [{name, keywords}]  /  ['名字']  /  {名字: ['词']}
  // 统一成 { names: [...], keywords: { 名字: [...] } }
  function readDirections(raw) {
    const names = [];
    const keywords = {};
    const push = (name, words) => {
      const n = String(name || '').trim().slice(0, 12);
      if (!n || n === '__all__') return;
      if (names.some(x => x.toLowerCase() === n.toLowerCase())) return;
      if (names.length >= 8) return;
      names.push(n);
      keywords[n] = cleanKeywords(words);
    };
    if (!raw) return { names, keywords };
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item == null) continue;
        if (typeof item === 'string') push(item, [item]);
        else if (typeof item === 'object') {
          push(item.name || item.title || '', item.keywords || item.words || item.synonyms || [item.name || item.title]);
        }
      }
      return { names, keywords };
    }
    if (typeof raw === 'object') {
      for (const k of Object.keys(raw)) push(k, raw[k]);
    }
    return { names, keywords };
  }

  function profileFromParsed(parsed) {
    const titles = [].concat(parsed.titles || parsed.title || []).map(x => String(x || '').trim()).filter(Boolean);
    const skills = [].concat(parsed.skills || []).map(x => String(x || '').trim()).filter(Boolean);
    const workKeywords = [].concat(parsed.workKeywords || parsed.work || []).map(x => String(x || '').trim()).filter(Boolean);
    const city = String(parsed.city || '').replace(/市$/, '').trim();
    if (!titles.length) throw new Error('AI 未解析出期望职位');
    const dir = readDirections(parsed.directions);
    const other = readDirections(parsed.otherDirections);
    const hasDirs = parsed.directions !== undefined;
    return {
      titles, city, skills, workKeywords,
      directions: hasDirs ? dir.names : undefined,
      directionOptions: hasDirs ? dir.names.slice() : undefined,
      // 重新解析时以这次结果为准：这次没给关键词就清空，别让上一次的旧词残留
      directionKeywords: hasDirs ? dir.keywords : undefined,
      otherDirections: parsed.otherDirections === undefined ? undefined : other.keywords,
    };
  }

  function deltaThinking(delta) {
    if (!delta) return '';
    return String(delta.reasoning_content || delta.reasoning || delta.thinking || '');
  }

  function applySseJson(json, acc, onProgress) {
    const choice = json && json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) acc.finish = choice.finish_reason;
    const delta = choice.delta || {};
    const msg = choice.message || {};
    const r = deltaThinking(delta) || deltaThinking(msg);
    const c = (delta.content != null ? delta.content : msg.content);
    if (r) acc.thinking += r;
    if (c) acc.content += String(c);
    if ((r || c) && typeof onProgress === 'function') onProgress({ thinking: acc.thinking, content: acc.content });
  }

  async function readChatStream(res, onProgress) {
    const acc = { thinking: '', content: '', finish: '' };
    if (!res.body || !res.body.getReader) {
      const raw = await res.text();
      return parseSseOrJson(raw, acc, onProgress);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json = null;
        try { json = JSON.parse(data); } catch (_) { continue; }
        applySseJson(json, acc, onProgress);
      }
    }
    if (buf.trim()) {
      const t = buf.trim();
      if (t.startsWith('data:')) {
        const data = t.slice(5).trim();
        if (data && data !== '[DONE]') {
          try { applySseJson(JSON.parse(data), acc, onProgress); } catch (_) {}
        }
      }
    }
    return acc;
  }

  function parseSseOrJson(raw, acc, onProgress) {
    const s = String(raw || '');
    if (s.includes('data:')) {
      const lines = s.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json = null;
        try { json = JSON.parse(data); } catch (_) { continue; }
        applySseJson(json, acc, onProgress);
      }
      return acc;
    }
    try {
      const json = JSON.parse(s);
      const choice = json.choices && json.choices[0];
      const msg = (choice && choice.message) || {};
      acc.thinking = String(msg.reasoning_content || msg.reasoning || '');
      acc.content = String(msg.content || '');
      acc.finish = (choice && choice.finish_reason) || '';
      if (typeof onProgress === 'function') onProgress({ thinking: acc.thinking, content: acc.content });
      return acc;
    } catch (_) {
      throw new Error('DeepSeek 返回无法解析');
    }
  }

  async function parseResumeText(text, cfg, onProgress) {
    const apiKey = String(cfg && cfg.apiKey || '').trim();
    if (apiKey.length < 8) throw new Error('请先在设置里填写 DeepSeek API Key');
    if (!String(text || '').trim()) throw new Error('请先上传 Word 简历');
    const model = mapModel(cfg && cfg.model);
    const messages = [
      {
        role: 'system',
        content: '你是简历解析器。先在思考过程里归纳简历要点，最终只输出一个紧凑 JSON 对象，不要 markdown，不要解释。'
          + '字段：titles(字符串数组,3到5个求职职位近义名)、city(单个城市名,不要“市”字)、'
          + 'skills(技能数组,最多15个)、workKeywords(工作内容关键词数组,8到15个)、'
          + 'directions(数组,2到6项)、otherDirections(对象)。'
          + 'directions 的每一项是 {"name":"方向名","keywords":["关键词"]}：'
          + 'name 要从这份简历里归纳出他真正在做的岗位方向，2到8字，用该行业最通行的叫法（例如 交互设计、用户研究、软件测试、自动化测试、后端、数据分析、财务会计、新媒体运营），'
          + '不局限于互联网技术岗，任何职业都可以；'
          + 'keywords 给4到10个这个词方向专属的检索词，包含岗位标题里常见的同义说法与中英写法（例如 交互设计 → 交互设计、UX、用户体验、原型、Axure、信息架构）。'
          + 'keywords 严禁使用 工程师、测试、开发、设计、产品、运营、经理、专员、高级、资深、自动化、相关、经验 这类没有区分度的泛词，'
          + '否则同族方向会互相抢；要能靠这些词把本方向与相邻方向区分开。'
          + 'otherDirections 是对象 {"相邻方向名":["关键词"]}，给5到8个与本简历同领域、但这份简历并不符合的方向及其专属词，'
          + '用来在匹配时把这类岗位排除掉；它的关键词规则与 directions 相同。'
          + 'otherDirections 要优先列出「最容易被本简历方向的词吞并、但其实是另一行」的那些岗位族，'
          + '并把它们的行话写进关键词（例如做软件测试的简历，要给出 硬件测试/汽车电子测试，'
          + '关键词含 座舱、车载、台架、HIL、CAN、BMS、GTS、示波器、PCB 这类；'
          + '做交互设计的简历，要给出 视觉设计、产品经理、平面设计）。'
          + '按简历实际情况归纳，不要编造简历里没有的技能。',
      },
      {
        role: 'user',
        content: '解析这份简历：\n' + String(text || '').slice(0, MAX_TEXT),
      },
    ];
    const urls = [];
    const first = completionsUrl(cfg && cfg.baseUrl);
    urls.push(first);
    const alt = altCompletionsUrl(first);
    if (alt && alt !== first) urls.push(alt);

    const bodies = [
      {
        model,
        temperature: 0.2,
        max_tokens: 16384,
        stream: true,
        response_format: { type: 'json_object' },
        thinking: { type: 'enabled' },
        messages,
      },
      {
        model,
        temperature: 0.2,
        max_tokens: 16384,
        stream: true,
        response_format: { type: 'json_object' },
        messages,
      },
    ];

    let lastErr = '';
    for (const url of urls) {
      for (const body of bodies) {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + apiKey,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const raw = await res.text();
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          if (json) {
            const msg = (json.error && json.error.message) || json.message || ('HTTP ' + res.status);
            lastErr = String(msg).slice(0, 180);
            if (res.status === 400 && body.thinking) continue;
            if (res.status !== 404) throw new Error(lastErr);
            break;
          }
          lastErr = 'DeepSeek 返回非 JSON（HTTP ' + res.status + '，' + url + '）。请把 API 地址设为 https://api.deepseek.com ，模型用 ' + DEFAULT_MODEL;
          if (res.status !== 404) throw new Error(lastErr);
          break;
        }
        const acc = await readChatStream(res, onProgress);
        try {
          return profileFromParsed(parseJsonObject(acc.content));
        } catch (e) {
          if (acc.finish === 'length') throw new Error('模型输出被截断，请再点一次「解析」');
          throw e;
        }
      }
    }
    throw new Error(lastErr || 'DeepSeek 请求失败');
  }

  async function loadConfig() {
    const s = await chrome.storage.local.get('ai_api');
    const c = s.ai_api || {};
    return {
      baseUrl: String(c.baseUrl || DEFAULT_BASE),
      model: mapModel(c.model || DEFAULT_MODEL),
      apiKey: String(c.apiKey || ''),
    };
  }

  async function saveConfig(cfg) {
    const baseUrl = String(cfg.baseUrl || DEFAULT_BASE).trim() || DEFAULT_BASE;
    const model = mapModel(String(cfg.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL);
    const apiKey = String(cfg.apiKey || '').trim();
    if (baseUrl && !/^https:\/\//i.test(baseUrl)) throw new Error('API 地址必须是 https');
    await chrome.storage.local.set({ ai_api: { baseUrl, model, apiKey } });
    return { baseUrl, model, apiKey };
  }

  async function loadProfile() {
    const s = await chrome.storage.local.get('ai_profile');
    return s.ai_profile || null;
  }

  async function saveProfile(profile, extra) {
    const prev = (await chrome.storage.local.get('ai_profile')).ai_profile || {};
    const dirs = profile.directions !== undefined
      ? (Array.isArray(profile.directions) ? profile.directions : [])
      : (prev.directions || []);
    // 候选方向以这次的结果为准：重新解析后，简历没解析到的方向不再保留
    let dirOpts;
    if (profile.directionOptions !== undefined) {
      dirOpts = Array.isArray(profile.directionOptions) ? profile.directionOptions.slice() : [];
    } else if (profile.directions !== undefined) {
      dirOpts = Array.isArray(profile.directions) ? profile.directions.slice() : [];
    } else {
      dirOpts = Array.isArray(prev.directionOptions) ? prev.directionOptions : [];
    }
    // 重新解析时 AI 会给整套新关键词，要以新结果为准；
    // 只是改匹配规则时（没带 keywords）沿用旧的，别把用户手改的词冲掉
    const reParsed = profile.directionKeywords !== undefined;
    const dirKeywords = reParsed
      ? cleanKeywordMap(profile.directionKeywords)
      : (prev.directionKeywords && typeof prev.directionKeywords === 'object' ? prev.directionKeywords : {});
    // 相邻干扰方向只在「重新解析」时由 AI 给出；没给就等于这次没有，
    // 不能沿用上一份简历的旧方向，否则换行业后会被它误杀
    const otherDirections = profile.otherDirections !== undefined
      ? cleanKeywordMap(profile.otherDirections)
      : {};
    const data = {
      titles: profile.titles,
      city: profile.city || '',
      skills: profile.skills || [],
      workKeywords: profile.workKeywords || [],
      salaryMin: profile.salaryMin != null ? Number(profile.salaryMin) || 0 : (prev.salaryMin || 0),
      scaleMin: profile.scaleMin != null ? Number(profile.scaleMin) || 0 : (prev.scaleMin || 0),
      degrees: profile.degrees !== undefined
        ? (Array.isArray(profile.degrees) ? profile.degrees : [])
        : (prev.degrees || []),
      directions: dirs,
      directionOptions: dirOpts,
      directionKeywords: dirKeywords,
      otherDirections,
      fileName: (extra && extra.fileName) || prev.fileName || '',
      // 只改匹配规则时沿用上次解析时间，别让侧边栏显示成「刚解析过」
      parsedAt: (extra && extra.keepParsedAt && prev.parsedAt) ? prev.parsedAt : Date.now(),
    };
    await chrome.storage.local.set({ ai_profile: data });
    return data;
  }

  async function saveResumeText(text) {
    await chrome.storage.local.set({ ai_resume_text: String(text || '').slice(0, MAX_TEXT) });
  }

  async function saveResumeUpload(text, fileName) {
    await chrome.storage.local.set({
      ai_resume_text: String(text || '').slice(0, MAX_TEXT),
      ai_resume_file: { fileName: String(fileName || ''), uploadedAt: Date.now() },
    });
    await chrome.storage.local.remove('ai_profile');
  }

  async function loadResumeUpload() {
    const s = await chrome.storage.local.get(['ai_resume_text', 'ai_resume_file']);
    const file = s.ai_resume_file || {};
    return {
      text: String(s.ai_resume_text || ''),
      fileName: String(file.fileName || ''),
    };
  }

  async function clearResume() {
    await chrome.storage.local.remove(['ai_profile', 'ai_resume_text', 'ai_resume_file']);
  }

  return {
    DEFAULT_BASE, DEFAULT_MODEL,
    extractDocxText, parseResumeText,
    loadConfig, saveConfig, loadProfile, saveProfile,
    saveResumeText, saveResumeUpload, loadResumeUpload, clearResume,
  };
})();
