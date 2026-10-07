#!/usr/bin/env node
/**
 * 第 3 步：合成交付 CSV —— ★ 固定 4 列：专利号 / 名称 / 年费 / 截止日
 *
 * 用法:
 *   <node> cnipa-quick-report.mjs [--rows rows.json] [--detail quick-detail.json]
 *                                 [--out 专利年费速查.csv] [--as-of YYYY-MM-DD]
 *                                 [--slashes] [--show N] [--no-bom]
 *                                 [--status-filter "…"] [--all-rows]
 *
 * ★ 列集合**唯一来源**就是本文件的 COLUMNS（4 列，无序号）——
 *   想要更多列请改用档案版 cnipa-patent-dossier（17 列合并表）。
 *
 * ── 四列口径（★ 与档案版 yearfee 模板的「选段逻辑」完全一致，两边可对表）──
 *
 * | # | 列 | 怎么来 |
 * |---|---|---|
 * | 1 | 专利号 | 输入号归一化后的 13 位原生写法（去 CN 前缀、去校验位点、去空白） |
 * | 2 | 名称   | 详情 sqxx 的 zhuanlimc；检索行 zhuanlimc 兜底 |
 * | 3 | 年费   | 按下表分档 |
 * | 4 | 截止日 | 与年费同档 |
 *
 * | 档 | 案件状态 | 年费 | 截止日 |
 * |---|---|---|---|
 * | ① | 含 `等年费滞纳金` | 「缴费时段**包含今天**」那一段的**总计**（年费+滞纳金），如 `315` | 该时段原文 `2026年08月18日到2026年09月15日` |
 * | ② | 其它（含 `专利权维持`） | 最近的**未缴**年费金额，如 `90` | 该笔年费缴费截止日 `YYYY-MM-DD` |
 * | ③ | 实用新型 + `未缴年费专利权终止，等恢复` | `等恢复·按口径未取年费`（`--force-fee` 时走 ①②） | 空 |
 * | ④ | 无未缴年费 | `无未缴年费` | 空 |
 * | ⑤ | 接口失败 / 号不在库 | `数据缺口(...)` / `未查到` | 同左 |
 *
 * ★ **① 取哪一段是关键**：CNIPA 从宽限期末一路排到缴费截止日，滞纳金逐月递增（每月 +5%），
 *   用户要的是「**今天落在哪一段**」，不是最晚那一段。
 * ★ **`--as-of YYYY-MM-DD` 基准日**：正因为取「包含今天的时段」，**跨天重跑同一批号结果会自然下移一段**
 *   （实测 2023211657312：09-15 跑 = 270，09-16 跑 = 315）。要复现某天的表就锁基准日；
 *   报告会打印 `[基准日]` 一行，对表前先看它。
 *   兜底：没有任何一段包含今天 → 已过最晚段取最晚；全是未来段取最早（不静默出空）。
 * ★ **日期写法**：截止日默认写**时段原文**（`2026年08月18日到2026年09月15日`）；
 *   加 `--slashes` 改成档案版合并表的斜杠写法（`2026/8/18到2026/9/15`，去前导零）。
 * ★ **「查不到数据」与「确实没有」严格分开**：取不到接口一律写 `数据缺口`，绝不静默当 0。
 * ★ **检索不到的号照样占一行**：名称/年费/截止日写「未查到」——给进去多少号，出来就多少行。
 * ★ **默认不过滤**：给多少号出多少行，便于对账。
 *   想只留「专利权维持 / 等年费滞纳金」两类（与档案版默认一致）：`--status-filter "专利权维持,等年费滞纳金"`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

const argv = process.argv.slice(2);
const VALUED = ['--rows', '--detail', '--out', '--show', '--as-of', '--status-filter'];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  if (VALUED.includes(a) && (i + 1 >= argv.length || argv[i + 1].startsWith('--'))) { console.error(`✗ 参数 ${a} 缺值`); process.exit(2); }
  if (!VALUED.includes(a) && !['--no-bom', '--slashes', '--all-rows'].includes(a)) { console.error(`✗ 未知参数 ${a}`); process.exit(2); }
}
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const ROWS = resolve(opt('rows', 'rows.json'));
const DETAIL = resolve(opt('detail', 'quick-detail.json'));
const OUT = resolve(opt('out', '专利年费速查.csv'));
const SHOW = Number(opt('show', '30'));
const BOM = !argv.includes('--no-bom');
const SLASHES = argv.includes('--slashes');

const AS_OF = String(opt('as-of', '')).trim();
const TODAY = (() => {
  if (/^\d{8}$/.test(AS_OF)) return `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) return AS_OF;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

const GAP = '数据缺口';
const fmtDate = (s) => {
  const v = String(s || '').trim();
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
};
const fmtSlash = (s) => String(s == null ? '' : s).trim()
  .replace(/(\d{4})年(\d{2})月(\d{2})日/g, (_m, y, m, d) => `${y}/${Number(m)}/${Number(d)}`)
  .replace(/(\d{4})-(\d{2})-(\d{2})/g, (_m, y, m, d) => `${y}/${Number(m)}/${Number(d)}`);

const RE_ZNJ = /等年费滞纳金/;
const RE_RECOVERY = /未缴年费专利权终止/;

/** 解析滞纳金缴费时段 "2026年08月06日到2026年09月07日" → {s,e,raw} */
function parseSpan(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/\d{4}年\d{2}月\d{2}日/g) || [];
  const f = (x) => x.replace(/(\d{4})年(\d{2})月(\d{2})日/, '$1-$2-$3');
  return { s: m[0] ? f(m[0]) : '', e: m.length ? f(m[m.length - 1]) : '', raw };
}

/** ★ 取「缴费时段包含今天」的那一段（不是最晚段）。兜底：全过期取最晚 / 全未来取最早。 */
function pickZnj(zn, today = TODAY) {
  const list = (Array.isArray(zn) ? zn : [])
    .map((x) => ({ ...x, _sp: parseSpan(x.sj) }))
    .filter((x) => x._sp.s || x._sp.e);
  if (!list.length) return null;
  const t = today;
  const byEnd = list.slice().sort((a, b) => a._sp.e.localeCompare(b._sp.e));
  const inToday = byEnd.filter((x) => x._sp.s <= t && t <= x._sp.e);
  if (inToday.length) return inToday[inToday.length - 1];
  const late = byEnd.filter((x) => x._sp.e < t);
  if (late.length) return late[late.length - 1];
  return byEnd[0];
}

const numSum = (...vs) => {
  const nums = vs.map((v) => Number(String(v == null ? '' : v).replace(/[^\d.]/g, ''))).filter((n) => Number.isFinite(n));
  return nums.length ? String(nums.reduce((a, b) => a + b, 0)) : '';
};

/** 年费 + 截止日（★ 四列的取值核心，唯一来源） */
function feeOf(r, d) {
  const uniq = (v) => (SLASHES ? fmtSlash(v) : v);
  if (!d) return { fee: '未查到', due: '未查到' };
  const status = String(d.anjianywzt || r.status || '');

  // ③ 实用新型 + 「未缴年费专利权终止，等恢复」→ 按口径不取年费
  if (d._skipAnnual) {
    // 检索行与详情不一致时如实报缺口（不能默默写「未取年费」把真实年费藏掉）
    if (!RE_RECOVERY.test(status) || !/等恢复/.test(status)) return { fee: `${GAP}(检索行与详情的案件状态不一致，年费未取)`, due: '' };
    return { fee: '等恢复·按口径未取年费', due: '' };
  }
  if (d._skipFee) return { fee: `${GAP}(按口径未取费用)`, due: '' };
  if (d.fyStatus !== 200) return { fee: `${GAP}(费用接口 ${d.fyStatus || '失败'})`, due: '' };

  const zn = Array.isArray(d.zhinajin) ? d.zhinajin : [];
  const yj = (d.yingjiao || []).filter((x) => /年费/.test(String(x.zl || '')) && /未缴/.test(String(x.zt || '')));

  // ① 等年费滞纳金 → 今天所在时段的总计 + 该时段原文
  if (RE_ZNJ.test(status)) {
    if (!zn.length) return { fee: `${GAP}(状态=等年费滞纳金，但接口无滞纳金明细)`, due: '' };
    const cur = pickZnj(zn, TODAY);
    if (!cur) return { fee: `${GAP}(状态=等年费滞纳金，滞纳金时段无法解析)`, due: '' };
    const total = String(cur.zj || '').trim() || numSum(cur.nf, cur.zn);
    return { fee: total || GAP, due: cur._sp.e ? uniq(cur._sp.raw) : '' };
  }

  // ② / ④ 其它状态 → 最近的未缴年费（截止日最早的一条）
  if (!yj.length) return { fee: '无未缴年费', due: '' };
  const cur = yj.slice().sort((a, b) => String(a.jzr || '').localeCompare(String(b.jzr || '')))[0];
  return { fee: cur.je || GAP, due: fmtDate(cur.jzr) };
}

/** ★ 唯一列定义处：4 列，顺序固定，无序号 */
const COLUMNS = [
  ['专利号', (r) => r.appno],
  ['名称', (r, d) => (d && d.zhuanlimc) || r.name || ''],
  ['年费', (r, d) => feeOf(r, d).fee],
  ['截止日', (r, d) => feeOf(r, d).due],
];

const cell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

if (!existsSync(ROWS)) { console.error(`✗ 找不到 ${ROWS}`); process.exit(3); }
const rows0 = JSON.parse(readFileSync(ROWS, 'utf8'));
const detail = existsSync(DETAIL) ? JSON.parse(readFileSync(DETAIL, 'utf8')) : {};
if (!existsSync(DETAIL)) console.warn(`⚠️ 未找到 ${DETAIL}，本次只导出检索到的基础信息（名称/年费/截止日多为数据缺口）`);

// ── 输出过滤（默认不过滤，给多少号出多少行，便于对账）──
const STATUS_FILTER = argv.includes('--all-rows') ? null : String(opt('status-filter', '')).trim() || null;
let rows = rows0;
if (STATUS_FILTER) {
  const kws = STATUS_FILTER.split(',').map((s) => s.trim()).filter(Boolean);
  const statusOf = (r) => {
    if (r.found === false) return '';
    const d = detail[String(r.appno)];
    if (d && d.sqBizCode) return '';
    return String((d && d.anjianywzt) || r.status || '');
  };
  const kept = rows0.filter((r) => kws.some((k) => statusOf(r).includes(k)));
  console.log(`[过滤] 案件状态含 [${kws.join('/')}]：${rows0.length} 行 → 保留 ${kept.length} 行`);
  rows = kept;
} else {
  console.log(`[过滤] 不过滤（默认，便于对账）；--status-filter "专利权维持,等年费滞纳金" 可只留两类`);
}

const UNKNOWN_FROM = 1;   // 检索不到的号：从第 2 列（名称）起标「未查到」
const lines = [COLUMNS.map(([h]) => h).map(cell).join(',')];
rows.forEach((r) => {
  let d = r.found === false ? null : detail[String(r.appno)];
  if (d && d.sqBizCode) d = null;         // 业务码 20101「著录项目信息不存在」→ 按「未查到」处理
  const bad = r.found === false || (detail[String(r.appno)] || {}).sqBizCode;
  const vals = COLUMNS.map(([, get], j) => (bad && j >= UNKNOWN_FROM ? '未查到' : get(r, d)));
  lines.push(vals.map(cell).join(','));
});

mkdirSync(dirname(OUT), { recursive: true });
const payload = (BOM ? '\ufeff' : '') + lines.join('\r\n') + '\r\n';
// 写入兜底：CSV 正被 Excel / 预览面板打开会 EBUSY（重试 5 次 → 写到「同名-new.csv」并告警，绝不静默丢表）
let REAL_OUT = OUT, wrote = false;
for (let i = 0; i < 5 && !wrote; i++) {
  try { writeFileSync(OUT, payload, 'utf8'); wrote = true; }
  catch (e) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!wrote) {
  REAL_OUT = OUT.replace(/\.csv$/i, '') + '-new.csv';
  writeFileSync(REAL_OUT, payload, 'utf8');
  console.warn(`⚠️ ${OUT} 被占用（EBUSY，通常是该 CSV 正被 Excel/预览打开），已改写到 ${REAL_OUT}`);
}

// ── 汇报 ──────────────────────────────────────────────────────────────
const notFound = rows.filter((r) => r.found === false).length;
const gapRows = rows.filter((r) => r.found !== false && !detail[String(r.appno)]);
const stat = {};
rows.forEach((r) => {
  const d = r.found === false ? null : detail[String(r.appno)];
  const f = feeOf(r, d).fee;
  const key = /^\d+$/.test(f) ? '(金额)' : String(f).replace(/\(.*$/, '');
  stat[key] = (stat[key] || 0) + 1;
});

console.log(`[列] ${COLUMNS.length} 列：${COLUMNS.map(([h]) => h).join(' / ')}`);
console.log(`[基准日] ${TODAY}${AS_OF ? '（--as-of 指定）' : '（系统当天；滞纳金按此日取「包含该日的时段」，--as-of YYYY-MM-DD 可锁定）'}`);
console.log(`[日期写法] ${SLASHES ? '斜杠（2026/8/18到2026/9/15）' : '时段原文（2026年08月18日到2026年09月15日）'}`);
console.log(`[输出] ${REAL_OUT}`);
console.log(`[结果] 共 ${rows.length} 行${notFound ? `（检索不到 ${notFound} 条，标「未查到」）` : ''}`
  + `${gapRows.length ? `；无详情数据 ${gapRows.length} 条（标「数据缺口」）` : ''}`);
console.log('[分布]');
Object.entries(stat).forEach(([k, v]) => console.log(`   ${k} → ${v}`));

if (SHOW > 0) {
  console.log('\n' + COLUMNS.map(([h]) => h).join(' | '));
  rows.slice(0, SHOW).forEach((r) => {
    const d = r.found === false ? null : detail[String(r.appno)];
    const bad = r.found === false;
    console.log(COLUMNS.map(([, get], j) => String(bad && j >= UNKNOWN_FROM ? '未查到' : get(r, d)).slice(0, 26)).join(' | '));
  });
  if (rows.length > SHOW) console.log(`… 另有 ${rows.length - SHOW} 条，完整内容见 CSV`);
}
