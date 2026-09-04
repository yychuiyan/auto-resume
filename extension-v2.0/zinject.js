// zinject.js — 智联招聘投递调用（页面主环境，Cookie 自动带）
(async () => {
  const divs = document.querySelectorAll('[id^="__zl_data_"]');
  const div = divs[divs.length - 1];
  if (!div) return;
  const cmd = JSON.parse(div.getAttribute('data-cmd'));

  const parseRootOrgId = (jobNumber) => {
    const s = String(jobNumber || '');
    const m0 = s.match(/^CC(\d+)0J/i);
    if (m0) return Number(m0[1]) || 0;
    const m1 = s.match(/^CC(\d+)J/i);
    if (m1) return Number(m1[1]) || 0;
    return 0;
  };

  const loadJobMeta = async (jobNumber, rootOrgId, staffId) => {
    let org = Number(rootOrgId) || parseRootOrgId(jobNumber);
    let staff = Number(staffId) || 0;
    if (staff && org) return { rootOrgId: org, staffId: staff };
    try {
      const html = await fetch('https://www.zhaopin.com/jobdetail/' + encodeURIComponent(jobNumber) + '.htm', {
        credentials: 'include',
      }).then((r) => r.text());
      const sm = html.match(/"staffId"\s*:\s*(\d+)/);
      if (sm && !staff) staff = parseInt(sm[1], 10);
      const om = html.match(/"rootOrgId"\s*:\s*(\d+)/) || html.match(/"companyRootId"\s*:\s*(\d+)/);
      if (om && !org) org = parseInt(om[1], 10);
      const blocks = html.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/)
        || html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\//);
      if (blocks) {
        const walk = (obj, depth) => {
          if (!obj || depth > 8) return;
          if (Array.isArray(obj)) { obj.slice(0, 40).forEach((x) => walk(x, depth + 1)); return; }
          if (typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === 'number') {
              if (!staff && /staffid|hrid|publisherid/.test(k.toLowerCase()) && v > 1000) staff = v;
              if (!org && /rootorgid|companyrootid/.test(k.toLowerCase()) && v > 0) org = v;
            }
            walk(v, depth + 1);
          }
        };
        try { walk(JSON.parse(blocks[1]), 0); } catch (_) {}
      }
    } catch (_) {}
    return { rootOrgId: org || 0, staffId: staff || 0 };
  };

  try {
    const at = cmd.at || '';
    const rt = cmd.rt || '';
    const resumeNumber = cmd.resumeNumber || '';
    const cityIds = cmd.cityIds || ['538'];
    const jobNumber = cmd.jobNumber || '';
    const actionId = cmd.actionId || '';

    if (!at || !rt || !resumeNumber || !jobNumber) {
      window.postMessage({ __zl: true, id: cmd.id, ok: false,
        msg: '缺少参数: at=' + !!at + ' rt=' + !!rt + ' resume=' + !!resumeNumber + ' job=' + !!jobNumber,
      }, '*');
      return;
    }

    const meta = await loadJobMeta(jobNumber, cmd.rootOrgId, cmd.staffId);
    const tokenQS = 'at=' + at + '&rt=' + rt + '&_v=' + Math.random();
    const ct = { 'Content-Type': 'application/json' };

    // preparation：与页面抓包一致，不带 jobNumbers
    const prepBody = JSON.stringify({
      at, rt, jobCount: 1,
      rootOrgId: meta.rootOrgId,
      staffId: meta.staffId,
      isShowAttachmentSelect: true,
      actionId,
    });
    const r1 = await fetch('https://fe-api.zhaopin.com/c/pc/alan/jobs/application/preparation?' + tokenQS, {
      method: 'POST', credentials: 'include', headers: { ...ct }, body: prepBody,
    });
    const d1 = await r1.json();
    const p1 = d1.data || {};

    if (p1.loggedIn === false) {
      window.postMessage({ __zl: true, id: cmd.id, ok: false,
        msg: '智联登录失效（preparation: ' + (d1.message || '') + '），请重新登录后再投',
      }, '*');
      return;
    }

    const attachInfo = p1.attachmentResumeInfo || {};
    const defResume = p1.defaultResume || {};
    const attachFileId = attachInfo.defaultAttachmentPath || attachInfo.defaultResumePath || '';
    const prepResume = defResume.number || defResume.resumeNumber
      || (Array.isArray(p1.resumes) && p1.resumes.length && (p1.resumes[0].number || p1.resumes[0].resumeNumber))
      || '';
    const language = p1.defaultResumeLanguage || 1;

    try {
      await fetch('https://cgate.zhaopin.com/resumeapi/searchv2/judgeJobWorkerCollar?' + tokenQS, {
        method: 'POST', credentials: 'include', headers: { ...ct },
        body: JSON.stringify({ jobType: '20000100010000', platform: 13, version: '0.0.0' }),
      });
    } catch (_) {}

    try {
      await fetch('https://cgate.zhaopin.com/bdp/interceptService/intercept?' + tokenQS, {
        method: 'POST', credentials: 'include', headers: { ...ct },
        body: JSON.stringify({ jobNumber, feature: 1, scene: 1, action: 0, platform: 13, version: '0.0.0' }),
      });
    } catch (_) {}

    const useResume = prepResume || resumeNumber;
    const applyBody = {
      jobNumbers: [jobNumber],
      cityIds,
      resumeNumber: useResume,
      at, rt,
      language,
      batched: false,
      inviteCode: '',
      ignoreIntention: 1,
      ignoreBlackType: '',
      deliveryChannelType: 1,
      extraApplyParams: {},
      actionId,
      businessSystem: '1',
      stSourceCode: 0,
      businessPlatformSub: 0,
      businessTagId: '',
      businessPlatformLabel: 0,
      pageCode: 4089,
      jobSource: 'SEARCH',
    };
    if (attachFileId) {
      applyBody.attachmentDefaultType = attachInfo.defaultResumeType || 'attachment';
      applyBody.attachmentDefaultFileId = attachFileId;
    }

    const r3 = await fetch('https://fe-api.zhaopin.com/c/pc/alan/jobs/application?' + tokenQS, {
      method: 'POST', credentials: 'include', headers: { ...ct }, body: JSON.stringify(applyBody),
    });
    const d3 = await r3.json();
    const data = (d3 && d3.data) || {};
    const taskId = d3.taskId || '';
    const isDupMsg = (s) => /已投递|重复投递|已经投递|投递重复|重复申请|已申请过|请勿重复/.test(String(s || ''));
    const acc = { successN: 0, failN: 0, repeatN: 0, failMsg: '', already: false, dupMsg: '' };
    const walk = (obj, depth) => {
      if (!obj || depth > 6) return;
      if (Array.isArray(obj)) { obj.slice(0, 30).forEach((x) => walk(x, depth + 1)); return; }
      if (typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const kl = k.toLowerCase();
        if (typeof v === 'string') {
          if (isDupMsg(v)) { acc.already = true; acc.dupMsg = acc.dupMsg || v; }
          else if (/失败|不能|无法|限制|验证|不匹配|未通过/.test(v) && /fail|error|reason|msg|message/.test(kl)) {
            acc.failMsg = acc.failMsg || v;
          }
        }
        if (Array.isArray(v)) {
          if (/^successful$/.test(kl)) acc.successN = v.length;
          if (/^failed$/.test(kl)) acc.failN = v.length;
          if (/^repeated$/.test(kl)) { acc.repeatN = v.length; if (v.length) acc.already = true; }
        }
        walk(v, depth + 1);
      }
    };
    walk(d3, 0);
    const wrapMsg = String(d3.message || d3.msg || '');
    if (isDupMsg(wrapMsg)) { acc.already = true; acc.dupMsg = acc.dupMsg || wrapMsg; }
    if (isDupMsg(acc.failMsg)) { acc.already = true; acc.dupMsg = acc.dupMsg || acc.failMsg; acc.failMsg = ''; }

    let success = false;
    if (acc.successN > 0 || acc.repeatN > 0 || acc.already) success = true;
    else if (acc.failN > 0 || acc.failMsg) success = false;
    else if (/^SUCCESS$/i.test(wrapMsg) && taskId && !d3.faceRecognition) success = true;

    const blockStr = data.blockInfo != null ? JSON.stringify(data.blockInfo).slice(0, 200) : '无';
    const dupNote = acc.already && !acc.successN ? '(重复)' : '';
    const detail = success
      ? ('已投递' + dupNote + (attachFileId ? '(附件)' : '') + (taskId ? ' task=' + String(taskId).slice(0, 8) : ''))
      : (acc.failMsg || ('未真正投出 job=' + jobNumber
        + ' msg=' + wrapMsg
        + ' task=' + (taskId || '无')
        + ' org=' + meta.rootOrgId + ' staff=' + meta.staffId
        + ' blockInfo=' + blockStr
        + ' resume=' + String(useResume).slice(0, 8) + '…(' + String(useResume).length + ')'
        + (prepResume ? '(prep)' : '(页面)')
        + ' actionId=' + (actionId ? 'Y' : 'N')
        + ' city=' + JSON.stringify(cityIds)
        + ' 附件=' + (attachFileId ? 'Y' : 'N')
        + ' okN=' + acc.successN + ' failN=' + acc.failN + ' repeatN=' + acc.repeatN));
    window.postMessage({ __zl: true, id: cmd.id, ok: success, msg: detail }, '*');
  } catch (e) {
    window.postMessage({ __zl: true, id: cmd.id, ok: false, msg: e.message }, '*');
  }
})();
