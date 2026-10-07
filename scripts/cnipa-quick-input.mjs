#!/usr/bin/env node
/**
 * 前置第 0 步：**输入类型识别**（★ 2026-09-18 新增）
 *
 * 一件事：把用户随手给的一串东西，判成「专利号 / 专利名称 / 申请人」三类，并归一化。
 * 输出一份「查询计划」，交给第 1 步检索脚本按不同路子去查。
 *
 * 判据优先级（先看显式标签，再看形态）：
 *   ① 显式标签（最高优先）：`专利号：…` / `名称：…` / `申请人：…` 前缀 —— 用户自己标了就听用户的
 *   ② 专利号形态：`CN202422940446.4` / `202422940446.4` / `ZL2024229404464` / `2024229404464`
 *      → 去掉 CN/ZL 前缀、空白、`.` 校验位点、连字符后，是 8/9/12/13 位纯数字
 *   ③ 申请人形态：命中机构名后缀词表（公司/研究院/大学/医院/集团/事务所…）
 *   ④ 其余 → **专利名称**（用户 2026-09-18 定的默认：没机构后缀就当名称查）
 *
 * ★ 为什么默认落到「名称」而不是「申请人」：
 *   用户口径是「输入名称 → 按名称查」。纯中文短词（如「分切机」）既可能是名称的一部分，
 *   也可能是人名申请人，无法从形态分辨 —— 默认按名称查，想当申请人查请显式加 `--as 申请人`
 *   或在输入里写 `申请人：张三`。
 *
 * ★ 兜底不误伤：若显式标签说「专利号」但剩下的内容不是纯数字（例如专利名称
 *   「专利号牌识别装置」会被 `专利号` 前缀误伤），**降级按名称处理并给出提示**，
 *   不硬当专利号查（否则必然「未查到」）。
 *
 * 用法（CLI，用于排查识别结果；正式流程由 search/run 脚本直接 import 本模块）：
 *   <node> cnipa-quick-input.mjs --input "分切机"
 *   <node> cnipa-quick-input.mjs --input "CN202422940446.4" --input "江西创导动物保健品有限公司"
 *   <node> cnipa-quick-input.mjs --input-file 清单.txt [--json]
 *   <node> cnipa-quick-input.mjs --self-test        # 离线跑识别用例，不联网
 *   <node> cnipa-quick-input.mjs --input "华为" --as 申请人     # 强制指定类型
 *
 * `--as` 取值：`号` / `automatic`(默认) / `名称` / `申请人`（也接受 appno/name/applicant）
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/** 专利号归一化：去 CN/ZL 前缀 + 去空白 + 去 `.`/`-`/全角标点 → 库里的 13 位原生写法。
 *  ★ 与档案版 normNo 同源：`CN202422940446.4` / `202422940446.4` / `2024229404464` 三种写法等价。 */
export function normNo(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/^[（(【\[]*\s*(CN|ZL|cn|zl)\s*/i, '')          // CN / ZL 前缀（可能带括号）
    .replace(/[\s\u3000．.。·・,，、;；:：\-—_－]/g, '')      // 分隔符一律去掉
    .toUpperCase();
}

/** 文本归一化（名称/申请人「精确相等」比较用）：去空白 + 全角括号转半角 */
export function normText(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
    .replace(/[，]/g, ',')
    .replace(/[；]/g, ';');
}

/* ------------------------------------------------------------------ *
 * 判据
 * ------------------------------------------------------------------ */

/** 专利号形态：8 位（1985-1988）/ 9 位（1989-2003.9）/ 12+1 位（2003.10 起，含校验位） */
const APPNO_RE = /^\d{8}$|^\d{9}$|^\d{12}$|^\d{13}$/;

/** 机构名后缀词表 —— 命中即判「申请人」。带 `$` 的只认结尾，避免误伤（如「化工」出现在名称中段）。 */
const APPLICANT_WORDS = [
  /公司/, /有限/, /股份/, /厂$/,
  /研究院/, /研究所/, /科学院/, /大学/, /学院/, /学校/, /中学/, /小学/, /幼儿园/,
  /医院/, /门诊部/, /卫生院/, /防疫站/, /疾控中心/,
  /集团/, /中心$/, /事务所/, /合作社/, /农场/, /林场/, /牧场/, /渔场/,
  /协会/, /学会/, /商会/, /管委会/, /政府/, /管理局/, /监督局/, /银行/,
  /企业/, /实业/, /工作室/, /经营部/, /服务部/, /门市部/, /商店/, /商行/, /超市/, /酒店/, /宾馆/,
  /有限责任公司/, /股份有限公司/, /合伙企业/, /个体工商户/, /自然人/, /个人$/,
];
const isApplicantLike = (s) => APPLICANT_WORDS.some((re) => re.test(s));

/** 显式标签：用户自己写了类型就听用户的。
 *  ⚠️ 单字/泛词前缀（`专利` / `号`）**必须带冒号**，否则「专利年费管理方法」这类专利名称会被误伤。 */
const LABELS = [
  { re: /^(专利号|申请号|公开号|公告号)\s*[:：]?\s*/, kind: 'appno' },
  { re: /^(专利|号)\s*[:：]\s*/, kind: 'appno' },
  { re: /^(专利名称|发明名称|名称)\s*[:：]?\s*/, kind: 'name' },
  { re: /^(申请人|申请单位|专利权人|权利人)\s*[:：]?\s*/, kind: 'applicant' },
];

const KIND_CN = { appno: '专利号', name: '专利名称', applicant: '申请人' };
export const KIND_LABEL = KIND_CN;

/**
 * 识别单条输入。
 * @param {string} raw 用户原始输入
 * @param {'auto'|'appno'|'name'|'applicant'} force 强制类型（--as）
 * @returns {{kind:'appno'|'name'|'applicant', value:string, raw:string, reason:string, confidence:'high'|'medium'|'low', warn?:string}}
 */
export function classify(raw, force = 'auto') {
  const original = String(raw == null ? '' : raw).trim();
  if (!original) return { kind: 'name', value: '', raw: '', reason: '空输入', confidence: 'low', warn: '输入为空，已跳过' };

  let s = original;
  let labelKind = null;
  for (const L of LABELS) {
    const m = s.match(L.re);
    if (m) { labelKind = L.kind; s = s.slice(m[0].length).trim(); break; }
  }

  // ① 强制类型（用户显式 --as）最高优先
  if (force && force !== 'auto') {
    return finish(force, force === 'appno' ? normNo(s) : s, original, `用户显式指定（--as ${KIND_CN[force]}）`, 'high');
  }

  const digits = normNo(s);

  // ② 显式标签
  if (labelKind === 'appno') {
    if (APPNO_RE.test(digits)) return finish('appno', digits, original, '输入自带「专利号/申请号」标签', 'high');
    // 兜底不误伤：标签说是号、内容却不是数字（如「专利号牌识别装置」）→ 降级按名称，**值取原始输入**
    // （不能取剥掉前缀的 s，否则名称会被削掉开头）
    return finish('name', original, original, '前缀像专利号标签但内容不是号码形态，已降级按名称处理', 'low',
      `「${original}」被识别为专利名称（前缀「专利号」是名称的一部分，不是标签）；若确实是专利号请用 --as 专利号 强制`);
  }
  if (labelKind === 'name') return finish('name', s, original, '输入自带「名称」标签', 'high');
  if (labelKind === 'applicant') return finish('applicant', s, original, '输入自带「申请人」标签', 'high');

  // ③ 专利号形态
  if (APPNO_RE.test(digits)) {
    const warn = digits.length === 12
      ? `「${original}」是 12 位 —— CNIPA 库里查不到（需要第 13 位校验位），可能标「未查到」；请核对原始号`
      : undefined;
    return finish('appno', digits, original, `号码形态（${digits.length} 位数字）`, 'high', warn);
  }

  // ④ 申请人形态
  if (isApplicantLike(s)) return finish('applicant', s, original, '命中机构名后缀（公司/研究院/大学…）', 'high');

  // ⑤ 其余 → 专利名称（用户默认口径）
  return finish('name', s, original, '无号码特征、无机构名后缀 → 按专利名称处理（默认口径）', 'medium');
}

function finish(kind, value, raw, reason, confidence, warn) {
  return { kind, value: kind === 'appno' ? value : String(value).trim(), raw, reason, confidence, ...(warn ? { warn } : {}) };
}

/* ------------------------------------------------------------------ *
 * 查询计划
 * ------------------------------------------------------------------ */

/**
 * 把一批输入整理成查询计划。
 * @param {string[]} inputs
 * @param {{force?:string}} [o]
 * @returns {{items:object[], appnos:string[], names:string[], applicants:string[], warns:string[]}}
 */
export function buildPlan(inputs, o = {}) {
  const items = [];
  for (const raw of inputs) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    items.push(classify(s, o.force || 'auto'));
  }
  const by = (k) => items.filter((x) => x.kind === k).map((x) => x.value);
  // 同一关键词去重（保留首次出现顺序）
  const uniq = (a) => [...new Set(a)];
  const warns = [];
  items.forEach((x) => { if (x.warn) warns.push(x.warn); });
  return { items, appnos: uniq(by('appno')), names: uniq(by('name')), applicants: uniq(by('applicant')), warns };
}

/** 人类可读的计划描述（日志用） */
export function describePlan(plan) {
  const lines = ['[识别] 输入类型判定：'];
  plan.items.forEach((x) => {
    lines.push(`   「${x.raw}」→ ${KIND_CN[x.kind]}：${x.value}   · ${x.reason}`);
  });
  const sum = [];
  if (plan.appnos.length) sum.push(`专利号 ${plan.appnos.length} 个`);
  if (plan.names.length) sum.push(`名称 ${plan.names.length} 个`);
  if (plan.applicants.length) sum.push(`申请人 ${plan.applicants.length} 个`);
  lines.push(`[识别] 汇总：${sum.join(' + ') || '（无有效输入）'}`);
  lines.push('[识别] 输出口径固定为 4 列：专利号 / 名称 / 年费 / 截止日');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const AS_MAP = { 号: 'appno', 专利号: 'appno', appno: 'appno', 名称: 'name', 专利名称: 'name', name: 'name', 申请人: 'applicant', applicant: 'applicant', auto: 'auto', 自动: 'auto' };

function cli() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const all = (n) => { const out = []; argv.forEach((a, i) => { if (a === '--' + n && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]); }); return out; };

  if (argv.includes('--self-test')) return selfTest();

  const inputs = [...all('input')];
  const f = opt('input-file', '');
  if (f) {
    const p = resolve(process.cwd(), f);
    if (!existsSync(p)) { console.error(`✗ 找不到 ${p}`); process.exit(1); }
    readFileSync(p, 'utf8').split(/\r?\n/).forEach((l) => {
      const s = l.replace(/^\s*#.*$/, '').trim();
      if (s) inputs.push(s);
    });
  }
  if (!inputs.length) {
    console.error('用法：--input "<任意输入>"（可重复） / --input-file 清单.txt / --self-test');
    process.exit(1);
  }
  const asRaw = String(opt('as', 'auto')).trim();
  const force = AS_MAP[asRaw] || AS_MAP[asRaw.toLowerCase()] || 'auto';
  if (!AS_MAP[asRaw] && !AS_MAP[asRaw.toLowerCase()]) { console.error(`✗ --as 只接受 号|名称|申请人|auto，当前 ${asRaw}`); process.exit(2); }

  const plan = buildPlan(inputs, { force });
  if (argv.includes('--json')) { console.log(JSON.stringify(plan, null, 1)); return; }
  console.log(describePlan(plan));
  plan.warns.forEach((w) => console.log('   ⚠️ ' + w));
}

/* ------------------------------------------------------------------ *
 * 离线自测（不联网）
 * ------------------------------------------------------------------ */
function selfTest() {
  const CASES = [
    // [输入, 期望类型, 期望值, 备注]
    ['2024229404464', 'appno', '2024229404464', '13 位原生'],
    ['CN202422940446.4', 'appno', '2024229404464', '带 CN 与校验位点'],
    ['CN202422940446.4 ', 'appno', '2024229404464', '尾随空格'],
    ['zl2024229404464', 'appno', '2024229404464', '小写 zl 前缀'],
    ['202422940446.4', 'appno', '2024229404464', '无 CN 前缀'],
    ['202422940446', 'appno', '202422940446', '12 位 → 识别为号但有告警'],
    ['98123456', 'appno', '98123456', '8 位老号'],
    ['891234567', 'appno', '891234567', '9 位老号'],
    ['专利号：CN202422940446.4', 'appno', '2024229404464', '中文标签'],
    ['申请号 2024108086589', 'appno', '2024108086589', '标签无冒号'],
    ['名称：一种分切机', 'name', '一种分切机', '名称标签'],
    ['一种分切机', 'name', '一种分切机', '无后缀纯名称'],
    ['分切机', 'name', '分切机', '关键词'],
    ['专利年费管理方法', 'name', '专利年费管理方法', '以「专利」开头但不是号（关键反例）'],
    ['专利号牌识别装置', 'name', '专利号牌识别装置', '以「专利号」开头但不是号（关键反例）'],
    ['江西创导动物保健品有限公司', 'applicant', '江西创导动物保健品有限公司', '公司后缀'],
    ['清华大学', 'applicant', '清华大学', '大学后缀'],
    ['北京大学第三医院', 'applicant', '北京大学第三医院', '医院后缀'],
    ['中国科学院理化技术研究所', 'applicant', '中国科学院理化技术研究所', '研究所后缀'],
    ['中国石油化工股份有限公司', 'applicant', '中国石油化工股份有限公司', '股份+公司'],
    ['某某科技有限公司', 'applicant', '某某科技有限公司', '有限公司'],
    ['华为', 'name', '华为', '无后缀 → 默认按名称（需 --as 申请人 才当申请人）'],
    ['张三', 'name', '张三', '人名 → 默认按名称'],
    ['申请人：某某机械厂', 'applicant', '某某机械厂', '申请人标签 + 厂后缀'],
  ];

  let pass = 0, fail = 0;
  console.log('=== 输入类型识别 · 离线自测 ===\n');
  for (const [input, ek, ev, note] of CASES) {
    const r = classify(input);
    const ok = r.kind === ek && r.value === ev;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '✅' : '❌'} 「${input}」→ ${KIND_CN[r.kind]}：${r.value}` + (ok ? '' : `   ✗ 期望 ${KIND_CN[ek]}：${ev}`) + (note ? `   (${note})` : ''));
  }

  console.log('\n--- 强制指定 --as 用例 ---');
  const FORCE = [
    ['华为', 'applicant', '华为'],
    ['2024229404464', 'name', '2024229404464'],
    ['分切机', 'applicant', '分切机'],
  ];
  for (const [input, f, ev] of FORCE) {
    const r = classify(input, f);
    const ok = r.kind === f && r.value === ev;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '✅' : '❌'} 「${input}」--as ${KIND_CN[f]} → ${KIND_CN[r.kind]}：${r.value}`);
  }

  console.log('\n--- buildPlan 汇总用例 ---');
  // 注意：`CN202422940446.4` 与 `2024229404464` 归一化后是同一个号 → 应被去重
  const p = buildPlan(['CN202422940446.4', '一种分切机', '江西创导动物保健品有限公司', '2024229404464', '分切机']);
  const okPlan = p.appnos.length === 1 && p.names.length === 2 && p.applicants.length === 1;
  if (okPlan) pass++; else fail++;
  console.log(`${okPlan ? '✅' : '❌'} 同号异写法去重 + 分组：号 ${p.appnos.length}(期望1) / 名称 ${p.names.length}(期望2) / 申请人 ${p.applicants.length}(期望1)`);
  console.log(describePlan(p));
  const warnCase = classify('202422940446');
  const okWarn = !!warnCase.warn;
  if (okWarn) pass++; else fail++;
  console.log(`${okWarn ? '✅' : '❌'} 12 位告警已触发：${warnCase.warn || '(无)'}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) cli();
