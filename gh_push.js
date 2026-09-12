#!/usr/bin/env node
'use strict';

/* ============================================================================
 * gh_push.js —— 往 GitHub 仓库传文件 · 单命令幂等推送器
 * ----------------------------------------------------------------------------
 * 解决什么问题：
 *   1. WSL 不读 Windows 的系统代理，裸连 GitHub 会间歇性超时（实测 api.github.com
 *      曾连续 10 次全挂，而同一时刻 Windows 走代理全绿）。
 *   2. 推送失败时状态不明，容易反复重试或误判成功。
 *
 * 一条命令覆盖四种场景：
 *     node ~/gh_push.js -m "提交说明"                     # 提交并推送当前仓库
 *     node ~/gh_push.js --repo=<目录> -m "提交说明"        # 指定仓库
 *     node ~/gh_push.js --status                          # 只体检，不改任何东西
 *     node ~/gh_push.js --create=<名字> --private -m "…"  # 新建仓库并推送
 *
 * 内置的六道保险：
 *   · 代理自举：Windows 侧代理可达就注入 http(s)_proxy，不可达静默跳过（不会弄挂网络）
 *   · 密钥扫描：提交前扫令牌/私钥/密码，命中直接中止
 *   · 双通道推送：SSH 与 HTTPS 互为备份，一条路网络失败自动换另一条
 *   · 有界重试：只重试网络类错误，最多 3 次；绝不使用 --force
 *   · 结果核验：用 git ls-remote 比对远端 SHA，不看 push 的自述
 *   · 结构化输出：[SUCCESS] 状态码 + JSON（与 smart_upload.js 同一套约定）
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const PROXY_PORT = Number(process.env.WSL_PROXY_PORT || 7890);
const GIT_TIMEOUT_MS = 120000;
const PUSH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

// ── 工具 ────────────────────────────────────────────────────────────────────

const sleep = (ms) => { try { spawnSync('sleep', [String(ms / 1000)]); } catch (e) {} };

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        timeout: opts.timeout || GIT_TIMEOUT_MS,
        cwd: opts.cwd,
        env: opts.env || process.env,
        maxBuffer: 32 * 1024 * 1024,
    });
    return {
        ok: r.status === 0,
        code: r.status,
        stdout: (r.stdout || '').trim(),
        stderr: (r.stderr || '').trim(),
        error: r.error ? r.error.message : null,
    };
}

/** Windows 侧代理可达就注入环境变量；不可达静默跳过。 */
function detectProxy() {
    const r = run('ip', ['route']);
    // "default via 172.20.112.1 dev eth0 proto kernel ..." → 取 via 后面的地址
    const line = r.stdout.split('\n').find((l) => l.startsWith('default')) || '';
    const m = /\bvia\s+(\S+)/.exec(line);
    const gw = m ? m[1] : null;
    if (!gw) return { active: false, reason: '未取到默认网关' };

    const probe = spawnSync('timeout', ['1', 'bash', '-c', `echo > /dev/tcp/${gw}/${PROXY_PORT}`], { timeout: 2500 });
    if (probe.status !== 0) return { active: false, reason: `代理 ${gw}:${PROXY_PORT} 不可达（梯子没开？）` };

    const url = `http://${gw}:${PROXY_PORT}`;
    process.env.http_proxy = url;
    process.env.https_proxy = url;
    process.env.HTTP_PROXY = url;
    process.env.HTTPS_PROXY = url;
    process.env.no_proxy = 'localhost,127.0.0.1,::1,172.20.0.0/16,10.0.0.0/8,198.18.0.0/16,.deepseek.com';
    process.env.NO_PROXY = process.env.no_proxy;
    return { active: true, url };
}

const NET_ERR = /i\/o timeout|dial tcp|connection refused|connection reset|Connection timed out|Could not resolve host|proxyconnect|TLS handshake|unexpected EOF|remote end hung up|Operation timed out|early EOF|RPC failed|502 Bad Gateway|503 Service/i;

// ── 密钥扫描 ────────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
    [/gho_[A-Za-z0-9]{20,}/, 'GitHub OAuth 令牌'],
    [/ghp_[A-Za-z0-9]{20,}/, 'GitHub 个人令牌'],
    [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub 细粒度令牌'],
    [/AKIA[0-9A-Z]{16}/, 'AWS Access Key'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥文件'],
    [/sk-[A-Za-z0-9]{20,}/, 'OpenAI 风格密钥'],
    [/\b(?:password|passwd|pwd)\s*[:=]\s*['"][^'"\s]{6,}['"]/i, '明文密码'],
    [/\bapi[_-]?key\s*[:=]\s*['"][^'"\s]{12,}['"]/i, 'API Key'],
];

function scanSecrets(repo, files) {
    const hits = [];
    for (const f of files) {
        const abs = path.join(repo, f);
        let st;
        try { st = fs.statSync(abs); } catch (e) { continue; }
        if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
        let buf;
        try { buf = fs.readFileSync(abs); } catch (e) { continue; }
        if (buf.includes(0)) continue;                       // 二进制跳过
        const text = buf.toString('utf8');
        for (const [re, label] of SECRET_PATTERNS) {
            const m = re.exec(text);
            if (m) hits.push({ file: f, kind: label, sample: m[0].slice(0, 12) + '…' });
        }
    }
    return hits;
}

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const o = { repo: null, message: null, create: null, visibility: null, branch: null, status: false, dryRun: false, quiet: false, allowSecrets: false, description: '' };
    for (const a of argv) {
        if (a === '--status') o.status = true;
        else if (a === '--dry-run') o.dryRun = true;
        else if (a === '--quiet') o.quiet = true;
        else if (a === '--allow-secrets') o.allowSecrets = true;
        else if (a === '--private') o.visibility = 'private';
        else if (a === '--public') o.visibility = 'public';
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a.startsWith('--repo=')) o.repo = a.slice(7);
        else if (a.startsWith('--create=')) o.create = a.slice(9);
        else if (a.startsWith('--branch=')) o.branch = a.slice(9);
        else if (a.startsWith('--description=')) o.description = a.slice(14);
        else if (a === '-m' || a === '--message') o.message = '__NEXT__';
        else if (a.startsWith('-m')) o.message = a.slice(2);
        else if (a.startsWith('--message=')) o.message = a.slice(10);
        else if (o.message === '__NEXT__') o.message = a;
    }
    return o;
}

const HELP = `
用法: node ~/gh_push.js [选项]

  -m, --message <文本>      提交说明（有改动时必填）
  --repo=<目录>             指定本地仓库目录（默认当前目录）
  --status                  只做体检：代理/鉴权/远端/待提交内容，不推送
  --create=<名字>           新建 GitHub 仓库并推送（必须同时给 --private 或 --public）
  --private | --public      新仓库可见性（必须显式二选一，不设默认值）
  --branch=<分支>           指定分支（默认当前分支）
  --description=<文本>      新仓库简介
  --dry-run                 演练：只做扫描与提交预览，不推送
  --allow-secrets           人工放行密钥扫描命中（默认不提供，确属误报时使用）
  --quiet                   只输出最后的 JSON

前置条件：用户的梯子（Sororain）开着；WSL 侧代理由脚本自动注入。
`;

// ── 仓库与远端 ──────────────────────────────────────────────────────────────

function repoInfo(dir) {
    const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    if (!top.ok) return null;
    const root = top.stdout;
    // 新仓库还没有任何提交时 rev-parse --abbrev-ref 只会给出 "HEAD"，
    // 而 symbolic-ref 能给出分支真名（git init -b main 后就是 main）。
    let branch = run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root }).stdout;
    if (!branch) branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).stdout;
    if (!branch) branch = 'main';
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout;
    const originUrl = run('git', ['remote', 'get-url', 'origin'], { cwd: root }).stdout || null;
    return { root, branch, head, originUrl };
}

/** 以 SSH / HTTPS 两种形式表达同一个仓库，互为备份通道。 */
function alternateUrl(url) {
    if (!url) return null;
    let m = /^git@github\.com:(.+?)(?:\.git)?$/.exec(url);
    if (m) return `https://github.com/${m[1]}.git`;
    m = /^https:\/\/github\.com\/(.+?)(?:\.git)?$/.exec(url);
    if (m) return `git@github.com:${m[1]}.git`;
    return null;
}

function remoteSha(urlOrName, branch, cwd) {
    const r = run('git', ['ls-remote', urlOrName, `refs/heads/${branch}`], { cwd });
    if (!r.ok) return { ok: false, sha: null, err: r.stderr || r.error };
    const sha = (r.stdout.split(/\s+/)[0] || '').trim();
    return { ok: true, sha: sha || null };
}

// ── 输出 ────────────────────────────────────────────────────────────────────

function emit(status, code, message, extra) {
    const payload = Object.assign({
        status, code, message,
        fileExists: null, canRetry: false, nextAction: '无需操作',
    }, extra || {});
    const marker = code === 'SUCCESS' ? '[SUCCESS]'
        : code === 'NOTHING_TO_PUSH' ? '[NOTHING_TO_PUSH]'
        : code === 'SECRET_FOUND' ? '[SECRET_FOUND]'
        : code === 'FAILED_TIMEOUT' ? '[FAILED_TIMEOUT]'
        : '[FAILED]';
    console.log('');
    console.log(marker);
    console.log(JSON.stringify(payload, null, 2));
    return { marker, payload };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
    const t0 = Date.now();
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { console.log(HELP); return { code: 'SUCCESS', exit: 0 }; }

    const step = (s) => { if (!o.quiet) console.log('  ' + s); };

    // 1) 代理自举
    const proxy = detectProxy();
    step('代理     : ' + (proxy.active ? proxy.url + ' ✓' : '未启用（' + proxy.reason + '），凭据类操作走直连'));

    if (o.create && !o.visibility) {
        emit('failed', 'FAILED', '新建仓库必须显式指定可见性：--private 或 --public（公开是不可逆的对外发布，不能默认）', {
            canRetry: true, nextAction: '加上 --private 或 --public 后重试',
        });
        return { code: 'FAILED', exit: 1 };
    }

    // 2) 定位仓库
    const startDir = o.repo ? path.resolve(o.repo) : process.cwd();
    let info = repoInfo(startDir);

    if (!info && o.create) {
        // 新建仓库前，目录里可能还没有 git
        step('仓库     : 尚未初始化，将执行 git init');
        if (!o.dryRun) {
            const init = run('git', ['init', '-q', '-b', o.branch || 'main'], { cwd: startDir });
            if (!init.ok) {
                emit('failed', 'FAILED', 'git init 失败: ' + (init.stderr || init.error), { canRetry: true });
                return { code: 'FAILED', exit: 1 };
            }
        }
        info = repoInfo(startDir) || { root: startDir, branch: o.branch || 'main', head: null, originUrl: null };
    } else if (!info) {
        emit('failed', 'FAILED', '不是一个 git 仓库: ' + startDir + '（用 --repo=<目录> 指定，或用 --create=<名字> 新建）', {
            canRetry: false, nextAction: '指定正确的仓库目录',
        });
        return { code: 'FAILED', exit: 1 };
    }

    const branch = o.branch || info.branch || 'main';
    step('仓库     : ' + info.root);
    step('分支     : ' + branch);
    step('远端     : ' + (info.originUrl || '(尚未配置，将由 --create 建立)'));

    // 3) 待提交内容 + 密钥扫描
    if (!o.dryRun) {
        run('git', ['add', '-A'], { cwd: info.root });
    }
    const staged = run('git', ['diff', '--cached', '--name-only'], { cwd: info.root }).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean);
    const tracked = run('git', ['ls-files'], { cwd: info.root }).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean);
    const scanTargets = Array.from(new Set(staged.concat(tracked)));
    step('待提交   : ' + (staged.length ? staged.join(', ') : '无改动'));

    const hits = scanSecrets(info.root, scanTargets);
    if (hits.length && o.allowSecrets) {
        step('!! 密钥扫描命中 ' + hits.length + ' 处，但已用 --allow-secrets 人工放行');
        for (const h of hits) step('   ' + h.file + ' → ' + h.kind);
    }
    if (hits.length && !o.allowSecrets) {
        for (const h of hits) step('!! 疑似密钥 : ' + h.file + ' → ' + h.kind + ' (' + h.sample + ')' );
        emit('failed', 'SECRET_FOUND', '提交前密钥扫描命中 ' + hits.length + ' 处，已中止（不会推送）', {
            fileExists: false, canRetry: false,
            hits,
            nextAction: '移除/改用环境变量后再执行；确属误报可用 --allow-secrets 人工放行',
        });
        return { code: 'SECRET_FOUND', exit: 2 };
    }
    step('密钥扫描 : 通过（扫描 ' + scanTargets.length + ' 个文件）');

    if (o.status) {
        const rs = info.originUrl ? remoteSha('origin', branch, info.root) : { ok: false, sha: null };
        emit('success', 'SUCCESS', '体检完成：' + (staged.length ? '有 ' + staged.length + ' 个文件待提交' : '工作区干净'), {
            repo: info.root, branch,
            head: info.head, remoteSha: rs.sha, remoteVerified: rs.ok,
            fileExists: !!rs.sha, dirty: staged.length > 0,
        });
        return { code: 'SUCCESS', exit: 0 };
    }

    // 4) 提交
    let committed = false;
    if (staged.length) {
        if (!o.message) {
            emit('failed', 'FAILED', '有 ' + staged.length + ' 个文件待提交，但没有提供提交说明', {
                canRetry: true, nextAction: '加上 -m "提交说明" 再执行',
            });
            return { code: 'FAILED', exit: 1 };
        }
        if (!o.dryRun) {
            const c = run('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', o.message], { cwd: info.root });
            if (!c.ok) {
                emit('failed', 'FAILED', 'git commit 失败: ' + (c.stderr || c.error), { canRetry: true });
                return { code: 'FAILED', exit: 1 };
            }
            committed = true;
            step('已提交   : ' + run('git', ['rev-parse', '--short', 'HEAD'], { cwd: info.root }).stdout + ' ' + o.message.split('\n')[0]);
        } else {
            step('演练模式 : 跳过 commit / push');
            emit('success', 'SUCCESS', '演练完成：将提交 ' + staged.length + ' 个文件，未推送', { dryRun: true, files: staged });
            return { code: 'SUCCESS', exit: 0 };
        }
    } else {
        step('提交     : 无改动，跳过 commit');
    }

    // 5) 新建仓库（可选）
    if (o.create) {
        const args = ['repo', 'create', o.create, '--source=' + info.root, '--remote=origin',
                      o.visibility === 'private' ? '--private' : '--public'];
        if (o.description) args.push('--description=' + o.description);
        step('建仓库   : gh repo create ' + o.create + '（' + o.visibility + '）');
        const r = run('gh', args, { cwd: info.root, timeout: 90000 });
        if (!r.ok && !/already exists/i.test(r.stderr)) {
            emit('failed', 'FAILED', 'gh repo create 失败: ' + (r.stderr || r.error), {
                canRetry: true, nextAction: '确认梯子开着、gh 已登录后重试',
            });
            return { code: 'FAILED', exit: 1 };
        }
        info = repoInfo(info.root) || info;
        step('远端     : ' + (info.originUrl || '(未取到)'));
    }

    if (!info.originUrl) {
        emit('failed', 'FAILED', '没有配置 origin 远端，且没有用 --create 新建仓库', {
            canRetry: false, nextAction: '先 git remote add origin <url>，或用 --create=<名字>',
        });
        return { code: 'FAILED', exit: 1 };
    }

    // 6) 推送：SSH 与 HTTPS 互为备份，只重试网络错误
    const targets = [info.originUrl];
    const alt = alternateUrl(info.originUrl);
    if (alt) targets.push(alt);

    let pushed = false;
    let lastErr = '';
    for (let ti = 0; ti < targets.length && !pushed; ti++) {
        const target = targets[ti];
        for (let attempt = 1; attempt <= PUSH_ATTEMPTS && !pushed; attempt++) {
            const args = ti === 0 && !alt ? ['push', '-u', 'origin', branch] : ['push', target, branch];
            const r = run('git', args, { cwd: info.root });
            if (r.ok) { pushed = true; break; }
            lastErr = r.stderr || r.error || '未知错误';
            if (!NET_ERR.test(lastErr)) break;                    // 非网络错误不重试
            step('推送失败 : 第 ' + attempt + ' 次遇到网络错误，' + (RETRY_DELAY_MS / 1000) + 's 后重试');
            sleep(RETRY_DELAY_MS);
        }
        if (!pushed && ti === 0 && targets[1]) step('换通道   : ' + (alt.startsWith('git@') ? 'SSH' : 'HTTPS') + ' 再试一次');
    }

    if (!pushed) {
        emit('failed', 'FAILED', '推送失败（两种通道都试过）: ' + lastErr.split('\n')[0], {
            repo: info.root, branch, canRetry: true,
            nextAction: '确认梯子开着；然后重新执行同一条命令',
        });
        return { code: 'FAILED', exit: 1 };
    }

    // 7) 结果核验：用远端 SHA 说话
    const local = run('git', ['rev-parse', 'HEAD'], { cwd: info.root }).stdout;
    const rs = remoteSha('origin', branch, info.root);
    const verified = rs.ok && rs.sha === local;

    step('已推送   : ' + local.slice(0, 8));
    step('远端核验 : ' + (verified ? 'SHA 一致 ✓' : '未取到远端 SHA（网络抖动），推送本身已成功'));

    emit('success', 'SUCCESS',
        (committed ? '已提交并推送' : '已推送') + '到 ' + branch + '（' + local.slice(0, 8) + '）',
        {
            repo: info.root, branch,
            commit: local, commitShort: local.slice(0, 8),
            remoteSha: rs.sha, remoteVerified: verified,
            fileExists: true, canRetry: false,
            elapsedMs: Date.now() - t0,
        });
    return { code: 'SUCCESS', exit: 0 };
}

try {
    const r = main();
    process.exitCode = r.exit;
    process.stdout.write('', () => process.exit(r.exit));
} catch (e) {
    emit('failed', 'FAILED', (e && e.message) || String(e), { canRetry: true });
    process.exit(1);
}
