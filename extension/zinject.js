// zinject.js — 智联招聘投递调用（页面主环境，Cookie 自动带）
(async () => {
  const divs = document.querySelectorAll('[id^="__zl_data_"]');
  const div = divs[divs.length - 1];
  if (!div) return;
  const cmd = JSON.parse(div.getAttribute('data-cmd'));

  const headers = {};
  if (cmd.cookies) headers['Cookie'] = cmd.cookies;

  try {
    const at = cmd.at || '';
    const rt = cmd.rt || '';
    const resumeNumber = cmd.resumeNumber || '';
    const cityIds = cmd.cityIds || ['538'];
    const jobNumber = cmd.jobNumber || '';

    if (!at || !rt || !resumeNumber || !jobNumber) {
      window.postMessage({ __zl: true, id: cmd.id, ok: false,
        msg: '缺少参数: at=' + !!at + ' rt=' + !!rt + ' resume=' + !!resumeNumber + ' job=' + !!jobNumber
      }, '*');
      return;
    }

    const tokenQS = 'at=' + at + '&rt=' + rt + '&_v=' + Math.random();
    const ct = { 'Content-Type': 'application/json' };

    // === Step 1: preparation ===
    const prepBody = JSON.stringify({
      at, rt, jobCount: 1, rootOrgId: '', staffId: cmd.staffId || 0,
      isShowAttachmentSelect: true,
      actionId: cmd.actionId || '',
    });
    const r1 = await fetch('https://fe-api.zhaopin.com/c/pc/alan/jobs/application/preparation?' + tokenQS,
      { method: 'POST', headers: { ...headers, ...ct }, body: prepBody });
    const d1 = await r1.json();
    const actionId = (d1.data && d1.data.actionId) || cmd.actionId || '';

    // 附件简历信息
    const attachInfo = (d1.data && d1.data.attachmentResumeInfo) || {};
    const attachFileId = attachInfo.defaultAttachmentPath || '';

    // === Step 2a: judgeJobWorkerCollar ===
    try {
      const body1 = JSON.stringify({ jobType: '20000100010000', platform: 13, version: '0.0.0' });
      await fetch('https://cgate.zhaopin.com/resumeapi/searchv2/judgeJobWorkerCollar?' + tokenQS,
        { method: 'POST', headers: { ...headers, ...ct }, body: body1 });
    } catch (_) {}

    // === Step 2b: interceptService ===
    try {
      const body2 = JSON.stringify({ jobNumber, feature: 1, scene: 1, action: 0, platform: 13, version: '0.0.0' });
      await fetch('https://cgate.zhaopin.com/bdp/interceptService/intercept?' + tokenQS,
        { method: 'POST', headers: { ...headers, ...ct }, body: body2 });
    } catch (_) {}

    // === Step 3: application (投递) ===
    const applyBody = {
      jobNumbers: [jobNumber],
      cityIds: cityIds,
      resumeNumber: resumeNumber,
      at, rt,
      language: 3,
      batched: false,
      inviteCode: '',
      ignoreIntention: 1,
      ignoreBlackType: '',
      deliveryChannelType: 1,
      extraApplyParams: {},
      actionId: actionId || '',
      businessSystem: '1',
      stSourceCode: 0,
      businessPlatformSub: 0,
      businessTagId: '',
      businessPlatformLabel: 0,
      pageCode: 4019,
      jobSource: 'SEARCH',
    };
    // 有附件简历时加上附件字段
    if (attachFileId) {
      applyBody.attachmentDefaultType = 'attachment';
      applyBody.attachmentDefaultFileId = attachFileId;
    }

    const r3 = await fetch('https://fe-api.zhaopin.com/c/pc/alan/jobs/application?' + tokenQS,
      { method: 'POST', headers: { ...headers, ...ct }, body: JSON.stringify(applyBody) });
    const d3 = await r3.json();

    const success = d3.code === 200 || d3.code === 0 || d3.success === true || d3.status === 1
      || (d3.message && d3.message.toUpperCase().includes('SUCCESS'));
    window.postMessage({ __zl: true, id: cmd.id, ok: success,
      msg: success ? '已投递' + (attachFileId ? '(附件)' : '') : (d3.message || d3.msg || 'code=' + (d3.code || '?'))
    }, '*');
  } catch (e) {
    window.postMessage({ __zl: true, id: cmd.id, ok: false, msg: e.message }, '*');
  }
})();
