#!/usr/bin/env node
/**
 * 离线回归测试：**四列出表口径**（不联网、不碰浏览器）
 *
 * 造一批覆盖全部分档的 rows.json / quick-detail.json，跑第 3 步出表脚本，
 * 断言 CSV 的 4 列表头与各档取值。改了 report 的取值逻辑后跑这个，
 * 能立刻看出有没有把「滞纳金取哪一段」「等恢复不取年费」这些口径跑偏。
 *
 * 用法:
 *   <node> tests/report-selftest.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = resolve(HERE, '../scripts/cnipa-quick-report.mjs');
const NODE = process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'quick-selftest-'));

const SEG = [
  { nf: '120', sj: '2026年06月16日到2026年07月15日', zn: '60', zj: '180' },
  { nf: '120', sj: '2026年07月16日到2026年08月17日', zn: '105', zj: '225' },
  { nf: '120', sj: '2026年08月18日到2026年09月15日', zn: '150', zj: '270' },
  { nf: '120', sj: '2026年09月16日到2026年10月15日', zn: '195', zj: '315' },
  { nf: '120', sj: '2026年10月16日到2026年11月16日', zn: '240', zj: '360' },
];

const rows = [
  { appno: '2023211657312', name: '一种分切机', status: '等年费滞纳金', type: '2', typeName: '实用新型', found: true },
  { appno: '2020213173457', name: '某某装置', status: '专利权维持', type: '1', typeName: '发明', found: true },
  { appno: '2021201234567', name: '某恢复件', status: '未缴年费专利权终止，等恢复', type: '2', typeName: '实用新型', found: true },
  { appno: '2021201234568', name: '某不一致件', status: '未缴年费专利权终止，等恢复', type: '2', typeName: '实用新型', found: true },
  { appno: '2020309999999', name: '某无费件', status: '专利权维持', type: '3', typeName: '外观设计', found: true },
  { appno: '2019100000001', name: '某缺口件', status: '专利权维持', type: '1', typeName: '发明', found: true },
  { appno: '2024108086589', name: '', status: '未查到', found: false },
];

const detail = {
  '2023211657312': { sqStatus: 200, fyStatus: 200, zhuanlimc: '一种分切机', anjianywzt: '等年费滞纳金',
    yingjiao: [{ zl: '实用新型专利第6年年费', je: '120', jzr: '20260915', zt: '未缴' }], zhinajin: SEG, zhinajinN: 5,
    _skipFee: false, _skipAnnual: false },
  '2020213173457': { sqStatus: 200, fyStatus: 200, zhuanlimc: '某某装置', anjianywzt: '专利权维持',
    yingjiao: [{ zl: '发明专利第3年年费', je: '900', jzr: '20270325', zt: '未缴' },
      { zl: '发明专利第4年年费', je: '1200', jzr: '20280325', zt: '未缴' }], zhinajin: [], zhinajinN: 0,
    _skipFee: false, _skipAnnual: false },
  '2021201234567': { sqStatus: 200, zhuanlimc: '某恢复件', anjianywzt: '未缴年费专利权终止，等恢复',
    _skipFee: false, _skipAnnual: true },
  '2021201234568': { sqStatus: 200, fyStatus: 200, zhuanlimc: '某不一致件', anjianywzt: '专利权维持',
    yingjiao: [{ zl: '年费', je: '90', jzr: '20270101', zt: '未缴' }], zhinajin: [],
    _skipFee: false, _skipAnnual: true },
  '2020309999999': { sqStatus: 200, fyStatus: 200, zhuanlimc: '某无费件', anjianywzt: '专利权维持',
    yingjiao: [], zhinajin: [], zhinajinN: 0, _skipFee: false, _skipAnnual: false },
  '2019100000001': { sqStatus: 200, fyStatus: 500, zhuanlimc: '某缺口件', anjianywzt: '专利权维持',
    _skipFee: false, _skipAnnual: false },
};

writeFileSync(join(dir, 'rows.json'), JSON.stringify(rows, null, 1), 'utf8');
writeFileSync(join(dir, 'detail.json'), JSON.stringify(detail, null, 1), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}\n     实际: ${JSON.stringify(got)}${ok ? '' : `\n     期望: ${JSON.stringify(want)}`}`);
};

/** 跑一次出表，返回 { header:[], lines:[][] } */
function runReport(extra = []) {
  const out = join(dir, 'out.csv');
  const args = [REPORT, '--rows', join(dir, 'rows.json'), '--detail', join(dir, 'detail.json'),
    '--out', out, '--show', '0', ...extra];

  // 某些受限环境（如被 job object 托管的 Windows 沙箱）下，spawnSync 走管道捕获会返回
  // status=null + error.code='EBUSY'，此时子进程根本没被拉起。降级为「临时文件重定向」。
  let r = spawnSync(NODE, args, { cwd: dir, encoding: 'utf8' });
  if (r.status === null) {
    const cap = join(dir, `cap-${Math.abs(hashStr(args.join(' ')))}.log`);
    const fd = openSync(cap, 'w');
    const r2 = spawnSync(NODE, args, { cwd: dir, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    r = { status: r2.status, stdout: readFileSync(cap, 'utf8'), stderr: '' };
  }
  if (r.status !== 0) { console.error('report 退出码', r.status, r.stdout, r.stderr); process.exit(1); }
  const txt = readFileSync(out, 'utf8').replace(/^\ufeff/, '');
  const ls = txt.split('\r\n').filter(Boolean).map((l) => l.split(','));
  return { header: ls[0], lines: ls.slice(1) };
}
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const feeOfRow = (t, i) => t.lines[i][2];
const dueOfRow = (t, i) => t.lines[i][3];

console.log('=== 四列出表口径 · 离线回归 ===\n');

const t = runReport(['--as-of', '2026-09-15']);
check('表头固定 4 列（无序号）', t.header.join('|'), '专利号|名称|年费|截止日');
check('行数 = 给进去的行数（未查到也占行）', t.lines.length, 7);
check('① 滞纳金：基准日 09-15 → 落在第 3 段 = 270', feeOfRow(t, 0), '270');
check('① 滞纳金：截止日写该时段原文', dueOfRow(t, 0), '2026年08月18日到2026年09月15日');
check('② 维持：取截止日最早的未缴年费 = 900', feeOfRow(t, 1), '900');
check('② 维持：截止日 YYYY-MM-DD', dueOfRow(t, 1), '2027-03-25');
check('③ 实用新型+等恢复：按口径不取年费', feeOfRow(t, 2), '等恢复·按口径未取年费');
check('③ 截止日留空', dueOfRow(t, 2), '');
check('④ 检索状态与详情不一致 → 如实报缺口，不掩藏年费', feeOfRow(t, 3), '数据缺口(检索行与详情的案件状态不一致，年费未取)');
check('⑤ 无未缴年费', feeOfRow(t, 4), '无未缴年费');
check('⑥ 费用接口 500 → 数据缺口（不静默当 0）', feeOfRow(t, 5), '数据缺口(费用接口 500)');
check('⑦ 本行名称取详情 zhuanlimc', t.lines[0][1], '一种分切机');
check('⑧ 号不在库 → 名称/年费/截止日全标「未查到」', t.lines[6].slice(1).join('|'), '未查到|未查到|未查到');
check('⑨ 未查到的行仍保留原始专利号', t.lines[6][0], '2024108086589');

console.log('\n--- 基准日与写法开关 ---');
const t2 = runReport(['--as-of', '2026-09-16']);
check('跨天重跑下移一段：基准日 09-16 → 315', feeOfRow(t2, 0), '315');
check('跨天重跑：截止日跟着下移', dueOfRow(t2, 0), '2026年09月16日到2026年10月15日');
const t3 = runReport(['--as-of', '2026-09-15', '--slashes']);
check('--slashes：截止日改斜杠写法（去前导零）', dueOfRow(t3, 0), '2026/8/18到2026/9/15');

console.log('\n--- 输出过滤开关 ---');
const t4 = runReport(['--as-of', '2026-09-15', '--status-filter', '专利权维持,等年费滞纳金']);
check('--status-filter 只留两类 → 行数变少', t4.lines.length < 7, true);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
