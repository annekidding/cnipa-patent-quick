#!/usr/bin/env node
/**
 * 第 1 步：**按识别结果检索** → rows.json（待采集清单）
 *
 * ★ 2026-09-18 新增：本脚本自带**输入类型识别**（前置第 0 步）。
 *   用户给什么就查什么，不用自己选参数：
 *     「2024229404464」            → 按专利号逐号检索
 *     「一种分切机」                → 按专利名称检索（精确相等过滤）
 *     「江西创导动物保健品有限公司」 → 按申请人检索（段相等，覆盖共同申请人）
 *   也可显式写 `--as 专利号|名称|申请人` 覆盖识别结果。
 *
 * 用法:
 *   <node> cnipa-quick-search.mjs --input "2024229404464"
 *   <node> cnipa-quick-search.mjs --input "一种分切机" --input "江西创导动物保健品有限公司"
 *   <node> cnipa-quick-search.mjs --input-file 清单.txt          # 一行一条，可混类型，# 注释
 *   <node> cnipa-quick-search.mjs --appno-file 号码.txt          # 等价，明确只当号码
 *   <node> cnipa-quick-search.mjs --name "<精确名称>" --as 名称
 *   <node> cnipa-quick-search.mjs --applicant "<精确申请人>" --as 申请人
 *        [--types 1,2,3] [--size 500] [--out rows.json]
 *        [--name-mode exact|contains] [--applicant-mode part|full]
 *
 * 输出 rows.json：[{ appno, name, applicant, date, status, lawStatus, type, typeName,
 *                    found, matchType, matchValue }]
 *   found=false 的行 = 检索不到（号错/未公开），仍保留，交付表里标「未查到」，**不静默丢行**。
 *   同号去重（不同写法归一后是同一个号，只留首次出现）。
 *
 * 行序：
 *   - 按专利号输入 → **原样保留用户给的顺序**
 *   - 按名称/申请人输入 → **确定性排序**（申请日 新→旧，同日按申请号 大→小），
 *     因为 cpquery 对同一申请日的多件返回顺序不稳定，不排序跨天重跑行序会变。
 *
 * 依赖: CDP 代理 http://127.0.0.1:3456 已就绪，cpquery 列表页标签已登录。
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { evalJs, findOrOpenTab } from './cnipa-quick-cdp.mjs';
import { buildPlan, describePlan, normNo, normText, KIND_LABEL } from './cnipa-quick-input.mjs';

const B = 'http://127.0.0.1:3456';
const argv = process.argv.slice(2);
const VALUED = ['--input', '--input-file', '--appno', '--appno-file', '--name', '--applicant',
  '--as', '--types', '--size', '--out', '--applicant-mode', '--name-mode'];
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const allOf = (n) => {
  const out = [];
  argv.forEach((a, i) => { if (a === '--' + n && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]); });
  return out;
};
const TYPES = opt('types', '1,2,3');
const SIZE = parseInt(opt('size', '500'), 10);   // 默认 500：size 开到 5000 偶发读到 0 条
const OUT = opt('out', 'rows.json');
const APPL_MODE = opt('applicant-mode', 'part');
const NAME_MODE = opt('name-mode', 'exact');

const AS_MAP = { 号: 'appno', 专利号: 'appno', appno: 'appno', 名称: 'name', 专利名称: 'name', name: 'name',
  申请人: 'applicant', applicant: 'applicant', auto: 'auto', 自动: 'auto' };
const AS_RAW = String(opt('as', 'auto')).trim();
const FORCE = AS_MAP[AS_RAW] || AS_MAP[AS_RAW.toLowerCase()] || null;
if (!FORCE) { console.error(`✗ --as 只接受 专利号|名称|申请人|auto，当前 ${AS_RAW}`); process.exit(2); }

const TYPE_NAME = { 1: '发明', 2: '实用新型', 3: '外观设计' };
const SE = `document.querySelector('.q-pagination').__vue__.$parent.$parent`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 收集输入 ────────────────────────────────────────────────────── */
const inputs = [...allOf('input')];
const readLines = (file, label) => {
  const p = resolve(process.cwd(), file);
  if (!existsSync(p)) { console.error(`[输入] 找不到 ${label} ${p}`); process.exit(1); }
  return readFileSync(p, 'utf8').split(/\r?\n/)
    .map((l) => l.replace(/^\s*#.*$/, '').trim()).filter(Boolean);
};
const FILE_IN = opt('input-file', '');
if (FILE_IN) inputs.push(...readLines(FILE_IN, '--input-file'));

// 显式参数：绕过识别，直接指定类型
const EXPLICIT = [];
const APPNO_ONE = opt('appno', '');
const APPNO_FILE = opt('appno-file', '');
const NAME_ARG = opt('name', '');
const APPL_ARG = opt('applicant', '');
if (APPNO_ONE) {
  if (/[,，\s;；]/.test(APPNO_ONE)) {
    console.error('✗ --appno 不接受多号（cpquery 不支持批量检索）。');
    console.error('  请改用 --input-file 号码.txt（每行一个）或 --input "…" 逐个给。');
    process.exit(2);
  }
  EXPLICIT.push({ kind: 'appno', value: normNo(APPNO_ONE), raw: APPNO_ONE, reason: '--appno 显式指定', confidence: 'high' });
}
if (APPNO_FILE) readLines(APPNO_FILE, '--appno-file').forEach((s) => EXPLICIT.push({ kind: 'appno', value: normNo(s), raw: s, reason: '--appno-file 显式指定', confidence: 'high' }));
if (NAME_ARG) EXPLICIT.push({ kind: 'name', value: NAME_ARG, raw: NAME_ARG, reason: '--name 显式指定', confidence: 'high' });
if (APPL_ARG) EXPLICIT.push({ kind: 'applicant', value: APPL_ARG, raw: APPL_ARG, reason: '--applicant 显式指定', confidence: 'high' });

if (!inputs.length && !EXPLICIT.length) {
  console.error('用法：--input "<任意输入>"（可重复）/ --input-file 清单.txt');
  console.error('      或显式 --appno / --appno-file / --name / --applicant');
  console.error('      先跑 cnipa-quick-input.mjs --self-test 可离线查看识别规则');
  process.exit(1);
}

// 识别 → 查询计划（显式参数在前；--as 只作用于自动识别的那部分）
const autoPlan = inputs.length ? buildPlan(inputs, { force: FORCE || 'auto' }) : { items: [], appnos: [], names: [], applicants: [], warns: [] };
const ordered = [...EXPLICIT, ...autoPlan.items];

/* ── 主流程 ──────────────────────────────────────────────────────── */
(async () => {
  console.log(describePlan({ ...autoPlan, items: ordered }));
  if (autoPlan.warns.length) autoPlan.warns.forEach((w) => console.log('   ⚠️ ' + w));
  if (!ordered.length) { console.error('[中止] 没有有效输入'); process.exit(1); }

  let h = null;
  for (let i = 0; i < 8; i++) {
    try { h = await (await fetch(B + '/health', { signal: AbortSignal.timeout(6000) })).json(); if (h && h.status === 'ok') break; } catch { /* retry */ }
    await sleep(1500);
  }
  if (!h) { console.error('[前置] 代理未就绪，请先跑 bsk-cdp-shim.mjs --keep-session'); process.exit(2); }

  const first = ordered[0];
  const smokeBody = first.kind === 'appno' ? { page: 1, size: 1, zhuanlisqh: first.value }
    : first.kind === 'name' ? { page: 1, size: 1, zhuanlimc: first.value }
      : { page: 1, size: 1, shenqingrxm: first.value };
  const got = await findOrOpenTab(B, smokeBody, 'search');
  if (!got) {
    console.error('[前置] 找不到可用的 cpquery 列表页标签（chinesepatent/index），请确认已登录 CNIPA');
    process.exit(2);
  }
  const id = got.targetId;

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const ok = await evalJs(B, id, `(() => { try { const se=${SE}; return typeof se.getList === 'function' && !!se.params; } catch(e){ return false; } })()`).catch(() => false);
    if (ok) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) console.log('[初始化] ⚠️ 60s 内未等到查询组件就绪，仍尝试驱动');

  /** 发查询：清空残留条件 → 设本次条件 → getList */
  const doQuery = (extra, page = 1) => evalJs(B, id, `(() => { const se=${SE};
    se.dataList=[]; se.total=0;
    const keep=['zhuanlilx','page','size','sortDataName','sortType'];
    const skipped=[];
    Object.keys(se.params).forEach(k=>{ if(keep.includes(k)) return;
      const v=se.params[k];
      if(typeof v==='string') se.params[k]='';
      else if(Array.isArray(v)) se.params[k]=[];
      else if(v!==undefined&&v!==null&&v!=='') skipped.push(k);
    });
    Object.assign(se.params, ${JSON.stringify(extra)});
    se.params.page=${page}; se.params.size=${SIZE};
    se.sortDataName && (se.params.sortDataName='');
    se.getList();
    return { params: JSON.parse(JSON.stringify(se.params)), skipped }; })()`);

  const readRows = () => evalJs(B, id, `(() => { const se=${SE}; const d=se.dataList||[];
    return { total: se.total, maxPage: se.maxPage, len: d.length,
      rows: d.map(r=>({ appno:r.zhuanlisqh, name:r.zhuanlimc, applicant:r.shenqingrxm,
                        date:r.shenqingr, status:r.anjianywzt, lawStatus:r.falvzt,
                        type:r.zhuanlilx })) }; })()`);

  const waitRows = async () => {
    for (let i = 0; i < 50; i++) {
      const r = await evalJs(B, id, `(() => { const se=${SE}; const d=se.dataList||[]; return { len:d.length }; })()`).catch(() => null);
      if (r && r.len > 0) return true;
      await sleep(400);
    }
    return false;
  };

  const wantedTypes = TYPES ? String(TYPES).split(',').map((s) => s.trim()) : null;
  const keepType = (t) => !wantedTypes || wantedTypes.length === 0 || wantedTypes.includes(String(t));

  const rows = [];
  const seen = new Set();

  /** 模式 A：按专利号逐号检索 */
  const queryOneNo = async (qRaw, rawLabel) => {
    const q = normNo(qRaw);
    const init = await doQuery({ zhuanlisqh: q, zhuanlilx: '' }, 1);
    if (init && init.skipped && init.skipped.length) console.log(`  ⚠️ 残留条件未能清空: ${init.skipped.join(',')} —— 请在页面上手动清空后重跑`);
    await waitRows();
    let r = await readRows();
    if (!r || !r.total) {                                   // 首查 0 条 → 重发一次（组件 bootstrap 竞态）
      await doQuery({ zhuanlisqh: q, zhuanlilx: '' }, 1);
      await waitRows();
      r = await readRows();
    }
    const hit = (r && r.rows || []).find((x) => x.appno === q || normNo(x.appno) === q);
    if (hit) {
      console.log(`  ${rawLabel} ✅ ${hit.status} | ${hit.name}`);
      return { ...hit, found: true, matchType: 'appno', matchValue: normNo(rawLabel) };
    }
    console.log(`  ${rawLabel} ✗ 检索无此号`);
    return { appno: q, name: '', applicant: '', date: '', status: '未查到', lawStatus: '', type: '', found: false, matchType: 'appno', matchValue: q };
  };

  /** 模式 B/C：按名称或申请人检索（检索 + 翻页 + 精确过滤 + 确定性排序） */
  const queryByKeyword = async (kind, kw) => {
    const isName = kind === 'name';
    const paramKey = isName ? 'zhuanlimc' : 'shenqingrxm';
    const init = await doQuery({ [paramKey]: kw, zhuanlilx: '' }, 1);
    if (init && init.skipped && init.skipped.length) console.log(`  ⚠️ 残留条件未能清空: ${init.skipped.join(',')}`);
    await waitRows();
    let meta = await readRows();
    if (!meta || !meta.total) {
      await doQuery({ [paramKey]: kw, zhuanlilx: '' }, 1);
      await waitRows();
      meta = await readRows();
    }
    const maxPage = (meta && meta.maxPage) || 1;
    console.log(`  [元信息] total=${(meta || {}).total || 0} maxPage=${maxPage} 本页 ${(meta || {}).len || 0}`);

    const all = [];
    const collect = (r) => (r && r.rows || []).forEach((x) => all.push(x));
    collect(meta);
    for (let p = 2; p <= maxPage; p++) {
      await evalJs(B, id, `(() => { const se=${SE}; se.__wbPrev=(se.dataList&&se.dataList[0])?se.dataList[0].zhuanlisqh:'';
        se.params.page=${p}; se.params.size=${SIZE}; se.getList(); return 1; })()`);
      let changed = false;
      for (let w = 0; w < 25; w++) {
        const cur = await evalJs(B, id, `(() => { const se=${SE}; const d=se.dataList||[];
          return { first:d[0]?d[0].zhuanlisqh:'', prev:se.__wbPrev||'' }; })()`).catch(() => null);
        if (cur && cur.first && cur.first !== cur.prev) { changed = true; break; }
        await sleep(400);
      }
      if (!changed) console.log(`  ⚠️ 第${p}页 首行未变化，仍尝试读取`);
      collect(await readRows());
      console.log(`  [第${p}/${maxPage}页] 累计 ${all.length}`);
    }

    // 精确过滤
    const nkw = normText(kw);
    const out = []; let dropped = 0;
    for (const x of all) {
      if (!keepType(x.type)) { dropped++; continue; }
      let hit;
      if (isName) hit = NAME_MODE === 'contains' ? normText(x.name).includes(nkw) : normText(x.name) === nkw;
      else {
        const parts = String(x.applicant || '').split(/[,，;；]/).map(normText).filter(Boolean);
        hit = APPL_MODE === 'full' ? normText(x.applicant) === nkw : parts.includes(nkw);
      }
      if (hit) out.push({ ...x, found: true, matchType: kind, matchValue: kw }); else dropped++;
    }
    // 行序稳定化：申请日 新→旧，同日按申请号 大→小
    out.sort((x, y) => {
      const dx = String(x.date || ''), dy = String(y.date || '');
      return dx !== dy ? dy.localeCompare(dx) : String(y.appno || '').localeCompare(String(x.appno || ''));
    });
    console.log(`  [精确过滤] 命中 ${all.length} 行 → 匹配 ${out.length} 条（剔除 ${dropped} 条：类型不符 或 ${isName ? '名称' : '申请人'}不是完全相等）`);
    if (!out.length) {
      console.log(`  ⚠️ 0 条。${isName
        ? '若这是个人/单位名，可改按申请人查：加 `--as 申请人`；若只是名称片段，可加 `--name-mode contains`'
        : '可试 `--applicant-mode full`（默认 part 已覆盖共同申请人），或核对申请人全称写法'}`);
    }
    return out;
  };

  /* 按用户给的顺序逐条处理；同号只留首次出现 */
  const pushRows = (list) => {
    for (const r of list) {
      const k = normNo(r.appno);
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      rows.push(r);
    }
  };

  let i = 0;
  for (const it of ordered) {
    i++;
    if (it.kind === 'appno') {
      console.log(`[${i}/${ordered.length}] 专利号 → ${it.value}`);
      pushRows([await queryOneNo(it.value, it.raw)]);
    } else if (it.kind === 'name') {
      console.log(`[${i}/${ordered.length}] 专利名称 → ${it.value}（${NAME_MODE === 'contains' ? '包含' : '精确相等'}匹配）`);
      pushRows(await queryByKeyword('name', it.value));
    } else {
      console.log(`[${i}/${ordered.length}] 申请人 → ${it.value}（${APPL_MODE === 'full' ? '整字段' : '段'}相等匹配）`);
      pushRows(await queryByKeyword('applicant', it.value));
    }
  }

  rows.forEach((r) => { r.typeName = TYPE_NAME[String(r.type)] || (r.type ? `类型${r.type}` : ''); if (r.found === undefined) r.found = true; });

  const byType = {};
  rows.forEach((r) => { const k = r.typeName || '(未知)'; byType[k] = (byType[k] || 0) + 1; });
  const byMatch = {};
  rows.forEach((r) => { const k = KIND_LABEL[r.matchType] || r.matchType || '(未知)'; byMatch[k] = (byMatch[k] || 0) + 1; });
  const notFound = rows.filter((r) => !r.found).length;

  writeFileSync(resolve(process.cwd(), OUT), JSON.stringify(rows, null, 1), 'utf8');
  console.log(`\n[完成] ${rows.length} 条${notFound ? `（其中检索不到 ${notFound} 条，交付表标「未查到」）` : ''}`);
  console.log('[来源分布]', JSON.stringify(byMatch));
  console.log('[类型分布]', JSON.stringify(byType));
  console.log('[已写入]', resolve(process.cwd(), OUT));
  console.log('\n下一步：<node> cnipa-quick-detail.mjs rows.json');
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
