// Cloudflare Worker - 简化版优选工具 (纯净私库极简命名版)
// 深度优化版：统一正则引擎、重构网页爬虫、精简数组遍历逻辑

// ================= 全局默认配置 (常量) =================
const DEFAULT_CONFIG = {
    epd: false,  // 关闭默认域名优选
    epi: false,  // 关闭默认Wetest动态IP抓取 (彻底防污染)
    egi: true,   // 开启GitHub优选(只读你的专属Gist)
    ev: true,   
    et: false,  
    vm: false,  
    scu: 'https://url.v1.mk/sub',  
    enableECH: false,
    customDNS: 'https://dns.joeyblog.eu.org/joeyblog',
    customECHDomain: 'cloudflare-ech.com',
    // 指向你的永久 Gist Raw 链接
    defaultIPURL: 'https://gist.githubusercontent.com/shiyikeji/3aa87176e89a34e48f72487fbbada9d2/raw/my_best_ips.txt'
};

const directDomains = []; 

// 🚀 优化1：全局统一的高性能、高宽容度 IP/域名 解析正则
const GLOBAL_IP_PATTERN = /^(\[[0-9a-fA-F:]+\]|[\d\.]+|[a-zA-Z0-9.-]+)(?::(\d+))?(?:#(.+))?$/;

// ================= 辅助函数 =================
function safeBase64Encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}

async function parseToArray(content) {
    return content.replace(/[ "'\r\n]+/g, ',').split(',').filter(Boolean);
}

function parseSingleLine(line) {
    const match = line.trim().match(GLOBAL_IP_PATTERN);
    if (!match) return null;
    return {
        ip: match[1].replace(/[\[\]]/g, ''),
        port: parseInt(match[2], 10) || 443,
        name: match[3] ? match[3].trim() : match[1].replace(/[\[\]]/g, '')
    };
}

// ================= 核心数据抓取 =================
async function fetchDynamicIPs(ipv4Enabled = true, ipv6Enabled = true, ispMobile = true, ispUnicom = true, ispTelecom = true) {
    const fetchPromises = [];
    if (ipv4Enabled) fetchPromises.push(fetchAndParseWetest("https://www.wetest.vip/page/cloudflare/address_v4.html"));
    if (ipv6Enabled) fetchPromises.push(fetchAndParseWetest("https://www.wetest.vip/page/cloudflare/address_v6.html"));

    try {
        const resultsArray = await Promise.all(fetchPromises);
        let results = resultsArray.flat();
        
        return results.filter(item => {
            const isp = item.isp || '';
            if (!ispMobile && isp.includes('移动')) return false;
            if (!ispUnicom && isp.includes('联通')) return false;
            if (!ispTelecom && isp.includes('电信')) return false;
            return true;
        });
    } catch { return []; }
}

async function fetchAndParseWetest(url) {
    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) return [];
        const html = await response.text();
        
        // 🚀 优化2：重构高危 HTML 正则，提升提取速度和准确性
        const results = [];
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
        const extractRegex = /<td[^>]*线路名称[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*优选地址[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*数据中心[^>]*>(.*?)<\/td>/;

        let match;
        while ((match = rowRegex.exec(html)) !== null) {
            const cellMatch = match[1].match(extractRegex);
            if (cellMatch && cellMatch[2]) {
                results.push({
                    isp: cellMatch[1].replace(/<[^>]+>|\s+/g, '').trim(),
                    ip: cellMatch[2].trim(),
                    colo: cellMatch[3] ? cellMatch[3].replace(/<[^>]+>|\s+/g, '').trim() : ''
                });
            }
        }
        return results;
    } catch { return []; }
}

async function fetchOptimizedAPI(urls, defaultPort = '443', timeoutMs = 3000) {
    if (!urls?.length) return [];
    const results = new Set();
    
    await Promise.allSettled(urls.map(async (url) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            let text = new TextDecoder('utf-8').decode(await response.arrayBuffer());
            if (text.includes('\ufffd')) text = new TextDecoder('gb2312').decode(buffer);
            
            const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
            if (!lines.length) return;

            // 区分 CSV 与普通文本库
            if (lines.length > 1 && lines[0].includes(',')) {
                const headers = lines[0].split(',').map(h => h.trim());
                const ipIdx = headers.indexOf('IP地址');
                const portIdx = headers.indexOf('端口');
                if (ipIdx === -1 || portIdx === -1) return;
                
                const remarkIdx = headers.indexOf('国家') > -1 ? headers.indexOf('国家') : (headers.indexOf('数据中心') > -1 ? headers.indexOf('数据中心') : ipIdx);
                
                lines.slice(1).forEach(line => {
                    const cols = line.split(',').map(c => c.trim());
                    const ip = cols[ipIdx].includes(':') ? `[${cols[ipIdx]}]` : cols[ipIdx];
                    results.add(`${ip}:${cols[portIdx]}#${cols[remarkIdx]}`);
                });
            } else {
                lines.forEach(line => {
                    const parsed = parseSingleLine(line);
                    if (parsed) results.add(`${parsed.ip.includes(':') ? `[${parsed.ip}]` : parsed.ip}:${parsed.port}#${parsed.name}`);
                });
            }
        } catch (e) {}
    }));
    return Array.from(results);
}

async function fetchGitHubIPs(piu) {
    try {
        const response = await fetch(piu || DEFAULT_CONFIG.defaultIPURL);
        if (!response.ok) return [];
        const lines = (await response.text()).replace(/\r/g, "").split('\n').filter(Boolean);
        
        // 🚀 优化3：复用全局正则，直接映射生成数组
        return lines.map(parseSingleLine).filter(Boolean);
    } catch { return []; }
}

// ================= 核心节点生成 (极简命名版) =================
function generateNodesFromList(list, user, workerDomain, disableNonTLS, customPath, echConfig, protocols) {
    const CF_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
    const CF_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
    const wsPath = customPath || '/';

    return list.flatMap(item => {
        let nodeNameBase = item.isp ? item.isp.replace(/\s/g, '_') : (item.name || item.domain || item.ip);
        if (item.colo && item.colo.trim()) nodeNameBase = `${nodeNameBase}-${item.colo.trim()}`;
        const safeIP = item.ip.includes(':') ? `[${item.ip}]` : item.ip;
        
        let portsToGenerate = [];
        if (item.port) {
            const p = parseInt(item.port, 10);
            const isHttp = CF_HTTP_PORTS.includes(p);
            if (CF_HTTPS_PORTS.includes(p) || (isHttp && disableNonTLS)) {
                portsToGenerate.push({ port: p, tls: true });
            } else if (isHttp && !disableNonTLS) {
                portsToGenerate.push({ port: p, tls: false });
            } else {
                portsToGenerate.push({ port: p, tls: true }); // 兜底全走 TLS
            }
        } else {
            portsToGenerate.push({ port: 443, tls: true });
            if (!disableNonTLS) portsToGenerate.push({ port: 80, tls: false });
        }

        return portsToGenerate.flatMap(({ port, tls }) => {
            const wsParams = new URLSearchParams({ type: 'ws', host: workerDomain, path: wsPath });
            if (tls) {
                wsParams.set('security', 'tls');
                wsParams.set('sni', workerDomain); // 遵从要求，保留原样
                wsParams.set('fp', 'chrome');
                if (echConfig) {
                    wsParams.set('alpn', 'h3,h2,http/1.1');
                    wsParams.set('ech', echConfig);
                }
            } else {
                wsParams.set('security', 'none');
            }

            const links = [];
            if (protocols.evEnabled) {
                const vlessParams = new URLSearchParams(wsParams);
                vlessParams.set('encryption', 'none');
                links.push(`vless://${user}@${safeIP}:${port}?${vlessParams.toString()}#${encodeURIComponent(nodeNameBase)}`);
            }
            if (protocols.etEnabled) {
                links.push(`trojan://${user}@${safeIP}:${port}?${wsParams.toString()}#${encodeURIComponent(nodeNameBase)}`);
            }
            if (protocols.vmEnabled) {
                const vmessConfig = {
                    v: "2", ps: nodeNameBase, add: safeIP, port: port.toString(), id: user,
                    aid: "0", scy: "auto", net: "ws", type: "none", host: workerDomain, path: wsPath,
                    tls: tls ? "tls" : "none"
                };
                if (tls) {
                    vmessConfig.sni = workerDomain; // 遵从要求，保留原样
                    vmessConfig.fp = "chrome";
                }
                links.push(`vmess://${safeBase64Encode(JSON.stringify(vmessConfig))}`);
            }
            return links;
        });
    });
}

// ================= 订阅及配置生成 =================
async function handleSubscriptionRequest(request, config) {
    const finalLinks = [];
    const protocols = {
        evEnabled: config.evEnabled || (!config.evEnabled && !config.etEnabled && !config.vmEnabled),
        etEnabled: config.etEnabled,
        vmEnabled: config.vmEnabled
    };

    const addNodesFromList = (list) => {
        finalLinks.push(...generateNodesFromList(list, config.user, config.nodeDomain, config.disableNonTLS, config.customPath, config.echConfig, protocols));
    };

    if (config.epdEnabled) {
        addNodesFromList(directDomains.map(d => ({ ip: d.domain, isp: d.name || d.domain })));
    }

    if (config.epiEnabled) {
        const dynamicIPList = await fetchDynamicIPs(config.ipv4Enabled, config.ipv6Enabled, config.ispMobile, config.ispUnicom, config.ispTelecom);
        if (dynamicIPList.length) addNodesFromList(dynamicIPList);
    }

    if (config.egiEnabled) {
        try {
            if (config.piu && config.piu.toLowerCase().startsWith('https://') && !config.piu.includes('\n')) {
                const apiIps = await fetchOptimizedAPI([config.piu]);
                const parsedIps = apiIps.map(parseSingleLine).filter(Boolean);
                if (parsedIps.length) addNodesFromList(parsedIps);
            } else if (config.piu && config.piu.includes('\n')) {
                const fullList = await parseToArray(config.piu);
                const apiUrls = fullList.filter(e => e.toLowerCase().startsWith('https://'));
                const rawIps = fullList.filter(e => !e.toLowerCase().includes('://'));
                
                if (apiUrls.length) rawIps.push(...(await fetchOptimizedAPI(apiUrls)));
                const parsedIps = rawIps.map(parseSingleLine).filter(Boolean);
                if (parsedIps.length) addNodesFromList(parsedIps);
            } else {
                const newIPList = await fetchGitHubIPs(config.piu);
                if (newIPList.length) addNodesFromList(newIPList);
            }
        } catch (error) {}
    }

    if (finalLinks.length === 0) {
        finalLinks.push(`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:80?encryption=none&security=none&type=ws&host=error.com&path=%2F#${encodeURIComponent("所有节点获取失败")}`);
    }

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
        case 'quantumult':
        case 'quanx':
        default:
            subscriptionContent = btoa(finalLinks.join('\n'));
            break;
    }
    
    return new Response(subscriptionContent, {
        headers: { 
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Access-Control-Allow-Origin': '*',
            'Content-Disposition': 'attachment; filename="sub.txt"',
        },
    });
}

function generateClashConfig(links) {
    let yaml = 'port: 7890\nsocks-port: 7891\nallow-lan: false\nmode: rule\nlog-level: info\n\nproxies:\n';
    const proxyNames = [];
    links.forEach((link, index) => {
        const name = decodeURIComponent(link.split('#')[1] || `节点${index + 1}`);
        proxyNames.push(name);
        const isVless = link.startsWith('vless://');
        const isTrojan = link.startsWith('trojan://');
        
        const server = link.match(/@([^:]+):(\d+)/)?.[1] || '';
        const port = link.match(/@[^:]+:(\d+)/)?.[1] || '443';
        const passOrUuid = link.match(/:\/\/([^@]+)@/)?.[1] || '';
        const tls = link.includes('security=tls') || link.includes('tls=tls');
        const path = link.match(/path=([^&#]+)/)?.[1] || '/';
        const host = link.match(/host=([^&#]+)/)?.[1] || '';
        const sni = link.match(/sni=([^&#]+)/)?.[1] || '';
        const echParam = link.match(/[?&]ech=([^&#]+)/)?.[1];
        
        if(isVless || isTrojan) {
             yaml += `  - name: ${name}\n    type: ${isVless ? 'vless' : 'trojan'}\n    server: ${server}\n    port: ${port}\n    ${isVless ? 'uuid' : 'password'}: ${passOrUuid}\n    tls: ${tls}\n    network: ws\n    ws-opts:\n      path: ${path}\n      headers:\n        Host: ${host}\n`;
             if (sni) yaml += `    servername: ${sni}\n`;
             if (echParam) yaml += `    ech-opts:\n      enable: true\n      query-server-name: ${decodeURIComponent(echParam).split('+')[0]}\n`;
        }
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

// ================= UI 与请求入口 =================
function generateHomePage(scuValue) {
    const scu = scuValue || 'https://url.v1.mk/sub';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>服务器优选工具</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
        body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;background:linear-gradient(180deg,#f5f5f7 0%,#ffffff 50%,#fafafa 100%);color:#1d1d1f;min-height:100vh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);overflow-x:hidden;}
        .container{max-width:600px;margin:0 auto;padding:20px;}
        .header{text-align:center;padding:48px 20px 32px;}
        .header h1{font-size:40px;font-weight:700;letter-spacing:-0.3px;color:#1d1d1f;margin-bottom:8px;line-height:1.1;}
        .header p{font-size:17px;color:#86868b;font-weight:400;line-height:1.5;}
        .card{background:rgba(255,255,255,0.75);backdrop-filter:blur(30px) saturate(200%);-webkit-backdrop-filter:blur(30px) saturate(200%);border-radius:24px;padding:28px;margin-bottom:20px;box-shadow:0 4px 24px rgba(0,0,0,0.06),0 1px 3px rgba(0,0,0,0.05);border:0.5px solid rgba(0,0,0,0.06);}
        .form-group{margin-bottom:24px;}
        .form-group:last-child{margin-bottom:0;}
        .form-group label{display:block;font-size:13px;font-weight:600;color:#86868b;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;}
        .form-group input,.form-group textarea{width:100%;padding:14px 16px;font-size:17px;font-weight:400;color:#1d1d1f;background:rgba(142,142,147,0.12);border:2px solid transparent;border-radius:12px;outline:none;transition:all 0.2s cubic-bezier(0.4,0,0.2,1);-webkit-appearance:none;}
        .form-group input:focus,.form-group textarea:focus{background:rgba(142,142,147,0.16);border-color:#007AFF;}
        .form-group input::placeholder{color:#86868b;}
        .form-group small{display:block;margin-top:8px;color:#86868b;font-size:13px;line-height:1.4;}
        .list-item{display:flex;align-items:center;justify-content:space-between;padding:16px 0;min-height:52px;cursor:pointer;border-bottom:0.5px solid rgba(0,0,0,0.08);transition:background-color 0.15s ease;}
        .list-item:last-child{border-bottom:none;}
        .list-item-label{font-size:17px;font-weight:400;color:#1d1d1f;flex:1;}
        .list-item-description{font-size:13px;color:#86868b;margin-top:4px;line-height:1.4;}
        .switch{position:relative;width:51px;height:31px;background:rgba(142,142,147,0.3);border-radius:16px;transition:background 0.3s cubic-bezier(0.4,0,0.2,1);cursor:pointer;flex-shrink:0;}
        .switch.active{background:#34C759;}
        .switch::after{content:'';position:absolute;top:2px;left:2px;width:27px;height:27px;background:#ffffff;border-radius:50%;transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);box-shadow:0 2px 6px rgba(0,0,0,0.15),0 1px 2px rgba(0,0,0,0.1);}
        .switch.active::after{transform:translateX(20px);}
        .client-btn{padding:12px 16px;font-size:14px;font-weight:500;color:#007AFF;background:rgba(0,122,255,0.1);border:1px solid rgba(0,122,255,0.2);border-radius:12px;cursor:pointer;transition:all 0.2s;-webkit-appearance:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .client-btn:active{transform:scale(0.97);background:rgba(0,122,255,0.2);}
        .checkbox-label{display:flex;align-items:center;cursor:pointer;font-size:17px;padding:8px 0;}
        .checkbox-label input[type="checkbox"]{margin-right:12px;width:22px;height:22px;cursor:pointer;}
        .footer{text-align:center;padding:32px 20px;color:#86868b;font-size:13px;}
        @media (prefers-color-scheme: dark) {
            body{background:linear-gradient(180deg,#000000 0%,#1c1c1e 50%,#2c2c2e 100%);color:#f5f5f7;}
            .card{background:rgba(28,28,30,0.75);border-color:rgba(255,255,255,0.12);box-shadow:0 4px 24px rgba(0,0,0,0.3);}
            .form-group input{background:rgba(142,142,147,0.2);color:#f5f5f7;}
            .form-group input:focus{background:rgba(142,142,147,0.25);border-color:#5ac8fa;}
            .list-item{border-bottom-color:rgba(255,255,255,0.1);}
            .list-item-label{color:#f5f5f7;}
            .switch{background:rgba(142,142,147,0.4);}
            .switch.active{background:#30d158;}
            .client-btn{background:rgba(0,122,255,0.15);color:#5ac8fa;}
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>服务器优选工具</h1>
            <p>智能优选 • 极简命名终极版</p>
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
                <input type="text" id="customPath" placeholder="留空则使用默认路径 /" value="/">
            </div>
            <div class="list-item" onclick="toggleSwitch('switchDomain')">
                <div class="list-item-label">启用优选域名</div>
                <div class="switch" id="switchDomain"></div>
            </div>
            <div class="list-item" onclick="toggleSwitch('switchIP')">
                <div class="list-item-label">启用内置优选IP(含杂质)</div>
                <div class="switch" id="switchIP"></div>
            </div>
            <div class="list-item" onclick="toggleSwitch('switchGitHub')">
                <div class="list-item-label">启用私有纯净IP库(推荐)</div>
                <div class="switch active" id="switchGitHub"></div>
            </div>
            <div class="form-group" id="githubUrlGroup" style="margin-top: 12px;">
                <label>GitHub优选URL（可选）</label>
                <input type="text" id="githubUrl" placeholder="留空则使用内置的纯净链接">
            </div>
            <div class="form-group" style="margin-top: 24px;">
                <label>协议选择</label>
                <div class="list-item" onclick="toggleSwitch('switchVL')"><div class="list-item-label">VLESS (vl)</div><div class="switch active" id="switchVL"></div></div>
                <div class="list-item" onclick="toggleSwitch('switchTJ')"><div class="list-item-label">Trojan (tj)</div><div class="switch" id="switchTJ"></div></div>
                <div class="list-item" onclick="toggleSwitch('switchVM')"><div class="list-item-label">VMess (vm)</div><div class="switch" id="switchVM"></div></div>
            </div>
            <div class="form-group" style="margin-top: 24px;">
                <label>客户端选择</label>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-top: 8px;">
                    <button type="button" class="client-btn" onclick="generateClientLink('clash', 'CLASH')">CLASH</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('clash', 'STASH')">STASH</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('surge', 'SURGE')">SURGE</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('sing-box', 'SING-BOX')">SING-BOX</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('loon', 'LOON')">LOON</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('quanx', 'QUANTUMULT X')">QUANTUMULT X</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'V2RAY')">V2RAY</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'V2RAYNG')">V2RAYNG</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'NEKORAY')">NEKORAY</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'Shadowrocket')">Shadowrocket</button>
                </div>
                <div id="clientSubscriptionUrl" style="display: none; margin-top: 12px; padding: 12px; background: rgba(0, 122, 255, 0.1); border-radius: 8px; font-size: 13px; color: #007aff; word-break: break-all;"></div>
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
            <div class="list-item" onclick="toggleSwitch('switchTLS')">
                <div><div class="list-item-label">仅TLS节点</div><div class="list-item-description">不生成非TLS节点（如80端口）</div></div>
                <div class="switch" id="switchTLS"></div>
            </div>
            <div class="list-item" onclick="toggleSwitch('switchECH')">
                <div><div class="list-item-label">ECH (Encrypted Client Hello)</div></div>
                <div class="switch" id="switchECH"></div>
            </div>
            <div class="form-group" id="echOptionsGroup" style="display: none; margin-top: 12px;">
                <input type="text" id="customDNS" placeholder="ECH DNS: https://dns..."><br><br>
                <input type="text" id="customECHDomain" placeholder="ECH Domain: cloudflare-ech.com">
            </div>
        </div>
        <div class="footer"><p>极简命名版工具 • 纯净私有定制</p></div>
    </div>
    <script>
        let switches = {switchDomain: false, switchIP: false, switchGitHub: true, switchVL: true, switchTJ: false, switchVM: false, switchTLS: false, switchECH: false};
        function toggleSwitch(id) {
            switches[id] = !switches[id];
            document.getElementById(id).classList.toggle('active');
            if (id === 'switchECH') {
                document.getElementById('echOptionsGroup').style.display = switches.switchECH ? 'block' : 'none';
                if (switches.switchECH && !switches.switchTLS) { switches.switchTLS = true; document.getElementById('switchTLS').classList.add('active'); }
            }
        }
        const SUB_CONVERTER_URL = "${ scu }";
        function tryOpenApp(schemeUrl, fallback, timeout=2500) {
            let opened=false, called=false, start=Date.now();
            const handler = () => { if(Date.now()-start<3000 && !called) opened=true; };
            window.addEventListener('blur', handler);
            document.addEventListener('visibilitychange', handler);
            const iframe = document.createElement('iframe');
            iframe.style.display='none'; iframe.src=schemeUrl; document.body.appendChild(iframe);
            setTimeout(() => {
                if(iframe.parentNode) iframe.parentNode.removeChild(iframe);
                window.removeEventListener('blur', handler);
                document.removeEventListener('visibilitychange', handler);
                if(!called) { called=true; if(!opened && fallback) fallback(); }
            }, timeout);
        }
        function generateClientLink(clientType, clientName) {
            const domain=document.getElementById('domain').value.trim(), uuid=document.getElementById('uuid').value.trim();
            if(!domain || !uuid) return alert('请先填写域名和UUID/Password');
            if(!switches.switchVL && !switches.switchTJ && !switches.switchVM) return alert('请选择至少一个协议');
            
            let url = \`\${location.origin}/\${uuid}/sub?domain=\${encodeURIComponent(domain)}&epd=\${switches.switchDomain?'yes':'no'}&epi=\${switches.switchIP?'yes':'no'}&egi=\${switches.switchGitHub?'yes':'no'}\`;
            const gitUrl = document.getElementById('githubUrl').value.trim();
            if(gitUrl) url += \`&piu=\${encodeURIComponent(gitUrl)}\`;
            
            if(switches.switchVL) url+='&ev=yes';
            if(switches.switchTJ) url+='&et=yes';
            if(switches.switchVM) url+='&mess=yes';
            if(!document.getElementById('ipv4Enabled').checked) url+='&ipv4=no';
            if(!document.getElementById('ipv6Enabled').checked) url+='&ipv6=no';
            if(!document.getElementById('ispMobile').checked) url+='&ispMobile=no';
            if(!document.getElementById('ispUnicom').checked) url+='&ispUnicom=no';
            if(!document.getElementById('ispTelecom').checked) url+='&ispTelecom=no';
            if(switches.switchTLS) url+='&dkby=yes';
            if(switches.switchECH) {
                url+='&ech=yes';
                const d1=document.getElementById('customDNS').value, d2=document.getElementById('customECHDomain').value;
                if(d1) url+=\`&customDNS=\${encodeURIComponent(d1)}\`;
                if(d2) url+=\`&customECHDomain=\${encodeURIComponent(d2)}\`;
            }
            const cp=document.getElementById('customPath').value;
            if(cp && cp!=='/') url+=\`&path=\${encodeURIComponent(cp)}\`;
            
            let finalUrl=url, schemeUrl='';
            if(clientType==='v2ray') {
                const el=document.getElementById('clientSubscriptionUrl'); el.textContent=url; el.style.display='block';
                const schemes = {'Shadowrocket':'shadowrocket://add/','V2RAYNG':'v2rayng://install?url=','NEKORAY':'nekoray://install-config?url='};
                if(schemes[clientName]) {
                    tryOpenApp(schemes[clientName]+encodeURIComponent(url), () => navigator.clipboard.writeText(url).then(()=>alert(clientName+' 链接已复制')));
                } else { navigator.clipboard.writeText(url).then(()=>alert(clientName+' 链接已复制')); }
            } else {
                finalUrl = SUB_CONVERTER_URL + '?target=' + clientType + '&url=' + encodeURIComponent(url) + '&insert=false&emoji=true&list=false&xudp=false&udp=false&tfo=false&expand=true&scv=false&fdn=false&new_name=true';
                document.getElementById('clientSubscriptionUrl').textContent = finalUrl;
                document.getElementById('clientSubscriptionUrl').style.display='block';
                const schemes = {'STASH':'stash://install?url=','CLASH':'clash://install-config?url=','SURGE':'surge:///install-config?url=','SING-BOX':'sing-box://install-config?url=','LOON':'loon://install?url=','QUANTUMULT X':'quantumult-x://install-config?url='};
                if(schemes[clientName]) tryOpenApp(schemes[clientName]+encodeURIComponent(finalUrl), () => navigator.clipboard.writeText(finalUrl).then(()=>alert(clientName+' 链接已复制')));
                else navigator.clipboard.writeText(finalUrl).then(()=>alert(clientName+' 链接已复制'));
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
        
        if (path === '/test-optimize-api') {
            if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
            const apiUrl = url.searchParams.get('url');
            if (!apiUrl) return new Response(JSON.stringify({ success: false, error: '缺少url参数' }), { status: 400 });
            try {
                const results = await fetchOptimizedAPI([apiUrl], url.searchParams.get('port') || '443', parseInt(url.searchParams.get('timeout') || '3000'));
                return new Response(JSON.stringify({ success: true, results, total: results.length }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
            } catch (error) { return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 }); }
        }
        
        const pathMatch = path.match(/^\/([^\/]+)\/sub$/);
        if (pathMatch) {
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
                evEnabled: url.searchParams.get('ev') === 'yes' || (url.searchParams.get('ev') === null && DEFAULT_CONFIG.ev),
                etEnabled: url.searchParams.get('et') === 'yes',
                vmEnabled: url.searchParams.get('mess') === 'yes',
                ipv4Enabled: url.searchParams.get('ipv4') !== 'no',
                ipv6Enabled: url.searchParams.get('ipv6') !== 'no',
                ispMobile: url.searchParams.get('ispMobile') !== 'no',
                ispUnicom: url.searchParams.get('ispUnicom') !== 'no',
                ispTelecom: url.searchParams.get('ispTelecom') !== 'no',
                disableNonTLS: url.searchParams.get('dkby') === 'yes',
                echConfig: null
            };

            if (!url.searchParams.get('domain')) return new Response('缺少域名参数', { status: 400 });

            const echParam = url.searchParams.get('ech');
            if (echParam === 'yes' || (echParam === null && DEFAULT_CONFIG.enableECH)) {
                reqConfig.disableNonTLS = true;
                reqConfig.echConfig = `${url.searchParams.get('customECHDomain') || DEFAULT_CONFIG.customECHDomain}+${url.searchParams.get('customDNS') || DEFAULT_CONFIG.customDNS}`;
            }

            return await handleSubscriptionRequest(request, reqConfig);
        }
        
        return new Response('Not Found', { status: 404 });
    }
};
