#!/usr/bin/env node
/**
 * 第 2 步：逐号采集 → quick-detail.json
 *
 * ★ 速查版的核心特征：**每号只发 2 次请求**
 *     1. POST /api/view/gn/sqxx  → 专利名称 zhuanlimc、案件状态 anjianywzt、专利类型 zhuanlilx（申请日兜底）
 *     2. POST /api/view/gn/fyxx  → 应缴年费 yingjiaofei.svYingjfList[]、滞纳金明细 zhinajin.svZnjList[]
 *   不查分案 / 通知书 / 质押 / 许可 / 变更费 —— 这四类只有档案版（cnipa-patent-dossier）才需要，
 *   速查版四列里用不到，砍掉后请求数从「每号 5~6 次」降到 2 次。
 *
 * ★ 唯一一处「少发一次请求」：**实用新型 + 案件状态「未缴年费专利权终止，等恢复」**
 *   → 按口径年费列写「等恢复·按口径未取年费」，所以 **fyxx 根本不发**（真正省下这一次）。
 *   （档案版必须照发，因为「一年内是否交过变更费」与年费共用 fyxx；速查版没有变更费列。）
 *   `--force-fee` 可强制照发、照出年费。
 *   ⚠️ 判定依据是**检索行**的案件状态（第 1 步 rows.json 里的 status）：因为要在发请求**之前**决定。
 *     若检索行与详情不一致，出表时会如实写成「数据缺口(检索状态与详情不一致)」，不会静默糊过去。
 *
 * 用法:
 *   <node> cnipa-quick-detail.mjs [rows.json] [--out quick-detail.json]
 *        [--gap MS=2000] [--batch N=4] [--batch-gap MS=1500]
 *        [--cooldown SEC=60] [--short-rounds N=2] [--ban-wait SEC=300]
 *        [--max-waits N=4] [--max-min M=120] [--limit M] [--fresh] [--retry N=2]
 *        [--no-fee] [--force-fee]
 *
 * ★ 节奏默认值（沿用档案版实测结论，别乱改）:
 *   gap 2000 / batch 4 / batch-gap 1500 =「中节奏」，100 件以内稳态 0 限流。
 *   撞过限流再降：--gap 3000 --batch 3 --batch-gap 2500 --cooldown 90。
 *
 * ★ 请求内即时重发（--retry N=2）：只对 HTTP 0 / -1 / 404 / 5xx 这类瞬时失败当场补发；
 *   **400（限流）与 401（令牌失效）绝不补发** —— 真限流时不会多打任何请求。
 *
 * ★ 落盘与续抓：每批成功即写盘，重跑自动跳过已成功项（--fresh 强制重抓）。
 *   detail 文件按**号**复用，因此换批次跑请换工作目录或改 --out；
 *   检测到文件里有本批以外的号时，会自动备份为 `<name>.bak.json` 再从空白开始。
 *
 * 依赖: CDP 代理 http://127.0.0.1:3456 已就绪，且**列表页**标签（chinesepatent/index）已登录。
 *       ⚠️ 只能在列表页发这些请求 —— 详情页的 axios 会在 URL 上加一次性签名，裸 XHR 过不了。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { evalJs, probeJs, findOrOpenTab } from './cnipa-quick-cdp.mjs';

const B = 'http://127.0.0.1:3456';
const argv = process.argv.slice(2);
const VALUED = ['--gap', '--batch', '--batch-gap', '--cooldown', '--short-rounds', '--ban-wait',
  '--max-waits', '--max-min', '--limit', '--out', '--retry'];
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const IN = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(argv[i - 1]))) || 'rows.json';
const GAP = Math.max(0, parseInt(opt('gap', '2000'), 10));
const BATCH = Math.max(1, parseInt(opt('batch', '4'), 10));
const BATCH_GAP = Math.max(0, parseInt(opt('batch-gap', '1500'), 10));
const COOLDOWN = Math.max(0, parseInt(opt('cooldown', '60'), 10));
const SHORT_ROUNDS = Math.max(0, parseInt(opt('short-rounds', '2'), 10));
const BAN_WAIT = Math.max(5, parseInt(opt('ban-wait', '300'), 10));
const MAX_WAITS = Math.max(0, parseInt(opt('max-waits', '4'), 10));
const MAX_MIN = Math.max(1, parseInt(opt('max-min', '120'), 10));
const LIMIT = parseInt(opt('limit', '0'), 10);
const RETRY = Math.max(1, parseInt(opt('retry', '2'), 10));
const OUT = opt('out', 'quick-detail.json');
const FRESH = argv.includes('--fresh');
const NO_FEE = argv.includes('--no-fee');
const FORCE_FEE = argv.includes('--force-fee');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面内取数：按 items([{a,f}]) 顺序执行，请求间 gap 忙等限速
 *  f=1 → 该号额外发一次 fyxx（费用）；f=0 → 只发 sqxx（真正省一次请求） */
const batchJs = (items, gapMs, retry) => `(function(items, gap, TRIES){
  var t=localStorage.getItem('ACCESS_TOKEN'), ut=localStorage.getItem('USER_TYPE');
  if(!t) return { __noToken:true };
  function wait(g){ if(g>0){ var e=Date.now()+g; while(Date.now()<e){} } }
  function firstList(o){
    if(!o||typeof o!=='object') return [];
    if(Array.isArray(o)) return o;
    for(var k in o){ if(Array.isArray(o[k])) return o[k]; }
    return [];
  }
  function call(path, body){
    var x=new XMLHttpRequest(); x.open('POST', path, false);
    x.setRequestHeader('Content-Type','application/json;charset=utf-8');
    x.setRequestHeader('Authorization','Bearer '+t);
    if(ut) x.setRequestHeader('userType', ut);
    try{ x.send(JSON.stringify(body)); }catch(e){ return { __status:-1, __err:String(e.message) }; }
    if(x.status!==200) return { __status:x.status };
    try{ return { __status:200, body:JSON.parse(x.responseText) }; }
    catch(e){ return { __status:200, __parseErr:String(x.responseText||'').slice(0,200) }; }
  }
  var retryN=0;
  function isTransient(st){ return st===0 || st===-1 || st===404 || (st>=500 && st<=599); }
  function callR(path, body){
    var r=call(path, body), n=0;
    while(n < TRIES-1 && isTransient(r.__status)){ retryN++; n++; wait(gap); r=call(path, body); }
    if(n) r.__retry=n;
    return r;
  }
  var recs={};
  items.forEach(function(it){
    var a=it.a, rec={};
    // ① 申请信息 → 专利名称 / 案件状态 / 专利类型
    var sq=callR('/api/view/gn/sqxx',{zhuanlisqh:a}); wait(gap);
    rec.sqStatus=sq.__status;
    // ★ 业务码 ≠ HTTP 码：HTTP 200 但 body.code=20101 → 「著录项目信息不存在」（号不在公开库）
    try{ var bc=(sq.body||{}).code; if(bc && bc!==200){ rec.sqBizCode=bc; rec.sqBizMsg=(sq.body||{}).msg||''; } }catch(e){}
    try{
      var zl=(((sq||{}).body||{}).data||{}).zhuluxmxx||{};
      zl=zl.zhuluxmxx||{};
      rec.zhuanlimc=zl.zhuanlimc||'';
      rec.anjianywzt=zl.anjianywzt||'';
      rec.falvzt=zl.falvzt||'';
      rec.zhuanlilx=zl.zhuanlilx||'';
      rec.shenqingr=zl.shenqingr||'';                 // ⚠️ 是「申请日」不是申请人
      var srl=((((sq||{}).body||{}).data||{}).shenqingren||{}).shenqingrenList||[];
      rec.shenqingrxm=srl.map(function(x){ return x.shenqingrxm||''; }).filter(Boolean).join(',');
      if(sq.__err) rec.sqErr=sq.__err;
    }catch(e){ rec.sqErr=String(e.message); }
    // ② 费用 → 应缴年费 + 滞纳金明细（f=0 时整段跳过，省一次请求）
    if(it.f){
      var fy=callR('/api/view/gn/fyxx',{zhuanlisqh:a}); wait(gap);
      rec.fyStatus=fy.__status;
      try{
        var d=((fy||{}).body||{}).data||{};
        var yj=(d.yingjiaofei||{}).svYingjfList||[];
        rec.yingjiao=yj.map(function(x){ return { zl:x.yingjiaoffyzlmc||'', je:x.yingjiaoje||'', jzr:x.jiaofeijzr||'', zt:x.yingjiaoffyzt||'' }; });
        // 应缴滞纳金明细：nf=当期年费 / sj=缴费时间段 / zn=应缴滞纳金 / zj=总计（年费+滞纳金）
        var znObj=d.zhinajin||{};
        var znl=Array.isArray(znObj.svZnjList)?znObj.svZnjList:(Array.isArray(znObj)?znObj:firstList(znObj));
        rec.zhinajin=znl.map(function(x){ return { nf:x.zhinajdqnfje||'', sj:x.zhinajjfsj||'', zn:x.zhinajyjznje||'', zj:x.zhinajzj||'' }; });
        rec.zhinajinN=znl.length;
      }catch(e){ rec.fyErr=String(e.message); }
      if(fy.__status!==200) rec.fyErr=rec.fyErr||('HTTP '+fy.__status);
    }
    recs[a]=rec;
  });
  return { recs:recs, retries:retryN };
})(${JSON.stringify(items)}, ${gapMs}, ${retry})`;

/** 取到了吗：sqxx 必须 200；发了 fyxx 的还要 fyStatus 200 且 zhinajin 是数组 */
const isOk = (rec, needF) => !!rec && rec.sqStatus === 200
  && (!needF || (rec.fyStatus === 200 && Array.isArray(rec.zhinajin)));

/** 「未缴年费专利权终止，等恢复」判定（实用新型在此状态下按口径不取年费） */
const isRecovery = (status) => /未缴年费专利权终止/.test(String(status || '')) && /等恢复/.test(String(status || ''));
const isUtility = (typeName) => /实用新型/.test(String(typeName || ''));

(async () => {
  const inPath = resolve(process.cwd(), IN);
  const outPath = resolve(process.cwd(), OUT);
  if (!existsSync(inPath)) { console.error(`[输入] 找不到 ${inPath}（请先跑第 1 步检索）`); process.exit(1); }
  let rows = JSON.parse(readFileSync(inPath, 'utf8'));
  if (!Array.isArray(rows)) { console.error(`[输入] ${IN} 不是数组，应为第 1 步产出的 rows.json`); process.exit(1); }
  if (LIMIT > 0) rows = rows.slice(0, LIMIT);

  const items = rows.filter((r) => r && r.appno).map((r) => {
    const typeName = r.typeName || ({ 1: '发明', 2: '实用新型', 3: '外观设计' }[String(r.type)] || '');
    const recovery = isRecovery(r.status);
    const f = !NO_FEE && !(isUtility(typeName) && recovery && !FORCE_FEE);
    return { a: r.appno, f: f ? 1 : 0, _type: typeName, _recovery: recovery, _skipFee: NO_FEE, _skipAnnual: !f };
  });
  const needOf = {};
  items.forEach((x) => { needOf[x.a] = !!x.f; });

  const appnos = items.map((x) => x.a);
  const feeN = items.filter((x) => x.f).length;
  const skipped = items.filter((x) => !x.f && !NO_FEE).length;
  console.log(`[输入] ${IN} 共 ${appnos.length} 个申请号`);
  console.log(`[请求计划] 每号 2 次（sqxx + fyxx）→ 本次约 ${appnos.length + feeN} 次`
    + (skipped ? `\n          其中 ${skipped} 个（实用新型＋「未缴年费专利权终止，等恢复」）**只发 sqxx，省掉 fyxx**，年费列按口径写「等恢复·按口径未取年费」` : '')
    + (NO_FEE ? '\n          --no-fee：全部只发 sqxx' : ''));
  console.log(`[节奏] 间隔 ${GAP}ms，批大小 ${BATCH}，批间隔 ${BATCH_GAP}ms`);
  console.log(`[重发] 接口失败当场重发，最多 ${RETRY} 次（只对 404/5xx/-1 等瞬时失败；限流 400 与 401 不重发）`);
  if (!appnos.length) { writeFileSync(outPath, '{}', 'utf8'); console.log('[输出] 空清单'); return; }

  let h = null;
  for (let i = 0; i < 5; i++) {
    try { h = await (await fetch(B + '/health', { signal: AbortSignal.timeout(6000) })).json(); if (h && h.status === 'ok') break; } catch { /* retry */ }
    await sleep(1500);
  }
  if (!h) { console.error('[前置] 代理未就绪，请先跑 bsk-cdp-shim.mjs --keep-session'); process.exit(2); }

  const smokeBody = { zhuanlisqh: String(appnos[0] || '').replace(/[^0-9A-Za-z.]/g, '') };
  const got = await findOrOpenTab(B, smokeBody, 'detail');
  if (!got) { console.error('[前置] 找不到可用的 cpquery 列表页标签'); process.exit(2); }
  const id = got.targetId;
  let probe = got.probe;
  for (let i = 0; i < 3; i++) {
    probe = await evalJs(B, id, probeJs(smokeBody.zhuanlisqh));
    console.log(`[探针 ${i + 1}/3]`, JSON.stringify(probe));
    if (probe && (probe.status === 200 || probe.status === -1)) break;
    await sleep(2500);
  }

  let detail = {};
  if (!FRESH && existsSync(outPath)) {
    try { const old = JSON.parse(readFileSync(outPath, 'utf8')); if (old && typeof old === 'object' && !Array.isArray(old)) detail = old; } catch { /* ignore */ }
  }
  // detail 按「号」复用、不认批次：含本批以外的号 → 备份后从空白开始（不删数据、也不静默混用）
  if (Object.keys(detail).length) {
    const cur = new Set(appnos);
    const foreign = Object.keys(detail).filter((k) => !cur.has(k));
    if (foreign.length) {
      const bak = outPath.replace(/\.json$/i, '') + '.bak.json';
      let saved = false;
      try { writeFileSync(bak, JSON.stringify(detail, null, 1), 'utf8'); saved = true; } catch { /* ignore */ }
      console.warn(`[续抓] ⚠️ ${OUT} 里有 ${foreign.length} 个不属于本批的号（多为在同一目录跑过别的批次）`);
      console.warn(`       ${saved ? `已备份为 ${bak}` : '备份失败'}，本批从空白开始，避免计数虚高与数据混用`);
      detail = {};
    }
  }

  const pending0 = appnos.filter((a) => !isOk(detail[a], needOf[a]));
  if (appnos.length - pending0.length) console.log(`[续抓] 复用已成功的 ${appnos.length - pending0.length} 个，待抓 ${pending0.length} 个`);

  if (!probe || probe.status !== 200) {
    const why = probe && probe.status === 400 ? '400 = 接口限流冷却中（响应体只有空行），等 3~5 分钟重跑即可，令牌与登录态通常仍是好的'
      : probe && probe.status === 401 ? '401 = 令牌过期，请重新登录 CNIPA（要登在 bsk 的 Agent Window 里）'
        : probe && probe.status === -1 ? '-1 = 该标签页请求层已坏且换新标签也没恢复（站点侧风控升级），等几分钟再试'
          : `连续多次未 200（最后 ${probe && probe.status}）`;
    console.error('[前置] 试探请求未通过：' + why);
    process.exit(2);
  }

  const t0 = Date.now();
  let banWaits = 0, softRounds = 0, reqs = 0, retriesAll = 0, fatal = false;
  let pending = pending0.slice();

  while (pending.length) {
    if ((Date.now() - t0) / 60000 > MAX_MIN) {
      console.log(`[停] 已运行超过 ${MAX_MIN} 分钟，主动收工。已抓的已写入 ${OUT}，重跑自动续抓。`);
      break;
    }
    const todo = pending.slice();
    let banned = false;
    for (let i = 0; i < todo.length; i += BATCH) {
      const slice = todo.slice(i, i + BATCH);
      const r = await evalJs(B, id, batchJs(slice.map((a) => ({ a, f: needOf[a] ? 1 : 0 })), GAP, RETRY));
      if (!r || r.__error) { console.error(`  [eval 失败] ${JSON.stringify(r).slice(0, 160)} → 本批留待下轮`); break; }
      if (r.__noToken) { console.error('[中断] 页面令牌消失，登录态可能失效'); process.exit(2); }
      const recs = r.recs || {};

      reqs += slice.reduce((n, a) => n + 1 + (needOf[a] ? 1 : 0), 0);
      let okInBatch = 0;
      for (const a of slice) {
        const rec = recs[a];
        if (isOk(rec, needOf[a])) { detail[a] = rec; okInBatch++; }
        else if (!isOk(detail[a], needOf[a])) detail[a] = rec || { sqStatus: null };
      }
      writeFileSync(outPath, JSON.stringify(detail, null, 1), 'utf8');

      const done = Math.min(i + BATCH, todo.length);
      const okTotal = appnos.filter((a) => isOk(detail[a], needOf[a])).length;
      const rt = r.retries || 0;
      if (rt) retriesAll += rt;
      console.log(`[${done}/${todo.length}] 累计成功 ${okTotal}/${appnos.length} | 本批 ${okInBatch}/${slice.length}`
        + `${rt ? `（请求内重发 ${rt} 次）` : ''}`);

      const sqSt = slice.map((a) => (detail[a] || {}).sqStatus);
      const sqOk = sqSt.filter((s) => s === 200).length;
      if (sqOk === 0 && slice.length) {
        const uniq = [...new Set(sqSt)].join('/');
        if (sqSt.some((s) => s === 401)) {
          console.log(`  ⛔ 本批 sqxx 全部失败（状态 ${uniq}）—— 令牌已失效，立即中止；请重新登录 CNIPA 后重跑`);
          fatal = true; break;
        }
        if (sqSt.some((s) => s === 400 || s === 429)) {
          banned = true;
          console.log(`  ⚠️ 本批 sqxx 全部失败（状态 ${uniq}）—— 限流特征，立即中止本轮，不再发任何请求`);
          break;
        }
        console.log(`  ⚠️ 本批 sqxx 全部失败（状态 ${uniq}）—— 非限流（瞬时故障或号本身问题），本轮结束，转短冷却软重试`);
        break;
      }
      if (i + BATCH < todo.length && BATCH_GAP) await sleep(BATCH_GAP);
    }

    pending = todo.filter((a) => !isOk(detail[a], needOf[a]));
    if (!pending.length) break;
    if (fatal) break;

    if (banned) {
      banWaits++;
      if (banWaits > MAX_WAITS) { console.log(`[停] 已用满 ${MAX_WAITS} 次长冷却仍被限流，先收工；重跑同一条命令自动续抓。`); break; }
      const wait = BAN_WAIT * banWaits;
      console.log(`[限流冷却 ${banWaits}/${MAX_WAITS}] 静默等 ${wait}s 后单发探针…`);
      await sleep(wait * 1000);
      const p = await evalJs(B, id, probeJs(pending[0]));
      console.log('  [探针]', JSON.stringify(p));
      if (p && p.status === 200) console.log('  ✅ 限流已解除，继续'); else console.log('  ✗ 仍在限流，下轮加长冷却');
    } else {
      softRounds++;
      if (softRounds > SHORT_ROUNDS) { console.log(`[停] 软重试 ${SHORT_ROUNDS} 轮后仍有 ${pending.length} 个未成功，已写入 ${OUT}`); break; }
      const wait = COOLDOWN * softRounds;
      console.log(`[软重试 ${softRounds}/${SHORT_ROUNDS}] 待补 ${pending.length} 个，冷却 ${wait}s…`);
      await sleep(wait * 1000);
    }
  }

  // 回写类型/口径标记，供出表脚本识别
  items.forEach((x) => {
    if (detail[x.a]) {
      detail[x.a]._type = x._type;
      detail[x.a]._recovery = x._recovery;
      detail[x.a]._skipFee = x._skipFee;         // 压根没发 fyxx（--no-fee）
      detail[x.a]._skipAnnual = x._skipAnnual;   // 按口径不取年费（实用新型＋等恢复）
    }
  });

  writeFileSync(outPath, JSON.stringify(detail, null, 1), 'utf8');
  const okList = appnos.filter((a) => isOk(detail[a], needOf[a]));
  const bad = appnos.filter((a) => !isOk(detail[a], needOf[a]));
  const badCat = { sqDown: [], partMiss: [] };
  for (const a of bad) {
    const d = detail[a] || {};
    if (d.sqStatus !== 200) badCat.sqDown.push({ a, st: d.sqStatus }); else badCat.partMiss.push(a);
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[完成] 成功 ${okList.length} / 未完成 ${bad.length}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，约 ${reqs} 次请求`
    + `${retriesAll ? ` + 请求内重发 ${retriesAll} 次` : ''}`);
  console.log(`[完整度] ${appnos.length} 件：${okList.length} 完整  ${bad.length ? `/ ${bad.length} 缺口（sqxx失败 ${badCat.sqDown.length} · 费用接口缺失 ${badCat.partMiss.length}）` : '✅ 0 数据缺口'}`);
  if (badCat.partMiss.length) console.log(`  ↳ 续抓可补（重跑同一条命令）: ${badCat.partMiss.join(' ')}`);
  if (badCat.sqDown.length) {
    const sts = [...new Set(badCat.sqDown.map((x) => x.st))].map((s) => (s == null ? '?' : s)).join('/');
    const hint = sts.includes('401') ? '令牌失效，重新登录 CNIPA 后重跑'
      : sts.includes('400') ? '接口限流，等 3~5 分钟重跑即可'
        : '瞬时故障或号本身问题，等几分钟重跑';
    console.log(`  ↳ sqxx 失败 [HTTP ${sts}]（${hint}）: ${badCat.sqDown.map((x) => x.a).join(' ')}`);
  }
  if (bad.length) console.log('[未完成申请号]', bad.join(' '));
  console.log('[已写入]', outPath);
  console.log('\n下一步：<node> cnipa-quick-report.mjs --rows rows.json --detail quick-detail.json --out 专利年费速查.csv');

  console.log('\n[抽样]');
  okList.slice(0, 8).forEach((a) => {
    const d = detail[a] || {};
    console.log(`  ${a} | ${(d.anjianywzt || '').slice(0, 20)} | 年费 ${d._skipAnnual ? '(按口径未取)' : d._skipFee ? '(未取)' : (d.yingjiao || []).length + '条应缴'} | 滞纳金 ${(d.zhinajin || []).length} 段`);
  });
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
