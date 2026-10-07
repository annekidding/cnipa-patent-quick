#!/usr/bin/env node
/**
 * CNIPA 公用 CDP 通信层（2026-09-16 P1-5 抽出，合并 search 与 detail 的重复逻辑）
 *
 * 提供 6 件事，search 和 detail 都用：
 *   - evalJs(id, js)      在指定 CDP 标签里跑一段 JS，返回 eval 的 value
 *   - smokeJs(body)       生成 1 条 cpquery 请求（HTTP 200 优先 / 400=限流）
 *   - probeJs()           生成 3 次连发探针，判当前标签请求层是否健康
 *   - findOrOpenTab(B)    找候选标签页（chinesepatent/index）；没有则开一个；
 *                         不健康则开新的重试；最多 3 次。返回 {targetId} 或 null。
 *   - checkLiveSession(B) 判「代理活着但会话已死」的假健康（看 / 的 tabs 数）
 *   - ensureLiveSession(B) 会话陈旧则让 shim /repair 重新握手（★ 2026-09-18）
 *
 * ★ 关键经验（创导+同邦达+所托瑞安多轮实测）：
 *   1. 标签页的请求层会整体坏掉 —— 所有 XHR 被加 ?hHp4Kgam= 签名后 'Failed to load'，
 *      status=-1。重载无效、等待无效；**开一个新标签立刻就好**（登录态共享）。
 *   2. 候选标签取最后一个（最新）；若 pg(.q-pagination) 不存在也视为不健康。
 *   3. 400 = 接口限流（响应体只有空行），并不换标签 —— 这种交给 detail 的限流冷却。
 *   4. ⚠️ **`/health` 返回 ok 不代表会话还在**（它只回显进程自己记的 SID）。
 *      daemon 重启 / Agent Window 被回收后，shim 会「假健康」：`/targets` 恒为 []，
 *      调用方只看到「找不到可用的 cpquery 列表页标签」。★ 真判据 = `/` 的 `tabs > 0`。
 */

const CPQ = 'https://cpquery.cponline.cnipa.gov.cn/chinesepatent/index';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在指定 CDP 标签执行 JS，返回 eval value
 *  ⚠️ 返回值会被 CDP 协议 devalue 处理（普通对象友好；undefined 会被吞） */
export async function evalJs(B, id, js, timeout = 900000) {
  const r = await fetch(B + '/eval?target=' + id, {
    method: 'POST', body: js, signal: AbortSignal.timeout(timeout),
  });
  const t = await r.text();
  let o; try { o = JSON.parse(t); } catch { return { __raw: String(t).slice(0, 400) }; }
  if (o && o.error) return { __error: String(o.error).split('\n')[0].slice(0, 300) };
  return o && o.value !== undefined ? o.value : o;
}

/** 1 条 cpquery 探针：用于 search 时快速判定列表页健康（200=ok / 400=限流 / -1=坏了） */
export function smokeJs(body) {
  return `(()=>{ var t=localStorage.getItem('ACCESS_TOKEN'), ut=localStorage.getItem('USER_TYPE');
    if(!t) return { status:-2 };
    var x=new XMLHttpRequest(); x.open('POST','/api/search/undomestic/publicSearch',false);
    x.setRequestHeader('Content-Type','application/json;charset=utf-8');
    x.setRequestHeader('Authorization','Bearer '+t); if(ut) x.setRequestHeader('userType',ut);
    try{ x.send(${JSON.stringify(JSON.stringify(body))}); return { status:x.status }; }
    catch(e){ return { status:-1, err:String(e.message).slice(0,120) }; } })()`;
}

/** 3 次连发探针：用于 detail 时按 -1 判定标签页请求层是否已坏（2026-09-15 加） */
export function probeJs(appno) {
  return `(function(a){
    var t=localStorage.getItem('ACCESS_TOKEN'), ut=localStorage.getItem('USER_TYPE');
    var out=[];
    for(var i=0;i<3;i++){
      var x=new XMLHttpRequest(); x.open('POST','/api/view/gn/sqxx',false);
      x.setRequestHeader('Content-Type','application/json;charset=utf-8');
      x.setRequestHeader('Authorization','Bearer '+t); if(ut) x.setRequestHeader('userType',ut);
      try{ x.send('{"zhuanlisqh":"'+a+'"}'); out.push(x.status); }
      catch(e){ out.push(-1); }
      var e=Date.now()+1500; while(Date.now()<e){}
    }
    return out.indexOf(200)>=0 ? { status:200, all:out } : { status:out[out.length-1], all:out };
  })(${JSON.stringify(appno)})`;
}

/** 找候选标签页（chinesepatent/index）；没有或不健康则开新标签；最多 3 次
 *  @param B               CDP 代理 base
 *  @param smokeBody       smokeJs 用 body（任意 cpquery POST body；只是触发请求）
 *  @param label           调方标识（"search"/"detail"），仅打印日志用
 *  @returns {targetId, probe, tabsOpened} | null
 *  其中 probe 是用 smoke 探针得到的最后状态：{status:200|-1|400}，供 detail 限流判定 */
export async function findOrOpenTab(B, smokeBody, label = 'cdp') {
  let tabsOpened = 0;
  let repaired = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tabs = await (await fetch(B + '/targets')).json();
    const cands = (tabs || []).filter((x) => x.url && x.url.includes('chinesepatent/index'));
    const tab = cands.length ? cands[cands.length - 1] : null;
    if (tab) {
      const pg = await evalJs(B, tab.targetId, `!!document.querySelector('.q-pagination')`).catch(() => false);
      if (pg) {
        const tk = await evalJs(B, tab.targetId, `({hasToken: !!localStorage.getItem('ACCESS_TOKEN'), userType: localStorage.getItem('USER_TYPE')})`).catch(() => null);
        if (!tk || !tk.hasToken) { console.error(`[${label}] 无 ACCESS_TOKEN，登录态失效，请重新登录 CNIPA`); return null; }
        const s = await evalJs(B, tab.targetId, smokeJs(smokeBody)).catch(() => ({ status: -1 }));
        // status=200=ok; 400=限流（保留原标签，由调用方走冷却）; -1=坏（换标签）
        if (s && s.status === 200) return { targetId: tab.targetId, probe: s, tabsOpened };
        if (s && s.status === 400) return { targetId: tab.targetId, probe: s, tabsOpened };
        console.log(`[${label}] 标签探针失败（status=${s && s.status}）→ 开新标签页重试 ${attempt}/3`);
      }
    } else if (!repaired) {
      // 一条候选都没有：先排除「会话已被 daemon 回收」这一类（★ 2026-09-18）。
      // 这种情况开着新标签也是白开 —— 进程手里的 SID 已经死了。
      repaired = await ensureLiveSession(B, label);
    }
    // 没候选 / 不健康 / 没登录态 → 开新标签（不计 attempt 超次数）
    await fetch(B + '/new', { method: 'POST', body: CPQ });
    tabsOpened++;
    await sleep(15000);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 会话活性（★ 2026-09-18 加）
 * ------------------------------------------------------------------ */

/** 判断「代理活着但会话已死」这类假健康：
 *  - /health 返回 ok **不代表会话还在**（只回显进程自己记的 SID）
 *  - 真判据 = 根路径 / 的 tabs 是否 > 0（tabs=0 且 session 非空 → SID 陈旧）
 *  返回 {ok, tabs, session, why}  */
export async function checkLiveSession(B) {
  let j = null;
  try { j = await (await fetch(B + '/', { signal: AbortSignal.timeout(6000) })).json(); }
  catch (e) { return { ok: false, tabs: 0, why: '代理不可达: ' + (e?.message || e) }; }
  const tabs = typeof j.tabs === 'number' ? j.tabs : 0;
  return { ok: tabs > 0, tabs, session: j.session, why: tabs > 0 ? 'ok' : '会话已陈旧（tabs=0）' };
}

/** 会话陈旧则让 shim 重新握手（复用活会话或新建 + 备好锚标签）。
 *  @returns {boolean} 修复后会话是否可用（已经可用则直接返回 true） */
export async function ensureLiveSession(B, label = 'cdp') {
  const st = await checkLiveSession(B);
  if (st.ok) return true;
  if (st.why && st.why.startsWith('代理不可达')) return false;
  console.log(`[${label}] 代理会话已陈旧（session=${st.session}，tabs=0）→ 请求 /repair 重新握手…`);
  try {
    const r = await fetch(B + '/repair', { method: 'POST', body: '', signal: AbortSignal.timeout(300000) });
    const j = await r.json();
    if (j && j.ok) {
      console.log(`[${label}] /repair 完成：session ${j.before} → ${j.session}，tabs=${j.tabs}`);
      return j.tabs > 0;
    }
    console.error(`[${label}] /repair 失败：${j && j.error}`);
    return false;
  } catch (e) {
    console.error(`[${label}] /repair 异常：${e?.message || e}`);
    return false;
  }
}
