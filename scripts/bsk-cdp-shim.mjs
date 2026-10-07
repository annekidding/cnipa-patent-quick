#!/usr/bin/env node
/**
 * bsk-cdp-shim.mjs —— 用 bsk(browser-skill) 复刻「CDP 代理」HTTP 接口
 *
 * 背景：本 skill 原先依赖 web-access 的 cdp-proxy.mjs（挂在用户已开的浏览器标签上）。
 * 新方案改用 bsk 的 Agent Window（隔离窗口，共享登录态与 cookie），
 * 本 shim 把 bsk 包装成同样的 7 个 HTTP 接口，
 * 使 cnipa-scan.mjs / cnipa-phone.mjs **无需任何修改**即可运行。
 *
 * 实现的接口（与旧 cdp-proxy 完全兼容）：
 *   GET  /health                      -> {"status":"ok"}
 *   GET  /targets                     -> [{targetId, url, title}]   仅 Agent Window 标签
 *   POST /eval?target=<tabId>         body=JS 源码      -> {value}
 *   POST /navigate?target=<tabId>     body=URL          -> {ok,url}
 *   POST /new                         body=URL          -> {targetId}
 *   POST /click?target=<tabId>        body=CSS 选择器    -> {ok}
 *   POST /close?target=<tabId>        body=''           -> {ok}
 *   POST /repair                      body=''           -> {ok,session,tabs}  ← 会话陈旧时自愈（2026-09-18 加）
 *
 * 用法：
 *   node bsk-cdp-shim.mjs                 # 启动（自动建会话 + 备好两个锚标签）
 *   node bsk-cdp-shim.mjs --port 3456
 *   node bsk-cdp-shim.mjs --keep-session  # 退出时保留 bsk 会话（便于连续跑第1/3步）
 *   node bsk-cdp-shim.mjs --no-anchor     # 不自动开锚标签
 *   node bsk-cdp-shim.mjs --kill          # 清理：停止所有 bsk 会话（独立运行，不启服务）
 *
 * 关键实现要点（踩过的坑）：
 *   1. `bsk session start` 创建完会话后**不返回**（CLI 挂住）→ 必须 detached 启动后轮询
 *      `bsk session list` 取 session_id，不能同步等待。
 *   2. 本机 Bash PATH 损坏，故 bsk 用绝对路径解析，不依赖 PATH。
 *   3. 所有 bsk 调用串行化，避免并发压 daemon 且保证 /new 后 /targets 立即可见。
 *   4. Agent Window 与用户窗口共享登录态 → 完全不需要人工预开标签页。
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const PORT = parseInt(opt('port', '3456'), 10);
const VERBOSE = has('verbose');
const KEEP_SESSION = has('keep-session');
const NO_ANCHOR = has('no-anchor');
const KILL_ONLY = has('kill');

const CPQ = 'https://cpquery.cponline.cnipa.gov.cn/chinesepatent/index';
const PJ = 'https://interactive.cponline.cnipa.gov.cn/public-app-zljffw/zhijianpj/piaojuztcx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[shim]', ...a);
const vlog = (...a) => { if (VERBOSE) console.log('[shim:v]', ...a); };

/* ------------------------------------------------------------------ *
 * 1. bsk 定位与调用
 * ------------------------------------------------------------------ */
function resolveBsk() {
  const exe = process.platform === 'win32' ? 'bsk.exe' : 'bsk';
  const cands = [
    process.env.BSK_BIN,
    path.join(os.homedir(), '.local', 'bin', exe),
    path.join(os.homedir(), '.bsk', 'bin', exe),
    '/usr/local/bin/bsk',
    exe,
  ].filter(Boolean);
  for (const c of cands) {
    if (c.includes('/') || c.includes(path.sep)) {
      if (existsSync(c)) return c;
    } else {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      if (r.status === 0) return c;
    }
  }
  return null;
}

const BSK = resolveBsk();
if (!BSK) {
  console.error('[shim] 找不到 bsk 可执行文件。请确认已安装 browser-skill，或用 BSK_BIN 环境变量指定路径。');
  process.exit(2);
}

function bskRun(args, timeout = 120000) {
  const t0 = Date.now();
  const r = spawnSync(BSK, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  vlog(`bsk ${args.slice(0, 3).join(' ')} -> exit ${r.status} (${Date.now() - t0}ms)`);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { code: null, out: (r.stdout || '').trim(), err: 'bsk 调用超时', timeout: true };
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function bskJson(args, timeout = 120000) {
  const r = bskRun(args, timeout);
  if (!r.out) return { __code: r.code, __err: r.err };
  try { return JSON.parse(r.out); } catch { return { __raw: r.out, __code: r.code }; }
}

/* ------------------------------------------------------------------ *
 * 2. 会话管理
 * ------------------------------------------------------------------ */
let SID = opt('session', null);
let WE_CREATED_SESSION = false;

function listSessions() {
  const o = bskJson(['session', 'list', '--json'], 40000);
  return Array.isArray(o) ? o : [];
}

async function ensureSession() {
  if (SID) { log(`复用指定会话 ${SID}`); return SID; }
  let s = listSessions();
  if (s.length) { SID = s[0].session_id; log(`复用已存在会话 ${SID}`); return SID; }

  log('创建 bsk 会话（session start 不会返回，故分离进程 + 轮询 session list）…');
  const p = spawn(BSK, ['session', 'start', '--json', '--no-focus'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  p.unref();
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    s = listSessions();
    if (s.length) {
      SID = s[0].session_id;
      WE_CREATED_SESSION = true;
      log(`会话已就绪 ${SID}（耗时 ${i + 1}s）`);
      return SID;
    }
  }
  throw new Error('bsk 会话创建超时（90s）。请先跑 `bsk doctor` 检查 daemon 与扩展连接。');
}

/* ------------------------------------------------------------------ *
 * 3. 标签页操作
 * ------------------------------------------------------------------ */
const TAB_TIMEOUT = 30000;

function listAgentTabs() {
  const o = bskJson(['tab', 'list', '--session', SID, '--scope', 'agent', '--json'], TAB_TIMEOUT);
  return o && Array.isArray(o.tabs) ? o.tabs : [];
}

function tabCreate(url) {
  const o = bskJson(['tab', 'create', '--session', SID, '--url', url, '--json'], 90000);
  return o && o.tab_id ? o.tab_id : null;
}

function tabClose(id) {
  return bskRun(['tab', 'close', String(id), '--session', SID, '--json'], TAB_TIMEOUT);
}

function evalOn(tabId, js, timeoutSec = 150) {
  const r = bskJson(['evaluate', js, '--session', SID, '--tab-id', String(tabId),
    '--json', '--timeout', `${timeoutSec}s`], (timeoutSec + 30) * 1000);
  if (r && r.ok === true) return { value: r.value === undefined ? null : r.value };
  // bsk 的失败结构：{ok:false, tab_id, error:{text,line,column}}
  const msg = r?.error?.text
    || (typeof r?.error === 'string' ? r.error : null)
    || r?.__err
    || r?.__raw
    || `evaluate 失败 (exit=${r?.__code})`;
  console.error(`[shim] eval 失败 tab=${tabId}: ${String(msg).split('\n')[0].slice(0, 200)}`);
  console.error(`[shim]   出错 JS 片段: ${String(js).replace(/\s+/g, ' ').slice(0, 180)}`);
  return { value: null, error: String(msg) };
}

function navTo(tabId, url) {
  return bskRun(['navigate', url, '--session', SID, '--tab-id', String(tabId),
    '--wait-until', 'load', '--timeout', '60s'], 120000);
}

/** 轮询直到页内条件成立（用于等微前端挂载） */
async function waitReady(tabId, probeJs, label, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = evalOn(tabId, probeJs, 30);
    if (r.value) { log(`${label} 就绪（${Math.round((Date.now() - t0) / 1000)}s）`); return true; }
    await sleep(1500);
  }
  log(`⚠️ ${label} 等待超时（${Math.round(timeoutMs / 1000)}s），继续启动`);
  return false;
}

/** 备好两个锚标签：cpquery 查询页 + 票据查询页（幂等） */
async function ensureAnchors() {
  const tabs = listAgentTabs();
  const need = [];
  if (!tabs.some((t) => t.url && t.url.includes('chinesepatent/index'))) need.push(['cpquery', CPQ]);
  if (!tabs.some((t) => t.url && t.url.includes('piaojuztcx'))) need.push(['票据页', PJ]);

  for (const [label, url] of need) {
    log(`打开锚标签：${label}`);
    const id = tabCreate(url);
    if (!id) { log(`⚠️ ${label} 标签创建失败`); continue; }
    // tab create 后 url 可能仍为空，显式 navigate 一次更稳
    await sleep(800);
    navTo(id, url);
  }
  if (!need.length) log('锚标签已存在，跳过创建');

  // 等待两个页面真正可用（cpquery 的 Vue 组件 / 票据页微前端）
  const tabs2 = listAgentTabs();
  const cpq = tabs2.find((t) => t.url && t.url.includes('chinesepatent/index'));
  const pj = tabs2.find((t) => t.url && t.url.includes('piaojuztcx'));

  if (cpq) {
    await waitReady(cpq.tab_id, `(()=>{const pg=document.querySelector('.q-pagination');
      if(!pg||!pg.__vue__) return false;
      try{const se=pg.__vue__.$parent.$parent; return !!(se&&typeof se.getList==='function');}catch(e){return false;}})()`,
      'cpquery Vue 组件', 90000);
  }
  if (pj) {
    await waitReady(pj.tab_id, `(()=>{const els=[...document.querySelectorAll('*')];
      for(const e of els){ if(e.__vue__){ let p=e.__vue__,d=0;
        while(p&&d<25){ if(p.$options&&p.$options.name==='piaojuztcx') return !!(p.form); p=p.$parent; d++; } } }
      return false;})()`, '票据页微前端', 90000);
  }

  // ★ 票据页锚标签是**独立登录态**：专利业务办理系统（tysf 统一身份认证）的会话过期后，
  //   打开 PJ 会被弹到 .../am/#/user/login，URL 里不再含 piaojuztcx。
  //   这时 /targets 里就查不到票据页，第 3 步会整批报「未找到纸质票据状态查询标签页」，
  //   而 cpquery 那侧一切正常（两个系统各管各的），极容易误判成脚本坏了。
  //   实测：cpquery 登录态还好好的，票据页却已过期 —— 必须显式点出来。
  const tabs3 = listAgentTabs();
  if (!tabs3.some((t) => t.url && t.url.includes('piaojuztcx'))) {
    const landed = tabs3.find((t) => t.url && /tysf|interactive\.cponline/.test(t.url));
    log('⚠️⚠️ 票据页（piaojuztcx）不可用！第 3 步取手机号会全部失败。');
    log(`     实际落点：${landed ? landed.url : '(无相关标签)'}`);
    if (landed && /login/.test(landed.url)) {
      log('     判据：被弹到统一身份认证登录页 → **专利业务办理系统的登录态已过期**');
      log('          （注意：这与 cpquery 的登录态是两套，cpquery 正常不代表票据系统正常）');
      log('     处理：在 Agent Window / Edge 里重新登录「专利业务办理系统」后重跑第 3 步即可。');
    }
  }
}

/** 清掉上次崩溃残留的详情标签 */
function cleanStaleDetailTabs() {
  let n = 0;
  for (const t of listAgentTabs()) {
    if (t.url && t.url.includes('/detail/index')) { tabClose(t.tab_id); n++; }
  }
  if (n) log(`清理残留详情标签 ${n} 个`);
}

/* ------------------------------------------------------------------ *
 * 4. HTTP 服务
 * ------------------------------------------------------------------ */
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(() => fn());
  chain = p.then(() => {}, () => {});
  return p;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const target = u.searchParams.get('target');
  const ep = u.pathname;

  // 健康检查：必须返回 {status:'ok'}，脚本靠它判断代理就绪
  if (ep === '/health' && req.method === 'GET') {
    return send(res, 200, { status: 'ok', session: SID, bsk: BSK });
  }

  if (ep === '/' && req.method === 'GET') {
    return send(res, 200, { shim: 'bsk-cdp-shim', session: SID, bsk: BSK, tabs: listAgentTabs().length });
  }

  enqueue(async () => {
    try {
      // ★ 2026-09-18：会话自愈。daemon 重启 / Agent Window 被回收后，本进程手里的 SID 会变陈旧，
      //   而 /health 仍照常回 ok（它只回显自己记的 SID）→ 调用方以为一切正常，
      //   实际 /targets 恒为 []、检索报「找不到可用的 cpquery 列表页标签」。
      //   本端点丢掉旧 SID 重新握手（有活会话就复用、没有就新建），并把锚标签备好。
      if (ep === '/repair' && req.method === 'POST') {
        await readBody(req);
        const before = SID;
        SID = null; WE_CREATED_SESSION = false;
        log(`收到 /repair（原会话 ${before}），重新握手…`);
        try {
          await ensureSession();
          cleanStaleDetailTabs();
          if (!NO_ANCHOR) await ensureAnchors();
          const tabs = listAgentTabs();
          log(`/repair 完成 -> session=${SID}, tabs=${tabs.length}`);
          return send(res, 200, { ok: true, before, session: SID, tabs: tabs.length });
        } catch (e) {
          SID = before;      // 失败就还原，别把进程搞成半死状态
          return send(res, 500, { ok: false, before, error: String(e?.message || e) });
        }
      }

      if (ep === '/targets' && req.method === 'GET') {
        const tabs = listAgentTabs();
        return send(res, 200, tabs.map((t) => ({
          targetId: String(t.tab_id), url: t.url || '', title: t.title || '',
        })));
      }

      if (ep === '/eval' && req.method === 'POST') {
        if (!target) return send(res, 400, { error: 'missing target' });
        const js = await readBody(req);
        const r = evalOn(target, js);
        return send(res, 200, r);
      }

      if (ep === '/navigate' && req.method === 'POST') {
        if (!target) return send(res, 400, { error: 'missing target' });
        const url = (await readBody(req)).trim();
        const r = navTo(target, url);
        return send(res, 200, { ok: r.code === 0, url, err: r.code === 0 ? undefined : r.err.slice(0, 300) });
      }

      if (ep === '/new' && req.method === 'POST') {
        const url = (await readBody(req)).trim();
        const id = tabCreate(url);
        if (!id) return send(res, 500, { error: 'tab create 失败' });
        // 轮询等待该标签出现在 tab list 中（脚本随后会立刻拉 /targets）
        for (let i = 0; i < 20; i++) {
          if (listAgentTabs().some((t) => String(t.tab_id) === String(id))) break;
          await sleep(250);
        }
        return send(res, 200, { targetId: String(id) });
      }

      if (ep === '/click' && req.method === 'POST') {
        if (!target) return send(res, 400, { error: 'missing target' });
        const sel = (await readBody(req)).trim();
        const r = bskJson(['click', '--selector', sel, '--session', SID, '--tab-id', String(target),
          '--json', '--timeout', '30s'], 60000);
        return send(res, 200, { ok: r && r.ok === true, detail: r });
      }

      if (ep === '/close' && req.method === 'POST') {
        if (!target) return send(res, 400, { error: 'missing target' });
        await readBody(req);
        const r = tabClose(target);
        return send(res, 200, { ok: r.code === 0 });
      }

      return send(res, 404, { error: 'unknown endpoint ' + ep });
    } catch (e) {
      console.error('[shim] 处理异常:', e?.message || e);
      return send(res, 500, { error: String(e?.message || e) });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. 启动 / 清理
 * ------------------------------------------------------------------ */
/**
 * 停止所有会话。注意：关闭 Agent Window 较慢，可能超过 spawnSync 超时（此时 code 为 null），
 * 但停止往往已经生效 → 用 session list 是否清空作为二次判据，避免误报失败。
 */
function stopSessions(timeoutMs = 120000) {
  const r = bskRun(['session', 'stop', '--all', '--json'], timeoutMs);
  if (r.code === 0) return { ok: true, detail: r.out };
  if (listSessions().length === 0) return { ok: true, detail: '超时但会话已清空' };
  return { ok: false, detail: r.err || r.out || `exit=${r.code}` };
}

async function main() {
  if (KILL_ONLY) {
    const r = stopSessions();
    log(r.ok ? `已停止所有 bsk 会话（${r.detail}）` : `停止会话失败：${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }

  log(`bsk = ${BSK}`);
  await ensureSession();

  if (!KEEP_SESSION) process.on('exit', () => { if (WE_CREATED_SESSION) stopSessions(25000); });
  const bye = () => {
    log('收到退出信号，清理中…');
    if (WE_CREATED_SESSION && !KEEP_SESSION) stopSessions(25000);
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  cleanStaleDetailTabs();
  if (!NO_ANCHOR) await ensureAnchors();

  server.listen(PORT, '127.0.0.1', () => {
    log(`就绪 -> http://127.0.0.1:${PORT}  (session=${SID}, keep=${KEEP_SESSION})`);
    log('可运行: cnipa-scan.mjs / cnipa-phone.mjs（无需修改）');
  });
  server.on('error', (e) => {
    console.error(`[shim] 端口 ${PORT} 监听失败: ${e.message}`);
    console.error('       若此前已有 shim/代理在跑，先结束它，或用 --port 指定其他端口（注意脚本里的 3456 是写死的）。');
    process.exit(3);
  });
}

main().catch((e) => { console.error('[shim] 启动失败:', e?.message || e); process.exit(1); });
