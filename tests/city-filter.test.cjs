const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { join } = require('node:path');

const root = join(__dirname, '..', 'extension-v2.0');
const source = readFileSync(join(root, 'resume-match.js'), 'utf8');
const context = vm.createContext({ window: {}, Set, console });
// Expose internal pipeline stages only inside the test VM.
vm.runInContext(source.replace('return { loadResume,',
  'return { scoreList, tryRefinePass, refineFallbackJobs, jdCityMismatch, loadResume,'), context);
const rm = context.window.ResumeMatch;
const profile = rm.extractProfile(JSON.stringify({
  titles: ['Java开发工程师'], city: '上海', skills: ['Java'], workKeywords: [], directions: ['全部'], systemFilters: [],
}));
const job = (cityName, id = 'new') => ({
  jobId: id, name: 'Java开发工程师', cityName, skills: ['Java'], company: '示例公司',
});

test('Shanghai city code must not bypass coarse city filtering', () => {
  assert.equal(profile.cityCode, '101020100');
  for (const city of ['北京', '苏州', '昆明', '宁波', '苏州市上海路']) {
    assert.equal(rm.scoreList(job(city), profile).why, 'city', city);
  }
});

test('Shanghai city and district formats remain eligible', () => {
  for (const city of ['上海', '上海市', '上海·浦东新区', '上海-徐汇区', ' 上海市浦东新区 ']) {
    assert.notEqual(rm.scoreList(job(city), profile).why, 'city', city);
    assert.equal(rm.pendingJobsOf([job(city)], new Set(), new Set(), profile).length, 1, city);
  }
});

test('refinement rejects cities outside the built-in city code table', () => {
  const j = job('');
  assert.equal(rm.tryRefinePass(j, profile, { cityName: '昆明' }, () => {}, 'test'), false);
  assert.equal(j.refineWhy, 'city');
  assert.equal(rm.refineFallbackJobs([j]).kept.length, 0);
});

test('detail city replaces stale list city and is used by delivery guard', () => {
  const j = job('上海');
  rm.tryRefinePass(j, profile, { cityName: '宁波' }, () => {}, 'test');
  assert.equal(j.cityName, '宁波');
  assert.equal(rm.pendingJobsOf([j], new Set(), new Set(), profile).length, 0);
});

test('delivery excludes unknown locations and preserves applied/ignored deduplication', () => {
  const jobs = [job('上海', 'ok'), job('上海', 'applied'), job('上海', 'ignored'),
    job('北京', 'foreign'), job('', 'unknown'), job('  ', 'blank'), job('上海', '')];
  const kept = rm.pendingJobsOf(jobs, new Set(['applied']), new Set(['ignored']), profile);
  assert.equal(kept.map(j => j.jobId).join(','), 'ok');
  // Missing locations may proceed to detail lookup, but cannot be delivered yet.
  assert.notEqual(rm.scoreList(job(''), profile).why, 'city');
});

test('no city preference keeps previous delivery behavior', () => {
  assert.equal(rm.pendingJobsOf([job('北京'), job('')], new Set(), new Set(), { city: '' }).length, 2);
});

test('all popup platforms use freshly saved city for cached jobs', async () => {
  let saved = { city: '上海' };
  const popup = readFileSync(join(root, 'popup.js'), 'utf8');
  const start = popup.indexOf('async function pendingJobs(platform)');
  const end = popup.indexOf('// ---- 逐条投递状态', start);
  const ctx = vm.createContext({
    window: { ResumeMatch: rm, ResumeAI: { loadProfile: async () => saved } },
    jobsOf: () => [job('上海', 'sh'), job('北京', 'bj'), job('', 'unknown')],
    appliedCache: { boss: new Set(), zp: new Set(), w51: new Set() },
    ignoredCache: { boss: new Set(), zp: new Set(), w51: new Set() },
    cityBlockedCache: {},
  });
  vm.runInContext(popup.slice(start, end), ctx);
  for (const platform of ['boss', 'zp', 'w51']) {
    assert.equal((await ctx.pendingJobs(platform)).map(j => j.jobId).join(','), 'sh');
    saved = { city: '北京' };
    assert.equal((await ctx.pendingJobs(platform)).map(j => j.jobId).join(','), 'bj');
    saved = { city: '上海' };
  }
});
