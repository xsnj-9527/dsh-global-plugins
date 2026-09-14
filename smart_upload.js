#!/usr/bin/env node
'use strict';

/* ============================================================================
 * smart_upload.js —— Workshop Publisher · 《饥荒联机版》Steam 创意工坊上传器
 * ----------------------------------------------------------------------------
 * 为什么存在：以前上传要经过 Bash -> Python -> PowerShell -> schtasks -> 交互式
 * 会话 -> node upload.js，命令长、等待 280 秒、跑到一半网关超时，于是"状态未知"
 * 反复重试直到死锁。
 *
 * 本脚本把整条链路压成一条命令：
 *
 *     node smart_upload.js                 # 自动挑出"待上传"的模组并处理
 *     node smart_upload.js --mod=woodie    # 指定模组
 *     node smart_upload.js --status        # 只查询，绝不上传（秒回，绝不挂起）
 *
 * 运行链条（只剩两层，且 PowerShell / schtasks 已彻底删除）：
 *     WSL node smart_upload.js
 *       └─ 内部 spawn Windows 版 node.exe（实测它就在交互式 Session 1，能连 Steam）
 *            └─ steamworks.js -> 已登录的 Steam 客户端 -> 创意工坊
 *
 * 四条硬约束：
 *   1. 幂等：先问"远程是否已经是这份内容"，是就直接 [SUCCESS]，绝不重复上传。
 *   2. 有界：Steam Web API 单次 15s、上传引擎硬超时 150s、本脚本默认 60s 预算。
 *      任何一步超时都立刻返回，绝不无限等待。
 *   3. 可恢复：结果写在目标目录的 upload_result.json / upload_state.json 里。
 *      中途断联后重跑同一条命令，或跑 --status，都会收敛到真实状态（见下面的
 *      "孤儿结果认领" 与 "远程认领" 两条路径），不会来回反复调用。
 *   4. 可解析：结束时打印 [SUCCESS] / [FAILED] / [PENDING] / [FAILED_TIMEOUT]
 *      状态码，外加一段结构化 JSON（字段见文档末尾）。
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ── 环境常量 ────────────────────────────────────────────────────────────────

/** 调用 Windows 版 Node（WSL interop 实测：它能落在交互式 Session 1 并连上 Steam）。 */
const WIN_NODE_CANDIDATES = [
    '/mnt/c/Program Files/nodejs/node.exe',
    '/mnt/c/Program Files (x86)/nodejs/node.exe',
];

/** Steam Web API：公开接口，不需要 API Key，用来查创意工坊条目的真实状态。 */
const STEAM_API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const API_TIMEOUT_MS = 15000;   // 单次网络请求上限
const APP_ID = 322330;          // Don't Starve Together

const DEFAULT_BUDGET_SEC = 60;      // 本脚本同步等待上传完成的上限
const DEFAULT_HARD_TIMEOUT_SEC = 150; // Windows 侧上传引擎的硬超时

/** 模组登记表：新增模组只要在这里加一行（或用 --src= 临时指定）。 */
const MODS = {
    pangu: {
        title: '伍迪？！盘古？！ Woodie?! Pangu?!',
        expect: '伍迪',
        src: '/home/zch2026/pangu_mod',
        uploadDir: '/mnt/d/pangu_upload',
        itemId: '3800732633',
        tags: ['character'],
    },
    woodie: {
        title: '伍迪真无敌 Woodie The Invincible',
        expect: '伍迪真无敌',
        src: '/home/zch2026/woodie_mod',
        uploadDir: '/mnt/d/woodie_upload',
        itemId: '3800149383',
        tags: ['character'],
    },
    twinflower: {
        title: '双生花 Twin Flowers',
        expect: '双生花',
        src: '/home/zch2026/twinflower',
        uploadDir: '/mnt/d/dstupload',
        itemId: '3800006179',
        tags: ['character'],
    },
};

/** 默认随包上传的源码文件（避免把 test_harness.lua 之类的开发文件推上工坊）。 */
const DEFAULT_LUA_FILES = ['modinfo.lua', 'modmain.lua'];
const ICON_FILES = ['modicon.tex', 'modicon.xml'];

/** Mod Tools：官方图标编译器（PNG -> .tex/.xml）。实测 0.45 秒，且逐字节可复现。 */
const MOD_TOOLS_DIR = "/mnt/d/Software/Steam/steamapps/common/Don't Starve Mod Tools/mod_tools";
const MOD_TOOLS_PY = MOD_TOOLS_DIR + '/buildtools/windows/Python27/python.exe';
const ICON_BUILD_SCRIPT = 'compiler_scripts/image_build.py';
const ICON_STAGE_DIR = '_icon';

// ── 小工具 ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function md5(buf) {
    return crypto.createHash('md5').update(buf).digest('hex');
}

function fileMd5(p) {
    return md5(fs.readFileSync(p));
}

function readJsonSafe(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeJson(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** /mnt/d/xxx -> D:\xxx（传给 Windows 进程的参数必须是 Windows 风格路径）。 */
function wslToWin(p) {
    const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
    if (!m) return p;
    return m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\');
}

function findWinNode() {
    for (const c of WIN_NODE_CANDIDATES) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        mod: null,
        src: null,
        status: false,
        force: false,
        detach: false,
        list: false,
        quiet: false,
        attach: null,
        recompileIcon: false,
        budgetSec: DEFAULT_BUDGET_SEC,
        hardTimeoutSec: DEFAULT_HARD_TIMEOUT_SEC,
        iconTimeoutSec: 90,
    };
    for (const a of argv) {
        if (a === '--status') opts.status = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--detach') opts.detach = true;
        else if (a === '--list') opts.list = true;
        else if (a === '--quiet') opts.quiet = true;
        else if (a === '--recompile-icon') opts.recompileIcon = true;
        else if (a.startsWith('--mod=')) opts.mod = a.slice(6);
        else if (a.startsWith('--src=')) opts.src = a.slice(6);
        else if (a.startsWith('--budget=')) opts.budgetSec = Number(a.slice(9)) || DEFAULT_BUDGET_SEC;
        else if (a.startsWith('--icon-timeout=')) opts.iconTimeoutSec = Number(a.slice(15)) || 90;
        else if (a.startsWith('--hard-timeout=')) opts.hardTimeoutSec = Number(a.slice(15)) || DEFAULT_HARD_TIMEOUT_SEC;
        else if (a === '--help' || a === '-h') opts.help = true;
    }
    return opts;
}

function usage() {
    console.log([
        '用法: node smart_upload.js [选项]',
        '',
        '  （无参数）        自动挑出待上传的模组并处理；全都最新则直接报成功',
        '  --mod=<id>        指定模组：' + Object.keys(MODS).join(' | '),
        '  --src=<目录>      临时指定模组源码目录（目录名 <name> 会对应 D:\\<name>_upload）',
        '  --status          只查询远程/本地状态，绝不上传；秒回',
        '  --list            列出所有已登记模组的状态',
        '  --force           即使判定为最新，也强制重新上传一次',
        '  --recompile-icon  强制用 art/modicon.png 重新编译图标（.tex/.xml）',
        '  --detach          只启动上传，立刻返回（随后用 --status 收结果）',
        '  --budget=<秒>     同步等待上限，默认 ' + DEFAULT_BUDGET_SEC,
        '  --hard-timeout=<秒> Windows 上传引擎硬超时，默认 ' + DEFAULT_HARD_TIMEOUT_SEC,
        '  --icon-timeout=<秒> 图标编译硬超时，默认 90',
        '  --quiet           只输出最后那段 JSON',
        '',
        '图标：源码 art/modicon.png 存在时，自动调用 Mod Tools 的 image_build.py 编译成',
        '      modicon.tex/.xml（官方管线，逐字节可复现）；PNG 一变就自动重编。',
    ].join('\n'));
}

// ── 模组解析 ────────────────────────────────────────────────────────────────

function adhocMod(srcDir) {
    const abs = path.resolve(srcDir);
    const name = path.basename(abs);
    const winDir = wslToWin(abs);
    // 源码在 WSL 里没有对应的盘符时，退回到 D:\<name>_upload
    const uploadDir = /^\/mnt\//.test(abs)
        ? abs + '_upload'
        : '/mnt/d/' + name + '_upload';
    return {
        id: name,
        title: null,          // 从 modinfo.lua / 远程读取
        expect: null,
        src: abs,
        uploadDir,
        itemId: null,
        tags: ['character'],
        adhoc: true,
        winDirHint: winDir,
    };
}

function resolveMod(opts) {
    if (opts.mod && MODS[opts.mod]) return { ...MODS[opts.mod], id: opts.mod };
    if (opts.mod && !MODS[opts.mod]) {
        throw new Error('未知模组 "' + opts.mod + '"，已登记的有: ' + Object.keys(MODS).join(', '));
    }
    if (opts.src) return adhocMod(opts.src);
    // 按当前工作目录匹配
    const cwd = process.cwd();
    for (const [id, m] of Object.entries(MODS)) {
        if (cwd === m.src || cwd.startsWith(m.src + '/')) return { ...m, id };
    }
    return null;   // 交给 auto-select
}

// ── 打包：把 WSL 源码同步进 Windows 的内容目录 ──────────────────────────────

function parseIncludeFile(p) {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
}

function findIconPng(mod) {
    for (const c of [path.join(mod.src, 'art', 'modicon.png'), path.join(mod.src, 'modicon.png')]) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

/**
 * 图标：有 modicon.png 就用 Mod Tools 的 image_build.py 编译成 .tex/.xml（官方管线，
 * 逐字节可复现）；没有 PNG 就沿用 art/ 里现成的 tex。编译产物只写进内容目录，
 * 不动源码树；用 _icon/.src.md5 记住是哪个 PNG 编译出来的，PNG 一变就自动重编。
 */
function prepareIcon(mod, contentDir, opts, report) {
    const png = findIconPng(mod);
    const texOut = path.join(contentDir, 'modicon.tex');
    const xmlOut = path.join(contentDir, 'modicon.xml');

    if (!png) {
        for (const icon of ICON_FILES) {
            const from = path.join(mod.src, 'art', icon);
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(contentDir, icon));
        }
        for (const icon of ICON_FILES) {
            if (!fs.existsSync(path.join(contentDir, icon))) {
                throw new Error('缺少图标：源码 art/ 里既没有 modicon.png（可编译），内容目录里也没有现成的 ' + icon);
            }
        }
        return { mode: 'existing' };
    }

    const stageDir = path.join(mod.uploadDir, ICON_STAGE_DIR);
    const markerPath = path.join(stageDir, '.src.md5');
    const srcMd5 = fileMd5(png);
    const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : null;
    const needCompile = opts.recompileIcon || marker !== srcMd5 ||
        !fs.existsSync(texOut) || !fs.existsSync(xmlOut);

    if (!needCompile) return { mode: 'cached' };

    if (!fs.existsSync(MOD_TOOLS_PY)) {
        throw new Error('找不到 Mod Tools 的图标编译器: ' + MOD_TOOLS_PY +
            '（Steam 里安装免费工具 Don\'t Starve Mod Tools 即可；或删掉 art/modicon.png 改用现成 tex）');
    }

    fs.mkdirSync(stageDir, { recursive: true });
    const stagePng = path.join(stageDir, 'modicon.png');
    fs.copyFileSync(png, stagePng);

    // 同步等待：image_build.py 很快（实测 0.45 秒），但仍然给它硬超时
    const r = require('child_process').spawnSync(MOD_TOOLS_PY, [
        ICON_BUILD_SCRIPT, '--force', wslToWin(stagePng),
    ], {
        cwd: MOD_TOOLS_DIR,
        encoding: 'utf8',
        timeout: (opts.iconTimeoutSec || 90) * 1000,
        maxBuffer: 8 * 1024 * 1024,
    });

    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (r.error) {
        throw new Error('图标编译无法启动（' + r.error.message + '）；请确认 Mod Tools 已安装: ' + MOD_TOOLS_PY);
    }
    if (r.status !== 0) {
        throw new Error('图标编译失败（退出码 ' + r.status + '）:\n' + out.split('\n').slice(-6).join('\n'));
    }
    if (!fs.existsSync(path.join(stageDir, 'modicon.tex'))) {
        throw new Error('图标编译没有产出 modicon.tex，编译器输出:\n' + out.split('\n').slice(-6).join('\n'));
    }

    for (const icon of ICON_FILES) {
        fs.copyFileSync(path.join(stageDir, icon), path.join(contentDir, icon));
    }
    fs.writeFileSync(markerPath, srcMd5, 'utf8');
    report.step('图标     : 由 ' + path.basename(png) + ' 编译 (md5 ' + srcMd5.slice(0, 8) + ')');
    return { mode: 'compiled' };
}

function syncContent(mod, opts, report) {
    const src = mod.src;
    if (!fs.existsSync(src)) throw new Error('源码目录不存在: ' + src);

    const contentDir = path.join(mod.uploadDir, 'content');
    fs.mkdirSync(contentDir, { recursive: true });

    prepareIcon(mod, contentDir, opts, report);

    const wanted = parseIncludeFile(path.join(src, 'upload_include.txt')) || DEFAULT_LUA_FILES;
    const copied = [];
    const missing = [];

    for (const rel of wanted) {
        const from = path.join(src, rel);
        if (!fs.existsSync(from)) { missing.push(rel); continue; }
        const to = path.join(contentDir, rel);
        fs.copyFileSync(from, to);
        copied.push(rel);
    }
    if (!copied.includes('modinfo.lua')) {
        throw new Error('源码目录缺少 modinfo.lua: ' + src);
    }
    copied.push(...ICON_FILES);

    // 预览图
    const previewTarget = path.join(mod.uploadDir, 'preview.png');
    for (const from of [path.join(src, 'art', 'preview.png'), path.join(src, 'preview.png')]) {
        if (fs.existsSync(from)) { fs.copyFileSync(from, previewTarget); break; }
    }
    if (!fs.existsSync(previewTarget)) {
        throw new Error('缺少预览图 preview.png: ' + previewTarget);
    }

    // 清理内容目录里不该上传的残留文件（例如误放的说明文档）
    const keep = new Set(fs.readdirSync(contentDir).filter((f) => {
        return copied.includes(f) || ICON_FILES.includes(f);
    }));
    const pruned = [];
    for (const f of fs.readdirSync(contentDir)) {
        if (!keep.has(f)) {
            fs.rmSync(path.join(contentDir, f), { recursive: true, force: true });
            pruned.push(f);
        }
    }

    // 踩过的坑：Steam 打包器读不了中文路径/文件名
    const files = fs.readdirSync(contentDir).sort();
    if (files.length === 0) throw new Error('内容目录是空的: ' + contentDir);
    for (const f of files) {
        if (/[^\x20-\x7E]/.test(f)) throw new Error('内容目录含非 ASCII 文件名: ' + f);
    }
    if (/[^\x20-\x7E]/.test(contentDir)) throw new Error('内容目录路径含非 ASCII 字符: ' + contentDir);

    // 防呆：确认内容目录里确实是我们以为的那个模组
    const modinfo = fs.readFileSync(path.join(contentDir, 'modinfo.lua'), 'utf8');
    const nameMatch = modinfo.match(/^\s*name\s*=\s*"([^"]*)"/m);
    const modName = nameMatch ? nameMatch[1] : '';
    if (mod.expect && !modName.includes(mod.expect)) {
        throw new Error('防呆校验失败：预期【' + mod.expect + '】，但 ' + contentDir +
            ' 里是【' + modName + '】。请检查模组登记是否指错了目录。');
    }

    const manifest = files.map((f) => {
        const p = path.join(contentDir, f);
        const st = fs.statSync(p);
        return { name: f, size: st.size, md5: fileMd5(p) };
    });
    const totalBytes = manifest.reduce((s, f) => s + f.size, 0);
    const hash = md5(manifest.map((f) => f.name + ':' + f.size + ':' + f.md5).join('\n'));

    return {
        contentDir,
        previewPath: path.join(mod.uploadDir, 'preview.png'),
        itemFile: path.join(mod.uploadDir, 'workshop_item_id.txt'),
        manifest,
        totalBytes,
        hash,
        modName,
        pruned,
        missing,
    };
}

// ── 冲突说明：为什么必须有 --expect ──────────────────────────────────────────

function readItemId(mod, pack) {
    if (mod.itemId) return String(mod.itemId);
    if (fs.existsSync(pack.itemFile)) {
        const raw = fs.readFileSync(pack.itemFile, 'utf8').trim();
        if (/^\d+$/.test(raw)) return raw;
    }
    return null;
}

// ── 远程状态查询（Steam Web API，无 Key，15s 硬超时） ───────────────────────

async function queryRemote(itemId) {
    if (!itemId) return { ok: false, reason: '尚无工坊条目 ID' };
    const body = 'itemcount=1&publishedfileids[0]=' + encodeURIComponent(itemId);
    try {
        const res = await fetch(STEAM_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
        const json = await res.json();
        const d = json && json.response && json.response.publishedfiledetails &&
            json.response.publishedfiledetails[0];
        if (!d) return { ok: false, reason: '返回体没有条目详情' };
        return {
            ok: true,
            exists: Number(d.result) === 1,
            result: Number(d.result),
            title: d.title || '',
            description: d.description || '',
            fileSize: Number(d.file_size || 0),
            timeUpdated: Number(d.time_updated || 0),
            timeCreated: Number(d.time_created || 0),
            visibility: Number(d.visibility || 0),
            banned: Number(d.banned || 0),
            url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + itemId,
        };
    } catch (e) {
        const msg = e && e.name === 'TimeoutError' ? '查询超时(>' + API_TIMEOUT_MS + 'ms)' : (e && e.message) || String(e);
        return { ok: false, reason: msg };
    }
}

// ── 状态文件（本地：内容哈希 <-> 远程时间戳 的绑定） ────────────────────────

function statePath(mod) {
    return path.join(mod.uploadDir, 'upload_state.json');
}

function resultPath(mod) {
    return path.join(mod.uploadDir, 'upload_result.json');
}

/**
 * 判定"远程是否已经是这份内容"。
 * 三条路都通向同一个结论，避免把"未知"误判成"需要重传"：
 *   A. 状态文件哈希一致 + 远程时间戳/体积吻合 -> 最新
 *   B. 状态文件丢了/第一次跑，但远程标题+体积与本地完全一致 -> 认领为最新
 *   C. 远程查不通，但本地状态显示上次成功过同一份内容 -> 认作最新（unverified）
 */
function judgeFreshness(mod, pack, state, remote) {
    const itemId = readItemId(mod, pack);
    const out = { upToDate: false, verified: false, adopted: false, reason: '' };

    const sameHash = !!(state && state.contentHash === pack.hash && String(state.itemId || itemId) === String(itemId));

    if (remote.ok && remote.exists) {
        const sizeMatch = remote.fileSize === pack.totalBytes;
        if (sameHash) {
            if (remote.timeUpdated === state.remoteTimeUpdated) {
                out.upToDate = true; out.verified = true;
                out.reason = '本地哈希与远程时间戳完全吻合';
            } else if (sizeMatch) {
                // 可能是上一次超时后它其实传成功了，或别人用了同样的内容：认领
                out.upToDate = true; out.verified = true; out.adopted = true;
                out.reason = '远程更新时间戳已前移且体积一致，认领为本次内容';
            } else {
                out.reason = '远程体积 ' + remote.fileSize + ' 与本地 ' + pack.totalBytes + ' 不一致';
            }
        } else if (sizeMatch && remote.title && pack.modName &&
                   remote.title.trim() === mod.title?.trim?.()) {
            out.upToDate = true; out.verified = true; out.adopted = true;
            out.reason = '本地无记录，但远程标题与体积和本地完全一致，认领为最新';
        } else if (sizeMatch && !state) {
            out.upToDate = true; out.verified = true; out.adopted = true;
            out.reason = '本地无记录，但远程体积与本地一致，认领为最新';
        } else {
            out.reason = sameHash ? '哈希不一致' : '本地内容自上次上传后已改动';
        }
    } else if (!remote.ok) {
        if (sameHash) {
            out.upToDate = true; out.verified = false;
            out.reason = '远程查询失败（' + remote.reason + '），按本地成功记录判定为最新，不重复上传';
        } else {
            out.reason = '远程查询失败（' + remote.reason + '）且本地无同内容成功记录';
        }
    } else {
        out.reason = '工坊条目不存在或已被删除（result=' + remote.result + '）';
    }
    return out;
}

// ── Windows 侧引擎（每次运行重写，保证与本脚本永不脱节） ────────────────────

const ENGINE_SOURCE = [
    "'use strict';",
    "// AUTO-GENERATED by smart_upload.js —— 每次运行都会重写，不要手工修改。",
    "const fs = require('fs');",
    "const path = require('path');",
    "",
    "const BASE = __dirname;",
    "const RESULT_PATH = path.join(BASE, 'upload_result.json');",
    "const jobArg = process.argv.find(function (a) { return a.indexOf('--job=') === 0; });",
    "const JOB_PATH = jobArg ? jobArg.slice(6) : path.join(BASE, '_job.json');",
    "",
    "function writeResult(obj) {",
    "    obj.finishedAt = Date.now();",
    "    try { fs.writeFileSync(RESULT_PATH, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) {}",
    "    try { console.log('SMART_UPLOAD_RESULT ' + JSON.stringify(obj)); } catch (e) {}",
    "}",
    "",
    "let job = null;",
    "try { job = JSON.parse(fs.readFileSync(JOB_PATH, 'utf8')); }",
    "catch (e) { writeResult({ runId: null, ok: false, code: 'BAD_JOB', message: '无法读取任务文件 ' + JOB_PATH + ': ' + e.message }); process.exit(1); }",
    "",
    "function fail(code, message) { writeResult({ runId: job.runId, contentHash: job.contentHash, localBytes: job.localBytes, ok: false, code: code, message: message }); process.exit(1); }",
    "",
    "// 硬超时：无论 Steam 回调是否回来，到点就落地结果并退出，绝不挂起。",
    "const watchdog = setTimeout(function () {",
    "    writeResult({ runId: job.runId, contentHash: job.contentHash, localBytes: job.localBytes, ok: false, code: 'ENGINE_TIMEOUT', message: '上传引擎超过硬超时 ' + job.hardTimeoutMs + 'ms 未完成' });",
    "    process.exit(3);",
    "}, job.hardTimeoutMs);",
    "",
    "let steamworks;",
    "try { steamworks = require('steamworks.js'); }",
    "catch (e) { fail('NO_MODULE', 'Windows 侧缺少 steamworks.js 模块: ' + e.message + ' (运行目录 ' + BASE + ')'); }",
    "",
    "// ── 前置检查 ──",
    "const contentDir = path.join(BASE, job.contentDir);",
    "if (!fs.existsSync(contentDir)) fail('NO_CONTENT', '内容目录不存在: ' + contentDir);",
    "const files = fs.readdirSync(contentDir).sort();",
    "if (files.length === 0) fail('NO_CONTENT', '内容目录是空的: ' + contentDir);",
    "for (const f of files) { if (/[^\\x20-\\x7E]/.test(f)) fail('NON_ASCII_FILE', '内容目录含非 ASCII 文件名: ' + f); }",
    "if (/[^\\x20-\\x7E]/.test(contentDir)) fail('NON_ASCII_PATH', '内容目录路径含非 ASCII 字符: ' + contentDir);",
    "if (!fs.existsSync(job.previewPath)) fail('NO_PREVIEW', '预览图不存在: ' + job.previewPath);",
    "",
    "// ── 连接 Steam ──",
    "let client;",
    "try { client = steamworks.init(job.appId); }",
    "catch (e) { fail('NO_STEAM', '无法连接 Steam 客户端（' + (e && e.message ? e.message : e) + '）。请确认 Steam 已启动并登录。'); }",
    "",
    "const me = client.localplayer.getSteamId().steamId64.toString();",
    "console.log('已连接 Steam，登录账号 SteamID64 = ' + me);",
    "console.log('模组名称 : ' + job.modName);",
    "console.log('内容目录 : ' + contentDir);",
    "console.log('内容文件 : ' + files.join(', '));",
    "",
    "// ── 决定：新建还是更新 ──",
    "const itemFile = path.join(BASE, job.itemFile);",
    "let itemId = null;",
    "if (fs.existsSync(itemFile)) {",
    "    const raw = fs.readFileSync(itemFile, 'utf8').trim();",
    "    if (/^\\d+$/.test(raw)) { itemId = BigInt(raw); console.log('复用已记录的工坊条目: ' + raw); }",
    "}",
    "",
    "function doUpload(id) {",
    "    const update = {",
    "        title: job.title,",
    "        description: job.description,",
    "        previewPath: job.previewPath,",
    "        contentPath: contentDir,",
    "        tags: job.tags,",
    "        visibility: client.workshop.UgcItemVisibility.Public,",
    "        changeNote: job.changeNote,",
    "    };",
    "    return new Promise(function (resolve, reject) {",
    "        let lastPct = -1;",
    "        client.workshop.updateItemWithCallback(id, update, job.appId,",
    "            function (res) { resolve(res); },",
    "            function (err) { reject(err instanceof Error ? err : new Error(String(err))); },",
    "            function (p) {",
    "                const total = Number(p.total || 0);",
    "                const cur = Number(p.progress || 0);",
    "                const pct = total > 0 ? Math.floor((cur / total) * 100) : 0;",
    "                if (pct !== lastPct) { lastPct = pct; console.log('  上传进度 ' + pct + '% (status=' + p.status + ')'); }",
    "            }, 1000);",
    "    });",
    "}",
    "",
    "(async function main() {",
    "    let created = false;",
    "    if (itemId === null) {",
    "        console.log('创建新的创意工坊条目 ...');",
    "        const createdRes = await client.workshop.createItem(job.appId);",
    "        itemId = createdRes.itemId;",
    "        created = true;",
    "        fs.writeFileSync(itemFile, itemId.toString(), 'utf8');",
    "        console.log('条目已创建，ID = ' + itemId.toString());",
    "        if (createdRes.needsToAcceptAgreement) {",
    "            clearTimeout(watchdog);",
    "            writeResult({ runId: job.runId, contentHash: job.contentHash, localBytes: job.localBytes, ok: false, code: 'NEED_AGREEMENT', itemId: itemId.toString(), created: true, message: '条目已创建，但需要先在浏览器接受创意工坊法律协议' });",
    "            process.exit(2);",
    "        }",
    "    }",
    "    console.log('开始上传内容 ...');",
    "    const res = await doUpload(itemId);",
    "    clearTimeout(watchdog);",
    "    writeResult({",
    "        runId: job.runId, contentHash: job.contentHash, localBytes: job.localBytes,",
    "        ok: true, code: 'SUCCESS', itemId: res.itemId.toString(), created: created,",
    "        needsToAcceptAgreement: !!res.needsToAcceptAgreement,",
    "        message: '上传成功，创意工坊条目 ' + res.itemId.toString(),",
    "    });",
    "    process.exit(0);",
    "})().catch(function (e) {",
    "    clearTimeout(watchdog);",
    "    fail('UPLOAD_FAILED', (e && e.stack) ? e.stack : String(e));",
    "});",
    "",
].join('\n');

// ── 启动 Windows 侧引擎并等待结果（有界） ───────────────────────────────────

function spawnEngine(mod, pack, opts, runId) {
    const winNode = findWinNode();
    if (!winNode) {
        throw new Error('找不到 Windows 版 Node，请检查: ' + WIN_NODE_CANDIDATES.join(' , '));
    }

    const enginePath = path.join(mod.uploadDir, '_engine.js');
    const jobPath = path.join(mod.uploadDir, '_job.json');
    fs.writeFileSync(enginePath, ENGINE_SOURCE, 'utf8');

    const description = loadDescription(mod, pack);
    writeJson(jobPath, {
        runId,
        appId: APP_ID,
        contentDir: 'content',
        previewPath: wslToWin(path.join(mod.uploadDir, 'preview.png')),
        itemFile: 'workshop_item_id.txt',
        modName: pack.modName,
        title: mod.title || pack.modName,
        description,
        tags: mod.tags || ['character'],
        changeNote: '内容更新 / content update',
        hardTimeoutMs: opts.hardTimeoutSec * 1000,
        contentHash: pack.hash,
        localBytes: pack.totalBytes,
    });

    // 清掉上一轮的结果，避免被陈旧文件骗到（认领逻辑在启动前已经处理过孤儿结果）
    try { fs.rmSync(resultPath(mod), { force: true }); } catch (e) {}

    const child = spawn(winNode, [
        wslToWin(enginePath),
        '--job=' + wslToWin(jobPath),
    ], {
        cwd: /^\/mnt\//.test(mod.uploadDir) ? mod.uploadDir : '/mnt/d',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    return { child, enginePath, jobPath, winNode };
}

async function waitForEngine(mod, runId, budgetMs, child) {
    const rp = resultPath(mod);
    const logLines = [];
    let exited = null;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; });
    child.on('error', (e) => { exited = { code: null, signal: null, error: e.message, at: Date.now() }; });

    const deadline = Date.now() + budgetMs;
    let exitSeenAt = null;
    while (Date.now() < deadline) {
        await sleep(400);
        const r = readJsonSafe(rp);
        if (r && r.runId === runId) {
            return { result: r, stdout, stderr, exited, logLines };
        }
        if (exited) {
            if (exitSeenAt === null) exitSeenAt = Date.now();
            // 进程已退出但结果文件还没落盘：再给 3 秒宽限
            if (Date.now() - exitSeenAt > 3000) break;
        }
    }
    return { result: null, stdout, stderr, exited, logLines };
}

function loadDescription(mod, pack) {
    const candidates = [
        path.join(mod.src, 'workshop_description.txt'),
        path.join(mod.src, 'workshop_description.md'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8').trim();
    }
    if (mod.remoteDescription) return mod.remoteDescription;
    throw new Error('缺少工坊简介：请创建 ' + candidates[0] + '（内容会原样作为创意工坊简介）');
}

// ── 单模组流程 ──────────────────────────────────────────────────────────────

async function processMod(mod, opts, report) {
    const t0 = Date.now();
    const pack = syncContent(mod, opts, report);
    const itemId = readItemId(mod, pack);
    const state = readJsonSafe(statePath(mod));
    const remote = await queryRemote(itemId);

    if (!mod.title) mod.title = (remote.ok && remote.title) || pack.modName;
    if (!mod.remoteDescription && remote.ok && remote.description) mod.remoteDescription = remote.description;

    report.step('本地内容 : ' + pack.manifest.map((f) => f.name + '(' + f.size + 'B)').join(', '));
    report.step('内容哈希 : ' + pack.hash.slice(0, 12) + '  合计 ' + pack.totalBytes + ' 字节');
    report.step('工坊条目 : ' + (itemId || '(尚无，将新建)'));
    report.step('远程状态 : ' + (remote.ok
        ? (remote.exists ? '存在，体积 ' + remote.fileSize + '，更新于 ' + new Date(remote.timeUpdated * 1000).toLocaleString('zh-CN')
                         : '不存在(result=' + remote.result + ')')
        : '查询失败：' + remote.reason));

    // 断联恢复路径 1：孤儿结果认领
    if (!opts.force) {
        const orphan = readJsonSafe(resultPath(mod));
        if (orphan && orphan.ok && orphan.contentHash === pack.hash && orphan.itemId) {
            const fresh = await queryRemote(orphan.itemId);
            if (fresh.ok && fresh.exists && fresh.fileSize === pack.totalBytes) {
                writeJson(statePath(mod), {
                    itemId: String(orphan.itemId),
                    contentHash: pack.hash,
                    localBytes: pack.totalBytes,
                    uploadedAt: orphan.finishedAt || Date.now(),
                    remoteTimeUpdated: fresh.timeUpdated,
                    remoteFileSize: fresh.fileSize,
                    source: 'reconcile-orphan-result',
                });
                report.step('发现上一轮遗留的成功结果，已认领（远程体积一致），无需重传');
                return buildPayload('success', '上一轮上传其实已经成功（已认领遗留结果），无需重复上传',
                    { fileExists: true, upToDate: true, remoteVerified: true, phase: 'done' });
            }
        }
    }

    const verdict = opts.force
        ? { upToDate: false, verified: false, reason: '--force 强制重新上传' }
        : judgeFreshness(mod, pack, state, remote);

    report.step('判定     : ' + (verdict.upToDate ? '已是最新' : '需要上传') + '（' + verdict.reason + '）');

    // 幂等出口：远程已是最新 -> 直接成功，绝不碰 Steam
    if (verdict.upToDate) {
        if (!state || state.contentHash !== pack.hash || state.remoteTimeUpdated !== (remote.ok ? remote.timeUpdated : state.remoteTimeUpdated)) {
            if (remote.ok && remote.exists) {
                writeJson(statePath(mod), {
                    itemId: String(remote.ok && itemId ? itemId : (state && state.itemId) || itemId),
                    contentHash: pack.hash,
                    localBytes: pack.totalBytes,
                    uploadedAt: (state && state.uploadedAt) || Date.now(),
                    remoteTimeUpdated: remote.timeUpdated,
                    remoteFileSize: remote.fileSize,
                    source: verdict.adopted ? 'adopt-remote' : 'refresh',
                });
            }
        }
        return buildPayload('success',
            verdict.verified ? '创意工坊已是这份内容的最新版本，无需上传'
                             : '按本地成功记录判定为最新（远程查询失败，未重复上传）',
            {
                fileExists: remote.ok ? remote.exists : true,
                upToDate: true,
                remoteVerified: verdict.verified,
                phase: 'checked',
                itemUrl: remote.ok ? remote.url : null,
            });
    }

    if (opts.status) {
        return buildPayload('failed', '本地内容比创意工坊新，需要上传（--status 模式不会上传）', {
            fileExists: remote.ok ? remote.exists : null,
            upToDate: false,
            remoteVerified: remote.ok,
            phase: 'needs-upload',
            code: 'NEEDS_UPLOAD',
            canRetry: true,
            nextAction: '执行 node ' + path.basename(__filename) + ' --mod=' + mod.id,
        }, 1);
    }

    // ── 真的上传 ──
    const runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    report.step('启动上传 : ' + path.basename(findWinNode() || '?') + ' -> _engine.js（Windows，交互式会话）');
    const { child, winNode } = spawnEngine(mod, pack, opts, runId);

    if (opts.detach) {
        child.unref();
        return buildPayload('failed', '已启动上传，本进程不等待（--detach）。请稍后用 --status 收结果', {
            fileExists: remote.ok ? remote.exists : null,
            upToDate: false,
            remoteVerified: false,
            phase: 'uploading',
            canRetry: false,
            nextAction: 'node ' + __filename + ' --status',
        }, 2);
    }

    const wait = await waitForEngine(mod, runId, opts.budgetSec * 1000, child);

    // 把引擎日志落盘，便于事后排查（不需要再让 AI 去读长输出）
    const logFile = path.join(mod.uploadDir, 'smart_' + runId + '.log');
    try {
        fs.writeFileSync(logFile,
            '=== smart_upload.js run ' + runId + ' ===\n' +
            'winNode: ' + winNode + '\n' + wait.stdout + (wait.stderr ? '\n--- stderr ---\n' + wait.stderr : ''),
            'utf8');
    } catch (e) {}

    if (wait.result) {
        const r = wait.result;
        if (r.ok) {
            // 上传成功：回写状态（远程时间戳可能还要几秒才刷新，这里重试几次）
            let fresh = { ok: false, reason: '未查询' };
            for (let i = 0; i < 3; i++) {
                fresh = await queryRemote(r.itemId);
                if (fresh.ok && fresh.exists && fresh.fileSize === pack.totalBytes) break;
                await sleep(2000);
            }
            writeJson(statePath(mod), {
                itemId: String(r.itemId),
                contentHash: pack.hash,
                localBytes: pack.totalBytes,
                uploadedAt: r.finishedAt || Date.now(),
                remoteTimeUpdated: fresh.ok ? fresh.timeUpdated : null,
                remoteFileSize: fresh.ok ? fresh.fileSize : null,
                source: 'upload',
            });
            const itemUrl = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + r.itemId;
            report.step('上传成功 : ' + itemUrl + (r.created ? '（新建条目）' : '（更新条目）'));
            report.step('引擎日志 : ' + logFile);
            return buildPayload('success', (r.created ? '创意工坊条目已创建并上传成功' : '创意工坊已更新为新版本') +
                '（条目 ' + r.itemId + '）', {
                fileExists: true,
                upToDate: true,
                remoteVerified: fresh.ok && fresh.exists,
                phase: 'done',
                itemUrl,
                logFile,
            });
        }
        // 引擎明确报错：按错误类型决定能不能重试
        const canRetry = ['NO_STEAM', 'ENGINE_TIMEOUT'].includes(r.code);
        const nextAction = r.code === 'NO_STEAM'
            ? '先启动并登录 Steam 客户端，再重新执行 node ' + path.basename(__filename)
            : '重新执行 node ' + path.basename(__filename);
        report.step('引擎失败 : [' + r.code + '] ' + (r.message || '').split('\n')[0]);
        report.step('引擎日志 : ' + logFile);
        return buildPayload('failed', '[' + r.code + '] ' + (r.message || '').split('\n')[0], {
            fileExists: remote.ok ? remote.exists : null,
            upToDate: false,
            remoteVerified: false,
            phase: 'failed',
            code: r.code === 'ENGINE_TIMEOUT' ? 'FAILED_TIMEOUT' : undefined,
            canRetry,
            nextAction,
            logFile,
        }, 1);
    }

    // 没拿到结果 = 超时。关键：不要陷入"未知状态下反复重试"。
    const stillRunning = !wait.exited;
    report.step('超时     : ' + (stillRunning ? '上传仍在后台进行（本进程不再等待）' : '上传进程已退出但没有留下结果'));
    report.step('引擎日志 : ' + logFile);
    return buildPayload('failed',
        stillRunning
            ? '超过 ' + opts.budgetSec + 's 预算，上传仍在后台进行；不要立刻重跑，先查状态'
            : '超过 ' + opts.budgetSec + 's 预算且上传进程已消失，可安全重跑',
        {
            fileExists: remote.ok ? remote.exists : null,
            upToDate: false,
            remoteVerified: false,
            phase: stillRunning ? 'uploading' : 'unknown',
            timedOut: true,
            canRetry: !stillRunning,
            nextAction: stillRunning
                ? '等待 30 秒后执行 node ' + path.basename(__filename) + ' --status'
                : '重新执行 node ' + path.basename(__filename),
            logFile,
        }, 2);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function makeReporter(quiet) {
    return {
        lines: [],
        step(msg) { this.lines.push(msg); if (!quiet) console.log('  ' + msg); },
        dump() { if (quiet) this.lines.forEach((l) => console.log('  ' + l)); },
    };
}

function buildPayload(status, message, extra, exitCode) {
    const payload = {
        status,
        message,
        fileExists: extra.fileExists === undefined ? null : extra.fileExists,
        canRetry: extra.canRetry === undefined ? (status === 'failed') : extra.canRetry,
        code: extra.code || (status === 'success' ? 'SUCCESS'
            : (extra.phase === 'uploading' ? 'PENDING' : (extra.timedOut ? 'FAILED_TIMEOUT' : 'FAILED'))),
        mod: extra.mod || null,
        upToDate: extra.upToDate === undefined ? null : extra.upToDate,
        remoteVerified: extra.remoteVerified === undefined ? null : extra.remoteVerified,
        phase: extra.phase || null,
        nextAction: extra.nextAction || (status === 'success' ? '无需操作' : '查看上方日志'),
    };
    if (extra.itemUrl) payload.itemUrl = extra.itemUrl;
    if (extra.logFile) payload.logFile = extra.logFile;
    if (extra.elapsedMs !== undefined) payload.elapsedMs = extra.elapsedMs;

    const marker = payload.code === 'SUCCESS' ? '[SUCCESS]'
        : payload.code === 'PENDING' ? '[PENDING]'
        : payload.code === 'NEEDS_UPLOAD' ? '[NEEDS_UPLOAD]'
        : payload.code === 'FAILED_TIMEOUT' ? '[FAILED_TIMEOUT]'
        : '[FAILED]';
    return { payload, marker, exitCode: exitCode === undefined ? (status === 'success' ? 0 : 1) : exitCode };
}

/** 唯一一处输出：状态码 + 结构化 JSON（保证 JSON 永远在最后，便于解析）。 */
function emit(entry) {
    console.log('');
    console.log(entry.marker);
    console.log(JSON.stringify(entry.payload, null, 2));
}

/** 退出前把 stdout 刷干净（管道模式下 process.exit 会截断输出）。 */
function flushExit(code) {
    process.exitCode = code;
    const done = () => process.exit(code);
    if (process.stdout.writableLength === 0) done();
    else process.stdout.write('', done);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { usage(); return { exitCode: 0 }; }

    const t0 = Date.now();
    const reporter = makeReporter(opts.quiet);

    // --list：一次看清所有模组
    if (opts.list) {
        const rows = [];
        for (const [id, m] of Object.entries(MODS)) {
            const mod = { ...m, id };
            const pack = syncContent(mod, opts, reporter);
            const itemId = readItemId(mod, pack);
            const remote = await queryRemote(itemId);
            const verdict = judgeFreshness(mod, pack, readJsonSafe(statePath(mod)), remote);
            rows.push({
                mod: id,
                title: m.title,
                itemId,
                upToDate: verdict.upToDate,
                remoteExists: remote.ok ? remote.exists : null,
                localBytes: pack.totalBytes,
                remoteBytes: remote.ok ? remote.fileSize : null,
                hash: pack.hash.slice(0, 12),
                reason: verdict.reason,
            });
            reporter.step(id + ': ' + (verdict.upToDate ? '最新' : '待上传') + '（' + verdict.reason + '）');
        }
        reporter.dump();
        return {
            entry: {
                payload: {
                    status: 'success',
                    message: '已列出 ' + rows.length + ' 个模组的状态',
                    fileExists: null,
                    canRetry: false,
                    code: 'SUCCESS',
                    phase: 'list',
                    mods: rows,
                    nextAction: '无需操作',
                    elapsedMs: Date.now() - t0,
                },
                marker: '[SUCCESS]',
            },
            exitCode: 0,
        };
    }

    let mod = resolveMod(opts);

    // 未指定模组：自动挑出"待上传"的那一个
    if (!mod) {
        const pending = [];
        const checked = [];
        for (const [id, m] of Object.entries(MODS)) {
            const cand = { ...m, id };
            try {
                const pack = syncContent(cand, opts, reporter);
                const remote = await queryRemote(readItemId(cand, pack));
                const verdict = judgeFreshness(cand, pack, readJsonSafe(statePath(cand)), remote);
                checked.push({ id, title: m.title, verdict, pack, remote });
                if (!verdict.upToDate) pending.push(cand);
            } catch (e) {
                reporter.step(id + ': 检查失败 ' + e.message);
            }
        }
        if (pending.length === 0) {
            checked.forEach((c) => reporter.step(c.id + ': 最新（' + c.verdict.reason + '）'));
            reporter.dump();
            return {
                entry: buildPayload('success', '所有已登记模组均为创意工坊最新版本，无需上传', {
                    fileExists: true, upToDate: true, remoteVerified: checked.every((c) => c.verdict.verified),
                    phase: 'checked',
                    elapsedMs: Date.now() - t0,
                    nextAction: '如需强制重传：node ' + path.basename(__filename) + ' --mod=<' + Object.keys(MODS).join('|') + '> --force',
                }, 0),
                exitCode: 0,
            };
        }
        if (pending.length > 1) {
            reporter.dump();
            throw new Error('有多个模组需要上传(' + pending.map((p) => p.id).join(', ') + ')，请用 --mod=<id> 指定');
        }
        mod = pending[0];
        reporter.step('自动选中待上传模组: ' + mod.id);
    }

    const res = await processMod(mod, opts, reporter);
    reporter.dump();
    res.payload.mod = mod.id;
    res.payload.elapsedMs = Date.now() - t0;
    return { entry: res, exitCode: res.exitCode };
}

main()
    .then((r) => {
        if (r && r.entry) emit(r.entry);
        flushExit(r && r.exitCode !== undefined ? r.exitCode : 0);
    })
    .catch((e) => {
        emit({
            marker: '[FAILED]',
            payload: {
                status: 'failed',
                message: (e && e.message) || String(e),
                fileExists: null,
                canRetry: true,
                code: 'FAILED',
                phase: 'error',
                nextAction: '修正上面的问题后重新执行 node ' + path.basename(__filename),
            },
        });
        flushExit(1);
    });
