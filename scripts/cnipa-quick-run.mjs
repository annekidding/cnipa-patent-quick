#!/usr/bin/env node
/**
 * 一键跑完：代理自检 → 输入识别 + 检索 → 逐号采集 → 出 4 列 CSV
 *
 * 用法（参数自动分流给对应步骤）:
 *   <node> cnipa-quick-run.mjs --input "2024229404464"
 *   <node> cnipa-quick-run.mjs --input "一种分切机" --input "江西创导动物保健品有限公司"
 *   <node> cnipa-quick-run.mjs --input-file 清单.txt
 *   <node> cnipa-quick-run.mjs --appno-file 号码.txt
 *
 *   识别参数: --input / --input-file / --as 专利号|名称|申请人|auto
 *   检索参数: --types / --size / --name-mode exact|contains / --applicant-mode part|full
 *   采集参数: --gap --batch --batch-gap --cooldown --short-rounds --ban-wait
 *             --max-waits --max-min --limit --retry --no-fee --force-fee --fresh
 *   出表参数: --as-of YYYY-MM-DD --slashes --status-filter "…" --all-rows --show --no-bom --out
 *
 * 中间产物固定写在工作目录：rows.json / quick-detail.json，最终 CSV 默认 `专利年费速查.csv`（4 列）。
 * 中断了直接重跑同一条命令：采集自动续抓（已成功的号不重抓）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLiveSession } from './cnipa-quick-cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const NODE = process.execPath;

const VALUED = {
  search: ['--input', '--input-file', '--as', '--appno', '--appno-file', '--name', '--applicant',
    '--types', '--size', '--applicant-mode', '--name-mode'],
  detail: ['--gap', '--batch', '--batch-gap', '--cooldown', '--short-rounds', '--ban-wait',
    '--max-waits', '--max-min', '--limit', '--retry'],
  report: ['--as-of', '--status-filter', '--show'],
};
const FLAGS = {
  detail: ['--no-fee', '--force-fee', '--fresh'],
  report: ['--no-bom', '--slashes', '--all-rows'],
};

function split(argv) {
  const out = { search: [], detail: [], report: [] };
  let outPath = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { outPath = argv[i + 1] || ''; i++; continue; }
    let placed = false;
    for (const grp of ['search', 'detail', 'report']) {
      if ((VALUED[grp] || []).includes(a)) { out[grp].push(a, argv[i + 1]); i++; placed = true; break; }
      if ((FLAGS[grp] || []).includes(a)) { out[grp].push(a); placed = true; break; }
    }
    if (!placed) console.warn(`[提示] 未识别参数 ${a} 已忽略`);
  }
  return { ...out, outPath };
}

const run = (script, args) => spawnSync(NODE, [resolve(HERE, script), ...args], { stdio: 'inherit' }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const healthOk = async () => {
  try {
    const h = await (await fetch('http://127.0.0.1:3456/health', { signal: AbortSignal.timeout(4000) })).json();
    return !!(h && h.status === 'ok');
  } catch { return false; }
};

async function ensureProxy() {
  let up = false;
  for (let i = 0; i < 3 && !up; i++) up = await healthOk();
  if (!up) {
    console.log('[0/3] 代理未就绪 → 后台启动 bsk-cdp-shim.mjs --keep-session…');
    const child = spawn(NODE, [resolve(HERE, 'bsk-cdp-shim.mjs'), '--keep-session'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let k = 0; k < 60 && !up; k++) { await sleep(2000); up = await healthOk(); }
  }
  if (!up) {
    console.error('[0/3] ✗ 代理启动失败，请手动另开一个终端跑：node bsk-cdp-shim.mjs --keep-session');
    return false;
  }
  // /health ok 只说明进程活着，不代表会话还在（daemon 重启后会「假健康」）
  if (!(await ensureLiveSession('http://127.0.0.1:3456', 'run'))) {
    console.error('[0/3] ✗ 代理会话不可用。手动排查：bsk session list / bsk status');
    return false;
  }
  console.log('[0/3] 代理就绪（会话活性已确认）');
  return true;
}

(async () => {
  const g = split(argv);
  const hasInput = g.search.some((a) => ['--input', '--input-file', '--appno', '--appno-file', '--name', '--applicant'].includes(a));
  if (!hasInput) {
    console.error('用法：必须给 --input / --input-file / --appno / --appno-file / --name / --applicant 之一');
    console.error('     输入什么都可以，脚本会先识别：专利号 → 按号查；名称 → 按名称查；申请人 → 按申请人查');
    process.exit(1);
  }
  if (!(await ensureProxy())) process.exit(2);

  console.log('\n[1/3] 输入识别 + 检索…');
  if (!run('cnipa-quick-search.mjs', [...g.search, '--out', 'rows.json'])) process.exit(3);

  console.log('\n[2/3] 逐号采集（每号 2 次请求；可中断，重跑自动续抓）…');
  const ok = run('cnipa-quick-detail.mjs', ['rows.json', '--out', 'quick-detail.json', ...g.detail]);
  if (!ok) console.warn('[2/3] ⚠️ 采集未全部完成（多为接口限流），仍继续出表；未取到的项标「数据缺口」');

  console.log('\n[3/3] 出 4 列交付表…');
  const reportArgs = ['--rows', 'rows.json', '--detail', 'quick-detail.json', ...g.report];
  if (g.outPath) reportArgs.push('--out', g.outPath);
  if (!run('cnipa-quick-report.mjs', reportArgs)) process.exit(4);

  console.log(`\n✅ 完成：\n   ${resolve(process.cwd(), g.outPath || '专利年费速查.csv')}`);
})().catch((e) => { console.error('[ERROR]', e?.message || e); process.exit(1); });
