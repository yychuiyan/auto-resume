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

  function profileFromParsed(parsed) {
    const titles = [].concat(parsed.titles || parsed.title || []).map(x => String(x || '').trim()).filter(Boolean);
    const skills = [].concat(parsed.skills || []).map(x => String(x || '').trim()).filter(Boolean);
    const workKeywords = [].concat(parsed.workKeywords || parsed.work || []).map(x => String(x || '').trim()).filter(Boolean);
    const city = String(parsed.city || '').replace(/市$/, '').trim();
    if (!titles.length) throw new Error('AI 未解析出期望职位');
    return { titles, city, skills, workKeywords };
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
        content: '你是简历解析器。先在思考过程里归纳简历要点，最终只输出一个紧凑 JSON 对象，不要 markdown，不要解释。字段：titles(字符串数组,3到5个求职职位近义名)、city(单个城市名,不要“市”字)、skills(技能数组,最多15个)、workKeywords(工作内容关键词数组,8到15个)。不要编造简历没有的技能。',
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
      fileName: (extra && extra.fileName) || prev.fileName || '',
      parsedAt: Date.now(),
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
