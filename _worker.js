// Cloudflare Worker - 极限性能版优选工具 (v5.3 稳定版：修复 EOF 报错，剔除错误伪装，纯净直连)

const DEFAULT_CONFIG = {
    epd: false, epi: false, egi: true,
    ev: true, et: false, vm: false,
    scu: 'https://url.v1.mk/sub', 
    enableECH: false,
    customDNS: 'https://dns.joeyblog.eu.org/joeyblog',
    customECHDomain: 'dash.cloudflare.com',
    defaultIPURL: 'https://gist.githubusercontent.com/shiyikeji/3aa87176e89a34e48f72487fbbada9d2/raw/my_best_ips.txt'
};

const directDomains = [
    { domain: 'yx.cloudflare.182682.xyz', name: 'YM-亚太' },
    { domain: 'cdn.2020111.xyz', name: 'YM-亚太' },
    { domain: 'yx.cf.licdn.top', name: 'YM-亚太' },
    { domain: 'speed.marisalnc.com', name: 'YM-亚太' },
    { domain: 'freeyx.cloudflare88.eu.org', name: 'YM-亚太' },
    { domain: 'youxuan.cf.090227.xyz', name: 'YM-亚太' },
    { domain: 'mfa.gov.ua', name: 'YM-亚太' },
    { domain: 'cf.tencentapp.cn', name: 'YM-亚太' },
    { domain: 'cf.877774.xyz', name: 'YM-亚太' },
    { domain: 'ct.877774.xyz', name: 'YM-电信' },
    { domain: 'cmcc.877774.xyz', name: 'YM-移动' }
];

// ================= 辅助与性能核心 =================

function safeBase64Encode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const chunkSize = 8192; 
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function parseToArray(content) {
    return content.replace(/[\t"'\\r\\n]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '').split(',');
}

async function fetchWithTimeout(url, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    } finally {
        clearTimeout(timer);
    }
}

async function hashKey(str) {
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ================= 全局 KV 缓存架构 =================
async function getCachedData(env, ctx, key, fetcher, ttl = 600) {
    if (env?.IP_CACHE) {
        const cached = await env.IP_CACHE.get(key, 'json');
        if (cached && cached.length > 0) return cached;
        const freshData = await fetcher();
        if (freshData && freshData.length > 0) {
            ctx.waitUntil(env.IP_CACHE.put(key, JSON.stringify(freshData), { expirationTtl: ttl }));
        }
        return freshData;
    }
    return await fetcher();
}

// ================= 数据源抓取 =================
async function fetchAndParseWetestAPI(url) {
    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) return [];
        return parseRawIps((await response.text()).trim().split('\n').filter(l => l));
    } catch (e) { return []; }
}

async function fetchDynamicIPs(env, ctx, ipv4Enabled, ipv6Enabled, ispMobile, ispUnicom, ispTelecom) {
    const v4Url = "https://www.wetest.vip/page/cloudflare/address_v4.txt";
    const v6Url = "https://www.wetest.vip/page/cloudflare/address_v6.txt";
    const fetchPromises = [
        ipv4Enabled ? getCachedData(env, ctx, 'wetest_v4', () => fetchAndParseWetestAPI(v4Url)) : [],
        ipv6Enabled ? getCachedData(env, ctx, 'wetest_v6', () => fetchAndParseWetestAPI(v6Url)) : []
    ];
    try {
        const [ipv4List, ipv6List] = await Promise.all(fetchPromises);
        let results = [...ipv4List, ...ipv6List];
        if (results.length > 0) {
            results = results.filter(item => {
                const name = item.name || '';
                if (name.includes('移动') && !ispMobile) return false;
                if (name.includes('联通') && !ispUnicom) return false;
                if (name.includes('电信') && !ispTelecom) return false;
                return true;
            });
        }
        return results;
    } catch (e) { return []; }
}

async function fetchOptimizedAPI(urls, defaultPort = '443', timeoutMs = 3000) {
    if (!urls?.length) return [];
    const results = new Set();
    await Promise.allSettled(urls.map(async (url) => {
        try {
            const response = await fetchWithTimeout(url, timeoutMs);
            const buffer = await response.arrayBuffer();
            let text = new TextDecoder('utf-8').decode(buffer);
            if (text.includes('\ufffd')) text = new TextDecoder('gb2312').decode(buffer);
            if (!text || !text.trim()) return;
            const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l);
            const isCSV = lines.length > 1 && lines[0].includes(',');
            const IPV6_PATTERN = /^[^\[\]]*:[^\[\]]*:[^\[\]]/;
            if (!isCSV) {
                for (const line of lines) {
                    const hashIndex = line.indexOf('#');
                    const [hostPart, remark] = hashIndex > -1 ? [line.substring(0, hashIndex), line.substring(hashIndex)] : [line, ''];
                    let hasPort = hostPart.startsWith('[') ? /\]:(\d+)$/.test(hostPart) : (hostPart.lastIndexOf(':') > -1 && /^\d+$/.test(hostPart.substring(hostPart.lastIndexOf(':') + 1)));
                    const port = new URL(url).searchParams.get('port') || defaultPort;
                    results.add(hasPort ? line : `${hostPart}:${port}${remark}`);
                }
            } else {
                const headers = lines[0].split(',').map(h => h.trim());
                const ipIdx = headers.indexOf('IP地址'), portIdx = headers.indexOf('端口');
                if (ipIdx > -1 && portIdx > -1) {
                    const remarkIdx = headers.indexOf('国家') > -1 ? headers.indexOf('国家') : (headers.indexOf('数据中心') > -1 ? headers.indexOf('数据中心') : ipIdx);
                    for (const line of lines.slice(1)) {
                        const cols = line.split(',').map(c => c.trim());
                        const wrappedIP = IPV6_PATTERN.test(cols[ipIdx]) ? `[${cols[ipIdx]}]` : cols[ipIdx];
                        results.add(`${wrappedIP}:${cols[portIdx]}#${cols[remarkIdx]}`);
                    }
                }
            }
        } catch (e) {}
    }));
    return Array.from(results);
}

async function fetchGitHubIPs(env, ctx, piu) {
    const url = piu || DEFAULT_CONFIG.defaultIPURL;
    const hashedUrl = await hashKey(url);
    return getCachedData(env, ctx, `github_${hashedUrl}`, async () => {
        try {
            const response = await fetchWithTimeout(url);
            if (!response.ok) return [];
            return parseRawIps((await response.text()).trim().replace(/\r/g, "").split('\n'));
        } catch (e) { return []; }
    });
}

function parseRawIps(rawIps) {
    const results = [];
    const regex = /^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9.-]+)(?::(\d+))?(?:#(.+))?$/;
    for (const raw of rawIps) {
        const match = raw.match(regex);
        if (!match) continue;
        results.push({
            ip: match[1].replace(/[\[\]]/g, ''),
            port: parseInt(match[2]) || 443,
            name: match[3] || match[1].replace(/[\[\]]/g, '')
        });
    }
    return results;
}

// ================= 核心节点生成 =================
function generateNodesFromList(list, user, workerDomain, disableNonTLS, customPath, echEnabled, protocols) {
    const links = [];
    for (const item of list) {
        const baseName = item.name || item.ip;
        const safeIP = item.ip.includes(':') ? `[${item.ip}]` : item.ip;
        const ports = item.port ? [item.port] : (disableNonTLS ? [443] : [443, 80]);
        
        for (const port of ports) {
            const tls = port !== 80;
            if (disableNonTLS && !tls) continue;

            // ✅ 修复点：老老实实使用用户定义的路径和Host，坚决不搞域名前置
            const wsPath = customPath || "/";
            const host = workerDomain; 
            
            let params = `type=ws&host=${host}&path=${encodeURIComponent(wsPath)}&security=${tls ? 'tls' : 'none'}`;
            if (tls) {
                params += `&sni=${workerDomain}`;
                if (echEnabled) params += `&ech=true`; 
            }

            if (protocols.evEnabled) links.push(`vless://${user}@${safeIP}:${port}?encryption=none&${params}#${encodeURIComponent(baseName)}`);
            if (protocols.etEnabled) links.push(`trojan://${user}@${safeIP}:${port}?${params}#${encodeURIComponent(baseName)}`);
            if (protocols.vmEnabled) {
                const vmessConfig = { v: "2", ps: baseName, add: safeIP, port: port.toString(), id: user, aid: "0", scy: "auto", net: "ws", type: "none", host: host, path: wsPath, tls: tls ? "tls" : "none" };
                if (tls) { vmessConfig.sni = workerDomain; vmessConfig.fp = "chrome"; }
                links.push(`vmess://${safeBase64Encode(JSON.stringify(vmessConfig))}`);
            }
        }
    }
    return links;
}

// ================= 订阅及配置生成 (纯本地原生编译) =================
async function handleSubscriptionRequest(request, env, ctx, config) {
    const finalLinks = [];
    const protocols = {
        evEnabled: config.evEnabled || (!config.evEnabled && !config.etEnabled && !config.vmEnabled),
        etEnabled: config.etEnabled,
        vmEnabled: config.vmEnabled
    };
    let allRawNodes = [];
    
    if (config.epdEnabled) allRawNodes.push(...directDomains.map(d => ({ ip: d.domain, port: 443, name: d.name || d.domain })));
    if (config.epiEnabled) {
        const dynamicIPList = await fetchDynamicIPs(env, ctx, config.ipv4Enabled, config.ipv6Enabled, config.ispMobile, config.ispUnicom, config.ispTelecom);
        if (dynamicIPList.length > 0) allRawNodes.push(...dynamicIPList);
    }
    if (config.egiEnabled) {
        try {
            if (config.piu && config.piu.toLowerCase().startsWith('https://') && !config.piu.includes('\n')) {
                const parsedIps = parseRawIps(await fetchOptimizedAPI([config.piu]));
                if (parsedIps.length > 0) allRawNodes.push(...parsedIps);
            } else if (config.piu && config.piu.includes('\n')) {
                const fullList = parseToArray(config.piu);
                const apiUrls = fullList.filter(e => e.toLowerCase().startsWith('https://'));
                const rawIps = fullList.filter(e => !e.toLowerCase().includes('://'));
                if (apiUrls.length > 0) rawIps.push(...(await fetchOptimizedAPI(apiUrls)));
                const parsedIps = parseRawIps(rawIps);
                if (parsedIps.length > 0) allRawNodes.push(...parsedIps);
            } else {
                const newIPList = await fetchGitHubIPs(env, ctx, config.piu);
                if (newIPList.length > 0) allRawNodes.push(...newIPList);
            }
        } catch (e) {}
    }

    const uniqueNodesMap = new Map();
    for (const node of allRawNodes) { if (node && node.ip) uniqueNodesMap.set(`${node.ip}:${node.port || 443}`, node); }
    let deduplicatedList = Array.from(uniqueNodesMap.values());

    const godPrefixes = ['43.161.', '43.160.', '43.152.', '8.210.', '47.74.', '47.76.', '47.79.', '129.226.', '150.109.', '54.251.', '54.169.', '18.136.', '13.212.', '52.220.', '34.87.', '34.124.', '35.185.', '35.197.', '20.198.', '20.205.', '40.79.', '52.187.', '128.199.', '139.59.', '134.209.', '45.32.', '149.28.', '139.180.'];
    const hkKeywords = ['香港', 'HK', 'HKG', 'HKT', 'HKBN', 'HONGKONG'];
    const sortedList = deduplicatedList.map(item => {
        const isGod = godPrefixes.some(prefix => item.ip.startsWith(prefix));
        const nameStr = item.name || item.ip || '';
        const isHK = hkKeywords.some(k => nameStr.toUpperCase().includes(k));
        let score = 0; if (isGod) score += 100; if (isHK) score += 50;
        let finalName = nameStr; if (isGod) finalName = `🚀神级-${nameStr}`; else if (isHK && !isGod) finalName = `🇭🇰优选-${nameStr}`;
        return { ...item, _score: score, name: finalName };
    }).sort((a, b) => b._score - a._score);

    if (sortedList.length > 0) finalLinks.push(...generateNodesFromList(sortedList, config.user, config.nodeDomain, config.disableNonTLS, config.customPath, config.echEnabled, protocols));
    if (finalLinks.length === 0) finalLinks.push(`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:80?encryption=none&security=none&type=ws&host=error.com&path=%2F#${encodeURIComponent("所有节点获取失败")}`);

    let subscriptionContent;
    let contentType = 'text/plain; charset=utf-8';
    
    switch (config.target.toLowerCase()) {
        case 'clash':
        case 'clashr':
            subscriptionContent = generateClashConfig(finalLinks); 
            contentType = 'text/yaml; charset=utf-8'; 
            break;
        case 'surge':
        case 'surge2':
        case 'surge3':
        case 'surge4':
            subscriptionContent = generateSurgeConfig(finalLinks); 
            break;
        case 'singbox': 
            subscriptionContent = generateSingboxConfig(finalLinks); 
            contentType = 'application/json; charset=utf-8'; 
            break;
        default: 
            subscriptionContent = safeBase64Encode(finalLinks.join('\n'));
    }
    return new Response(subscriptionContent, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=600, s-maxage=600', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': 'attachment; filename="sub.txt"', }, });
}

// ---------------- 客户端配置生成引擎 ----------------

function generateClashConfig(links) {
    let yaml = 'port: 7890\nsocks-port: 7891\nallow-lan: false\nmode: rule\nlog-level: info\n\nproxies:\n';
    const proxyNames = [];
    links.forEach((link, index) => {
        const name = decodeURIComponent(link.split('#')[1] || `节点${index + 1}`);
        proxyNames.push(name);
        const isVless = link.startsWith('vless://');
        const server = link.match(/@([^:]+):(\d+)/)?.[1] || '';
        const port = link.match(/@[^:]+:(\d+)/)?.[1] || '443';
        const passOrUuid = link.match(/:\/\/([^@]+)@/)?.[1] || '';
        const tls = link.includes('security=tls') || link.includes('tls=tls');
        const path = decodeURIComponent(link.match(/path=([^&#]+)/)?.[1] || '/');
        const host = decodeURIComponent(link.match(/host=([^&#]+)/)?.[1] || '');
        const sni = decodeURIComponent(link.match(/sni=([^&#]+)/)?.[1] || '');
        const ech = link.includes('ech=true');
        
        yaml += `  - name: ${name}\n    type: ${isVless ? 'vless' : 'trojan'}\n    server: ${server}\n    port: ${port}\n    ${isVless ? 'uuid' : 'password'}: ${passOrUuid}\n    tls: ${tls}\n    network: ws\n    ws-opts:\n      path: ${path}\n      headers:\n        Host: ${host}\n`;
        if (sni) yaml += `    servername: ${sni}\n`;
        if (ech) yaml += `    ech-opts:\n      enable: true\n`;
    });
    yaml += `\nproxy-groups:\n  - name: PROXY\n    type: select\n    proxies: [${proxyNames.map(n => `'${n}'`).join(', ')}]\nrules:\n  - DOMAIN-SUFFIX,local,DIRECT\n  - IP-CIDR,127.0.0.0/8,DIRECT\n  - GEOIP,CN,DIRECT\n  - MATCH,PROXY\n`;
    return yaml;
}

function generateSurgeConfig(links) {
    let config = '[Proxy]\n';
    links.forEach((link, i) => {
        const name = decodeURIComponent(link.split('#')[1] || `节点${i+1}`);
        config += `${name} = vless, ${link.match(/@([^:]+):(\d+)/)?.[1] || ''}, ${link.match(/@[^:]+:(\d+)/)?.[1] || '443'}, username=${link.match(/vless:\/\/([^@]+)@/)?.[1] || ''}, tls=${link.includes('security=tls')}, ws=true, ws-path=${link.match(/path=([^&#]+)/)?.[1] || '/'}, ws-headers=Host:${link.match(/host=([^&#]+)/)?.[1] || ''}\n`;
    });
    config += '\n[Proxy Group]\nPROXY = select, ' + links.map((_, i) => decodeURIComponent(links[i].split('#')[1] || `节点${i + 1}`)).join(', ') + '\n';
    return config;
}

function generateSingboxConfig(links) {
    const outbounds = []; 
    const proxyTags = [];
    links.forEach((link, i) => {
        const name = decodeURIComponent(link.split('#')[1] || `节点${i + 1}`);
        proxyTags.push(name);
        const isVless = link.startsWith('vless://');
        const server = link.match(/@([^:]+):(\d+)/)?.[1] || '';
        const port = parseInt(link.match(/@[^:]+:(\d+)/)?.[1] || '443');
        const passOrUuid = link.match(/:\/\/([^@]+)@/)?.[1] || '';
        const tls = link.includes('security=tls') || link.includes('tls=tls');
        const path = decodeURIComponent(link.match(/path=([^&#]+)/)?.[1] || '/');
        const host = decodeURIComponent(link.match(/host=([^&#]+)/)?.[1] || '');
        const sni = decodeURIComponent(link.match(/sni=([^&#]+)/)?.[1] || '');
        
        const node = { 
            type: isVless ? 'vless' : 'trojan', 
            tag: name, 
            server: server, 
            server_port: port, 
            [isVless ? 'uuid' : 'password']: passOrUuid, 
            tls: { enabled: tls, server_name: sni || host, insecure: false }, 
            transport: { type: 'ws', path: path, headers: { Host: host } } 
        };
        if (link.includes('ech=true') && tls) {
            node.tls.ech = { enabled: true };
        }
        outbounds.push(node);
    });
    return JSON.stringify({ 
        log: { level: "info" }, 
        outbounds: [
            { type: "selector", tag: "PROXY", outbounds: proxyTags }, 
            ...outbounds, 
            { type: "direct", tag: "DIRECT" }
        ], 
        route: { rules: [{ outbound: "DIRECT", domain_suffix: [".cn"] }] } 
    }, null, 2);
}

// ================= UI 与前端逻辑 =================
function generateHomePage(scuValue) {
    const scu = scuValue || 'https://url.v1.mk/sub';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>服务器优选工具</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(180deg, #f5f5f7 0%, #ffffff 50%, #fafafa 100%); color: #1d1d1f; min-height: 100vh; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); overflow-x: hidden; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; padding: 48px 20px 32px; }
        .header h1 { font-size: 40px; font-weight: 700; letter-spacing: -0.3px; color: #1d1d1f; margin-bottom: 8px; line-height: 1.1; }
        .header p { font-size: 17px; color: #86868b; font-weight: 400; line-height: 1.5; }
        .card { background: rgba(255, 255, 255, 0.75); backdrop-filter: blur(30px) saturate(200%); border-radius: 24px; padding: 28px; margin-bottom: 20px; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06); border: 0.5px solid rgba(0, 0, 0, 0.06); }
        .form-group { margin-bottom: 24px; }
        .form-group:last-child { margin-bottom: 0; }
        .form-group label { display: block; font-size: 13px; font-weight: 600; color: #86868b; margin-bottom: 8px; text-transform: uppercase; }
        .form-group input { width: 100%; padding: 14px 16px; font-size: 17px; background: rgba(142, 142, 147, 0.12); border: 2px solid transparent; border-radius: 12px; outline: none; transition: all 0.2s; }
        .form-group input:focus { background: rgba(142, 142, 147, 0.16); border-color: #007AFF; transform: scale(1.005); }
        .list-item { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; min-height: 52px; cursor: pointer; border-bottom: 0.5px solid rgba(0, 0, 0, 0.08); }
        .list-item:last-child { border-bottom: none; }
        .list-item-label { font-size: 17px; color: #1d1d1f; }
        .switch { width: 51px; height: 31px; background: rgba(142, 142, 147, 0.3); border-radius: 16px; position: relative; transition: 0.3s; }
        .switch.active { background: #34C759; }
        .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; background: #ffffff; border-radius: 50%; transition: 0.3s; box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
        .switch.active::after { transform: translateX(20px); }
        .result-url { margin-top: 12px; padding: 12px; background: rgba(0, 122, 255, 0.1); border-radius: 10px; font-size: 13px; color: #007aff; word-break: break-all; display: none; line-height: 1.5; }
        .client-btn { padding: 12px 16px; font-size: 14px; font-weight: 500; color: #007AFF; background: rgba(0, 122, 255, 0.1); border: 1px solid rgba(0, 122, 255, 0.2); border-radius: 12px; cursor: pointer; transition: all 0.2s; }
        .client-btn:active { transform: scale(0.97); background: rgba(0, 122, 255, 0.2); }
        .checkbox-label { display: flex; align-items: center; cursor: pointer; font-size: 17px; gap: 8px; }
        .checkbox-label input[type="checkbox"] { width: 22px; height: 22px; cursor: pointer; -webkit-appearance: checkbox; }
        @media (prefers-color-scheme: dark) {
            body { background: linear-gradient(180deg, #000000 0%, #1c1c1e 50%, #2c2c2e 100%); color: #f5f5f7; }
            .card { background: rgba(28, 28, 30, 0.75); border-color: rgba(255, 255, 255, 0.12); }
            .form-group input { background: rgba(142, 142, 147, 0.2); color: #f5f5f7; }
            .form-group input:focus { border-color: #5ac8fa; }
            .list-item { border-bottom-color: rgba(255, 255, 255, 0.1); }
            .list-item-label { color: #f5f5f7; }
            .switch { background: rgba(142, 142, 147, 0.4); }
            .switch.active { background: #30d158; }
            .client-btn { background: rgba(0, 122, 255, 0.15); border-color: rgba(0, 122, 255, 0.3); color: #5ac8fa; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>服务器优选工具</h1>
            <p>全原生直出 • 零转换器污染 • V5.3稳定版</p>
        </div>
        
        <div class="card">
            <div class="form-group">
                <label>域名</label>
                <input type="text" id="domain" placeholder="请输入您的域名">
            </div>
            
            <div class="form-group">
                <label>UUID/Password</label>
                <input type="text" id="uuid" placeholder="请输入UUID或Password">
            </div>
            
            <div class="form-group">
                <label>WebSocket路径（可选）</label>
                <input type="text" id="customPath" placeholder="留空则使用根路径 /" value="/">
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchDomain')">
                <div><div class="list-item-label">启用优选域名</div></div>
                <div class="switch" id="switchDomain"></div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchIP')">
                <div><div class="list-item-label">启用内置优选IP(含杂质)</div></div>
                <div class="switch" id="switchIP"></div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchGitHub')">
                <div><div class="list-item-label">启用私有纯净IP库(推荐)</div></div>
                <div class="switch active" id="switchGitHub"></div>
            </div>
            
            <div class="form-group" id="githubUrlGroup" style="margin-top: 12px;">
                <label>GitHub优选URL（可选）</label>
                <input type="text" id="githubUrl" placeholder="留空则使用内置的纯净链接">
            </div>
            
            <div class="form-group" style="margin-top: 24px;">
                <label>协议选择</label>
                <div style="margin-top: 8px;">
                    <div class="list-item" onclick="toggleSwitch('switchVL')">
                        <div><div class="list-item-label">VLESS (vl)</div></div>
                        <div class="switch active" id="switchVL"></div>
                    </div>
                    <div class="list-item" onclick="toggleSwitch('switchTJ')">
                        <div><div class="list-item-label">Trojan (tj)</div></div>
                        <div class="switch" id="switchTJ"></div>
                    </div>
                    <div class="list-item" onclick="toggleSwitch('switchVM')">
                        <div><div class="list-item-label">VMess (vm)</div></div>
                        <div class="switch" id="switchVM"></div>
                    </div>
                </div>
            </div>
            
            <div class="form-group" style="margin-top: 24px;">
                <label>客户端选择</label>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-top: 8px;">
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'V2RAY')">原生VLESS链接</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('clash', 'CLASH')">CLASH 原生直出</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('surge', 'SURGE')">SURGE 原生直出</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('singbox', 'SING-BOX')">SING-BOX 原生直出</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'NEKORAY')">NEKORAY</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'Shadowrocket')">Shadowrocket</button>
                </div>
                <div class="result-url" id="clientSubscriptionUrl" style="display: none;"></div>
            </div>
            
            <div class="form-group">
                <label>IP版本选择</label>
                <div style="display: flex; gap: 16px; margin-top: 8px;">
                    <label class="checkbox-label"><input type="checkbox" id="ipv4Enabled" checked><span>IPv4</span></label>
                    <label class="checkbox-label"><input type="checkbox" id="ipv6Enabled" checked><span>IPv6</span></label>
                </div>
            </div>
            
            <div class="form-group">
                <label>运营商选择</label>
                <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px;">
                    <label class="checkbox-label"><input type="checkbox" id="ispMobile" checked><span>移动</span></label>
                    <label class="checkbox-label"><input type="checkbox" id="ispUnicom" checked><span>联通</span></label>
                    <label class="checkbox-label"><input type="checkbox" id="ispTelecom" checked><span>电信</span></label>
                </div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchTLS')" style="margin-top: 8px;">
                <div><div class="list-item-label">仅TLS节点</div></div>
                <div class="switch" id="switchTLS"></div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchECH')" style="margin-top: 8px;">
                <div><div class="list-item-label">ECH 隐身保护 (Sing-box/Meta)</div></div>
                <div class="switch" id="switchECH"></div>
            </div>
        </div>
        
        <div class="footer"><p>V5.3 终极稳定版 • 拒绝花里胡哨，回归物理直连</p></div>
    </div>
    
    <script>
        let switches = { switchDomain: false, switchIP: false, switchGitHub: true, switchVL: true, switchTJ: false, switchVM: false, switchTLS: false, switchECH: false };
        function toggleSwitch(id) {
            switches[id] = !switches[id];
            document.getElementById(id).classList.toggle('active');
            if (id === 'switchECH' && switches.switchECH && !switches.switchTLS) {
                switches.switchTLS = true;
                document.getElementById('switchTLS').classList.add('active');
            }
        }
        
        const SUB_CONVERTER_URL = "${ scu }";
        
        function tryOpenApp(schemeUrl, fallbackCallback, timeout = 2500) {
            let appOpened = false, callbackExecuted = false;
            const startTime = Date.now();
            const handler = () => { if (Date.now() - startTime < 3000 && !callbackExecuted) appOpened = true; };
            window.addEventListener('blur', handler);
            document.addEventListener('visibilitychange', handler);
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.src = schemeUrl;
            document.body.appendChild(iframe);
            setTimeout(() => {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                window.removeEventListener('blur', handler);
                document.removeEventListener('visibilitychange', handler);
                if (!callbackExecuted) {
                    callbackExecuted = true;
                    if (!appOpened && fallbackCallback) fallbackCallback();
                }
            }, timeout);
        }
        
        function generateClientLink(clientType, clientName) {
            const domain = document.getElementById('domain').value.trim();
            const uuid = document.getElementById('uuid').value.trim();
            const customPath = document.getElementById('customPath').value.trim() || '/';

            if (!domain || !uuid) return alert('⚠️ 请先填写域名和 UUID/Password');
            if (!switches.switchVL && !switches.switchTJ && !switches.switchVM) return alert('⚠️ 请至少选择一个协议');

            const ipv4 = document.getElementById('ipv4Enabled').checked;
            const ipv6 = document.getElementById('ipv6Enabled').checked;
            const ispMobile = document.getElementById('ispMobile').checked;
            const ispUnicom = document.getElementById('ispUnicom').checked;
            const ispTelecom = document.getElementById('ispTelecom').checked;
            const githubUrl = document.getElementById('githubUrl').value.trim();

            const baseUrl = new URL(window.location.href).origin;
            let subUrl = \`\${baseUrl}/\${uuid}/sub?domain=\${encodeURIComponent(domain)}\`;

            if (switches.switchDomain) subUrl += '&epd=yes';
            if (switches.switchIP) subUrl += '&epi=yes';
            if (!switches.switchGitHub) subUrl += '&egi=no';
            if (githubUrl) subUrl += \`&piu=\${encodeURIComponent(githubUrl)}\`;

            if (!switches.switchVL) subUrl += '&ev=no';
            if (switches.switchTJ) subUrl += '&et=yes';
            if (switches.switchVM) subUrl += '&mess=yes';

            if (!ipv4) subUrl += '&ipv4=no';
            if (!ipv6) subUrl += '&ipv6=no';
            if (!ispMobile) subUrl += '&ispMobile=no';
            if (!ispUnicom) subUrl += '&ispUnicom=no';
            if (!ispTelecom) subUrl += '&ispTelecom=no';

            if (switches.switchTLS) subUrl += '&dkby=yes';
            if (switches.switchECH) subUrl += '&ech=yes';
            if (customPath && customPath !== '/') subUrl += \`&path=\${encodeURIComponent(customPath)}\`;

            let finalUrl = subUrl;
            let schemeUrl = '';

            if (['v2ray', 'clash', 'surge', 'singbox'].includes(clientType)) {
                if (clientType !== 'v2ray') finalUrl += \`&target=\${clientType}\`;
                
                document.getElementById('clientSubscriptionUrl').textContent = finalUrl;
                document.getElementById('clientSubscriptionUrl').style.display = 'block';
                const copyAction = () => navigator.clipboard.writeText(finalUrl).then(() => alert(clientName + ' 原生订阅链接已复制'));
                
                if (clientName === 'V2RAY') copyAction();
                else if (clientName === 'Shadowrocket') schemeUrl = 'shadowrocket://add/' + encodeURIComponent(finalUrl);
                else if (clientName === 'V2RAYNG') schemeUrl = 'v2rayng://install?url=' + encodeURIComponent(finalUrl);
                else if (clientName === 'NEKORAY') schemeUrl = 'nekoray://install-config?url=' + encodeURIComponent(finalUrl);
                else if (clientType === 'clash') schemeUrl = 'clash://install-config?url=' + encodeURIComponent(finalUrl);
                else if (clientType === 'surge') schemeUrl = 'surge:///install-config?url=' + encodeURIComponent(finalUrl);
                else if (clientType === 'singbox') schemeUrl = 'sing-box://import-remote-profile?url=' + encodeURIComponent(finalUrl);

                if (schemeUrl) tryOpenApp(schemeUrl, copyAction);
                else copyAction();
            }
        }
    </script>
</body>
</html>`;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        if (path === '/' || path === '') {
            return new Response(generateHomePage(env?.scu || DEFAULT_CONFIG.scu), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (path === '/test-optimize-api') { return new Response('OK'); }
        
        const pathMatch = path.match(/^\/([^\/]+)\/sub$/);
        if (pathMatch) {
            const cache = caches.default;
            const cacheKey = new Request(url.toString(), request);
            const cachedResponse = await cache.match(cacheKey);
            if (cachedResponse) return cachedResponse;

            const reqConfig = {
                user: pathMatch[1],
                workerDomain: url.hostname,
                nodeDomain: url.searchParams.get('domain') || url.hostname,
                target: url.searchParams.get('target') || 'base64',
                customPath: url.searchParams.get('path') || '/',
                piu: url.searchParams.get('piu') || DEFAULT_CONFIG.defaultIPURL,
                epdEnabled: url.searchParams.get('epd') === 'yes',
                epiEnabled: url.searchParams.get('epi') === 'yes',
                egiEnabled: url.searchParams.get('egi') !== 'no',
                evEnabled: url.searchParams.get('ev') !== 'no',
                etEnabled: url.searchParams.get('et') === 'yes',
                vmEnabled: url.searchParams.get('mess') === 'yes',
                ipv4Enabled: url.searchParams.get('ipv4') !== 'no',
                ipv6Enabled: url.searchParams.get('ipv6') !== 'no',
                ispMobile: url.searchParams.get('ispMobile') !== 'no',
                ispUnicom: url.searchParams.get('ispUnicom') !== 'no',
                ispTelecom: url.searchParams.get('ispTelecom') !== 'no',
                disableNonTLS: url.searchParams.get('dkby') === 'yes',
                echEnabled: false
            };

            if (!url.searchParams.get('domain')) return new Response('缺少域名参数', { status: 400 });
            
            const echParam = url.searchParams.get('ech');
            if (echParam === 'yes' || (echParam === null && DEFAULT_CONFIG.enableECH)) {
                reqConfig.disableNonTLS = true;
                reqConfig.echEnabled = true;
            }
            
            const response = await handleSubscriptionRequest(request, env, ctx, reqConfig);
            
            if (response.status === 200) {
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
            return response;
        }
        
        return new Response('Not Found', { status: 404 });
    }
};
