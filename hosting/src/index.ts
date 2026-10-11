interface Env {
    DB: D1Database;
    BLOBS: R2Bucket;
    BASE_DOMAIN: string;
    LOCAL_DEV: string;
}

interface FileRow {
    path: string;
    sha256: string;
    size: number;
}

const MB = 1024 * 1024;

const mime: Record<string, string> = {
    html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm'
};

class Failure extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}

const now = () => Date.now();

const json = (v: unknown) => Response.json(v);

function fail(status: number, code: string, message: string): never {
    throw new Failure(status, code, message);
}

async function hash(value: ArrayBuffer | string): Promise<string> {
    const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

function randomToken() {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function siteId() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    while (out.length < 10) {
        for (const n of crypto.getRandomValues(new Uint8Array(16))) {
            if (n < 252 && out.length < 10) {
                out += alphabet[n % 36];
            }
        }
    }
    return out;
}

async function bytes(req: Request, max: number) {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
        while (true) {
            const part = await reader.read();
            if (part.done) {
                break;
            }
            size += part.value.length;
            if (size > max) {
                await reader.cancel();
                fail(413, 'too_big', '上传内容太大了');
            }
            chunks.push(part.value);
        }
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out.buffer;
}

async function body(req: Request): Promise<any> {
    try {
        return JSON.parse(new TextDecoder().decode(await bytes(req, 2 * MB)));
    }
    catch (e) {
        if (e instanceof Failure) {
            throw e;
        }
        return fail(400, 'server', '请求格式不正确');
    }
}

function device(req: Request) {
    const d = req.headers.get('X-Sikeoop-Device') || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(d)) {
        fail(401, 'server', '设备身份无效');
    }
    return d;
}

function urlFor(req: Request, e: Env, id: string) {
    return e.LOCAL_DEV === 'true' ? `${new URL(req.url).origin}/s/${id}/` : `https://${id}.${e.BASE_DOMAIN}/`;
}

async function authorize(req: Request, e: Env, id: string) {
    const d = device(req);
    const token = req.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) {
        fail(401, 'server', '站点凭证无效');
    }
    const row = await e.DB.prepare('SELECT id FROM sites WHERE id=? AND device=? AND token_hash=?').bind(id, d, await hash(token)).first();
    if (!row) {
        fail(401, 'server', '站点凭证无效');
    }
}

async function commitDeploy(req: Request, e: Env, id: string, dep: string): Promise<Response> {
    await body(req);
    const exists = await e.DB.prepare('SELECT id FROM deploys WHERE id=? AND site=?').bind(dep, id).first();
    if (!exists) {
        fail(400, 'server', '这次发布不存在');
    }
    const rows = await e.DB.prepare('SELECT sha,size FROM files WHERE deploy=?').bind(dep).all<{
        sha: string;
        size: number;
    }>();
    let total = 0;
    for (const f of rows.results) {
        const obj = await e.BLOBS.head(f.sha);
        if (!obj || obj.size !== f.size) {
            fail(400, 'server', '文件还没有上传完整');
        }
        total += f.size;
    }
    const r = await e.DB.prepare('UPDATE sites SET active=?,accessed=? WHERE id=? AND EXISTS(SELECT 1 FROM deploys WHERE id=? AND site=?)').bind(dep, now(), id, dep, id).run();
    if (!r.meta.changes) {
        fail(400, 'server', '站点已下线');
    }
    return json({
        url: urlFor(req, e, id), fileCount: rows.results.length, bytes: total
    });
}

async function uploadBlob(req: Request, e: Env, id: string, sha: string): Promise<Response> {
    const f = await e.DB.prepare('SELECT f.size FROM files f JOIN deploys d ON d.id=f.deploy WHERE d.site=? AND f.sha=? LIMIT 1').bind(id, sha).first<{
        size: number;
    }>();
    if (!f) {
        fail(400, 'server', '请先创建包含该文件的发布');
    }
    const data = await bytes(req, 5 * MB);
    if (data.byteLength !== f.size || await hash(data) !== sha) {
        fail(400, 'server', '文件大小或哈希不匹配，请重新上传');
    }
    await e.BLOBS.put(sha, data);
    return new Response(null, {
        status: 204
    });
}

async function createDeploy(req: Request, e: Env, id: string): Promise<Response> {
    const b = await body(req);
    if (!b || !Array.isArray(b.files) || !b.files.length || b.files.length > 10000) {
        fail(400, 'server', '文件列表无效');
    }
    const files: FileRow[] = b.files;
    const paths = new Set<string>();
    const hashes = new Map<string, number>();
    let total = 0;
    for (const f of files) {
        if (!f || typeof f.path !== 'string' || f.path.length > 1024 || f.path.startsWith('/') || /[\\\x00-\x1f?#%]/.test(f.path) || f.path.split('/').some(x => !x || x === '.' || x === '..') || paths.has(f.path)) {
            fail(400, 'blocked_file', '文件路径不安全或重复');
        }
        const ext = f.path.split('.').pop()!.toLowerCase();
        if (!mime[ext]) {
            fail(400, 'blocked_file', '这个文件类型暂不支持发布');
        }
        if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > 5 * MB) {
            fail(413, 'too_big', '单个文件不能超过 5MB');
        }
        total += f.size;
        if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || (hashes.has(f.sha256) && hashes.get(f.sha256) !== f.size)) {
            fail(400, 'server', '文件哈希或大小无效');
        }
        paths.add(f.path);
        hashes.set(f.sha256, f.size);
    }
    if (total > 10 * MB) {
        fail(413, 'too_big', '单个站点不能超过 10MB');
    }
    if (!paths.has('index.html')) {
        fail(400, 'server', '站点缺少 index.html');
    }
    const deployId = crypto.randomUUID();
    // A single JSON statement avoids D1's SQL parameter limit on large manifests.
    await e.DB.batch([
        e.DB.prepare('INSERT INTO deploys(id,site,created) VALUES(?,?,?)').bind(deployId, id, now()), e.DB.prepare("INSERT INTO files(deploy,path,sha,size) SELECT ?,json_extract(value,'$.path'),json_extract(value,'$.sha256'),json_extract(value,'$.size') FROM json_each(?)").bind(deployId, JSON.stringify(files))
    ]);
    const missing: string[] = [];
    for (const [sha, size] of hashes) {
        const object = await e.BLOBS.head(sha);
        if (!object || object.size !== size) {
            missing.push(sha);
        }
    }
    return json({
        deployId, missing
    });
}

async function reportSite(req: Request, e: Env): Promise<Response> {
    const ip = req.headers.get('CF-Connecting-IP') || (e.LOCAL_DEV === 'true' ? 'local' : 'unknown');
    const key = await hash(ip);
    const window = Math.floor(now() / 3600000);
    const r = await e.DB.prepare('INSERT INTO rate_limits(ip,window,count) VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count').bind(key, window).first<{
        count: number;
    }>();
    if (!r || r.count > 5) {
        fail(429, 'quota', '举报太频繁，请稍后再试');
    }
    const b = await body(req);
    if (!b || !/^[a-z0-9]{10}$/.test(b.siteId) || typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 2000) {
        fail(400, 'server', '请填写有效的站点和举报原因');
    }
    await e.DB.prepare('INSERT INTO reports(site,reason,created) VALUES(?,?,?)').bind(b.siteId, b.reason.trim(), now()).run();
    return new Response(null, {
        status: 204
    });
}

async function createSite(req: Request, e: Env): Promise<Response> {
    const d = device(req);
    await body(req);
    const id = siteId();
    const token = randomToken();
    const r = await e.DB.prepare('INSERT INTO sites(id,device,token_hash,accessed) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM sites WHERE device=?)<20').bind(id, d, await hash(token), now(), d).run();
    if (!r.meta.changes) {
        fail(429, 'quota', '每台设备最多发布 20 个站点');
    }
    return json({
        siteId: id, siteToken: token, url: urlFor(req, e, id)
    });
}

async function handle(req: Request, e: Env): Promise<Response> {
    const u = new URL(req.url);
    const p = u.pathname;
    const sub = u.hostname.endsWith('.' + e.BASE_DOMAIN) ? u.hostname.slice(0, -e.BASE_DOMAIN.length - 1) : '';
    if (/^[a-z0-9]{10}$/.test(sub)) {
        return serve(req, e, sub, p.slice(1));
    }
    if (p === '/v1/sites' && req.method === 'POST') {
        return createSite(req, e);
    }
    if (p === '/v1/report' && req.method === 'POST') {
        return reportSite(req, e);
    }
    const match = p.match(/^\/v1\/sites\/([a-z0-9]{10})(?:\/(.*))?$/);
    if (match) {
        const id = match[1];
        const tail = match[2] || '';
        await authorize(req, e, id);
        if (!tail && req.method === 'DELETE') {
            await e.DB.prepare('DELETE FROM sites WHERE id=?').bind(id).run();
            return new Response(null, {
                status: 204
            });
        }
        if (tail === 'deploy' && req.method === 'POST') {
            return createDeploy(req, e, id);
        }
        const blob = tail.match(/^blobs\/([a-f0-9]{64})$/);
        if (blob && req.method === 'PUT') {
            return uploadBlob(req, e, id, blob[1]);
        }
        const commit = tail.match(/^deploy\/([a-f0-9-]{36})\/commit$/);
        if (commit && req.method === 'POST') {
            return commitDeploy(req, e, id, commit[1]);
        }
    }
    const local = p.match(/^\/s\/([a-z0-9]{10})(?:\/(.*))?$/);
    if (local && e.LOCAL_DEV === 'true') {
        if (!p.endsWith('/') && local[2] === undefined) {
            return Response.redirect(u.origin + p + '/', 302);
        }
        return serve(req, e, local[1], local[2] || '');
    }
    if (p === '/report' && req.method === 'GET') {
        return new Response(`<!doctype html><meta charset="utf-8"><title>举报站点</title><h1>举报站点</h1><form id="report"><input name="siteId" pattern="[a-z0-9]{10}" required placeholder="站点 ID"><textarea name="reason" maxlength="2000" required placeholder="举报原因"></textarea><button>提交举报</button></form><p id="result"></p><script>document.querySelector('[name=siteId]').value=new URLSearchParams(location.search).get('siteId')||'';document.querySelector('form').onsubmit=async event=>{event.preventDefault();try{const r=await fetch('/v1/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});document.querySelector('#result').textContent=r.ok?'举报已收到':(await r.json()).error.message}catch{document.querySelector('#result').textContent='提交失败，请稍后重试'}};</script>`, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8'
            }
        });
    }
    return fail(404, 'server', '没有找到这个页面');
}

async function serve(req: Request, e: Env, id: string, path: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return fail(405, 'server', '不支持这个请求');
    }
    try {
        path = decodeURIComponent(path || 'index.html');
    }
    catch {
        return fail(400, 'blocked_file', '文件路径无效');
    }
    if (path.split('/').some(x => x === '..' || x === '.') || /[\\\x00]/.test(path)) {
        return fail(400, 'blocked_file', '文件路径无效');
    }
    const f = await e.DB.prepare('SELECT f.sha,f.size FROM sites s JOIN files f ON f.deploy=s.active WHERE s.id=? AND f.path=?').bind(id, path).first<{
        sha: string;
        size: number;
    }>();
    if (!f) {
        return fail(404, 'server', '页面不存在或已下线');
    }
    const obj = await e.BLOBS.get(f.sha);
    if (!obj) {
        return fail(404, 'server', '文件暂时不可用');
    }
    await e.DB.prepare('UPDATE sites SET accessed=? WHERE id=?').bind(now(), id).run();
    const ext = path.split('.').pop()!.toLowerCase();
    const headers = {
        'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-store'
    };
    let content: BodyInit = obj.body;
    if (ext === 'html') {
        const footer = `<footer style="padding:16px;text-align:center;font:12px sans-serif">用 sikeoop 制作 · <a href="https://api.${e.BASE_DOMAIN}/report?siteId=${id}" target="_blank" rel="noopener noreferrer">举报</a></footer>`;
        const link = e.LOCAL_DEV === 'true' ? footer.replace(`https://api.${e.BASE_DOMAIN}`, new URL(req.url).origin) : footer;
        let hasBody = false;
        content = new HTMLRewriter().on('body', {
            element(el) {
                hasBody = true;
                el.append(link, {
                    html: true
                });
            }
        }).onDocument({
            end(end) {
                if (!hasBody) {
                    end.append(link, {
                        html: true
                    });
                }
            }
        }).transform(new Response(obj.body)).body!;
    }
    return new Response(req.method === 'HEAD' ? null : content, {
        headers
    });
}

export default {
    async fetch(req: Request, e: Env): Promise<Response> {
        let response: Response;
        try {
            response = await handle(req, e);
        }
        catch (err) {
            const f = err instanceof Failure ? err : new Failure(500, 'server', '服务暂时不可用，请稍后重试');
            if (!(err instanceof Failure)) {
                console.error('Hosting request failed');
            }
            response = Response.json({
                error: {
                    code: f.code, message: f.message
                }
            }, {
                status: f.status
            });
        }
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', "form-action 'self'; base-uri 'self'; object-src 'none'");
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        headers.set('X-Frame-Options', 'DENY');
        headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        headers.set('Cache-Control', 'no-store');
        return new Response(response.body, {
            status: response.status, headers
        });
    },
    async scheduled(_controller: ScheduledController, e: Env): Promise<void> {
        const cutoff = now() - 30 * 86400000;
        await e.DB.batch([
            e.DB.prepare('DELETE FROM sites WHERE accessed<?').bind(cutoff), e.DB.prepare('DELETE FROM deploys WHERE created<? AND id NOT IN (SELECT active FROM sites WHERE active IS NOT NULL)').bind(cutoff), e.DB.prepare('DELETE FROM rate_limits WHERE window<?').bind(Math.floor(now() / 3600000) - 48)
        ]);
    }
} satisfies ExportedHandler<Env>;
