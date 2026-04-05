// Cloudflare Worker - 极限性能版优选工具 (v4.4 经典UI回归 + XHTTP底层优化终极版)
// 终极架构：CloudflareST -> GitHub -> Worker KV -> Edge CDN -> 手机订阅

const DEFAULT_CONFIG = {
    epd: false, epi: false, egi: true,
    ev: true, et: false, vm: false,
    scu: 'https://url.v1.mk/sub',
    enableECH: false,
    customDNS: 'https://dns.joeyblog.eu.org/joeyblog',
    customECHDomain: 'cloudflare-ech.com',
    defaultIPURL: 'https://gist.githubusercontent.com/shiyikeji/3aa87176e89a34e48f72487fbbada9d2/raw/my_best_ips.txt'
};

const directDomains = []; 

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
    } catch (e) {
        return [];
    }
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
                if (name.includes('官方优选IPv6')) return false;
                if (name.includes('移动') && !ispMobile) return false;
                if (name.includes('联通') && !ispUnicom) return false;
                if (name.includes('电信') && !ispTelecom) return false;
                return true;
            });
        }
        return results;
    } catch (e) {
        return [];
    }
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
        } catch (e) {
            return [];
        }
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

// ================= 核心节点生成 (隐藏优化逻辑) =================
function generateNodesFromList(list, user, workerDomain, disableNonTLS, customPath, echConfig, protocols, config) {
    const links = [];
    const reqPath = customPath || '/';
    
    // ALPN 智能回退逻辑
    let alpnStr = 'h2,http/1.1';
    if (config.strictH1) {
        alpnStr = 'http/1.1'; // 解决 Karing END_STREAM 报错
    } else if (config.enableUDP) {
        alpnStr = 'h3,h2,http/1.1'; 
    }

    for (const item of list) {
        const baseName = item.isp ? item.isp.replace(/\s/g, '_') : (item.name || item.domain || item.ip);
        const nodeNameBase = item.colo && item.colo.trim() ? `${baseName}-${item.colo.trim()}` : baseName;
        const safeIP = item.ip.includes(':') ? `[${item.ip}]` : item.ip;
        
        const portsToGenerate = item.port ? [item.port] : (disableNonTLS ? [443] : [443, 80]);

        for (const port of portsToGenerate) {
            const tls = port !== 80 && port !== 8080;
            if (disableNonTLS && !tls) continue;

            let params = `type=${config.network}&host=${workerDomain}&path=${reqPath}&security=${tls ? 'tls' : 'none'}`;
            if (tls) {
                params += `&sni=${workerDomain}&fp=chrome&alpn=${encodeURIComponent(alpnStr)}`;
                if (echConfig) params += `&ech=${echConfig}`;
            }

            if (protocols.evEnabled) {
                links.push(`vless://${user}@${safeIP}:${port}?encryption=none&${params}#${encodeURIComponent(nodeNameBase)}`);
            }
            if (protocols.etEnabled) {
                links.push(`trojan://${user}@${safeIP}:${port}?${params}#${encodeURIComponent(nodeNameBase)}`);
            }
            if (protocols.vmEnabled) {
                const vmessConfig = {
                    v: "2", ps: nodeNameBase, add: safeIP, port: port.toString(), id: user, aid: "0", scy: "auto",
                    net: config.network, type: "none", host: workerDomain, path: reqPath,
                    tls: tls ? "tls" : "none"
                };
                if (tls) {
                    vmessConfig.sni = workerDomain;
                    vmessConfig.fp = "chrome";
                    vmessConfig.alpn = alpnStr;
                }
                links.push(`vmess://${safeBase64Encode(JSON.stringify(vmessConfig))}`);
            }
        }
    }
    return links;
}

// ================= 订阅及配置生成 =================
async function handleSubscriptionRequest(request, env, ctx, config) {
    const finalLinks = [];
    const protocols = {
        evEnabled: config.evEnabled || (!config.evEnabled && !config.etEnabled && !config.vmEnabled),
        etEnabled: config.etEnabled,
        vmEnabled: config.vmEnabled
    };

    let allRawNodes = [];

    if (config.epdEnabled) {
        allRawNodes.push(...directDomains.map(d => ({ ip: d.domain, port: 443, name: d.name || d.domain })));
    }

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
        } catch (error) {}
    }

    const uniqueNodesMap = new Map();
    for (const node of allRawNodes) {
        if (node && node.ip) {
            uniqueNodesMap.set(`${node.ip}:${node.port || 443}`, node);
        }
    }
    let deduplicatedList = Array.from(uniqueNodesMap.values());

    const godPrefixes = ['43.161.', '43.160.', '43.152.', '8.210.', '47.74.', '47.76.', '47.79.', '129.226.', '150.109.', '54.251.', '54.169.', '18.136.', '13.212.', '52.220.', '34.87.', '34.124.', '35.185.', '35.197.', '20.198.', '20.205.', '40.79.', '52.187.', '128.199.', '139.59.', '134.209.', '45.32.', '149.28.', '139.180.'];
    const hkKeywords = ['香港', 'HK', 'HKG', 'HKT', 'HKBN', 'HONGKONG'];

    const sortedList = deduplicatedList.map(item => {
        const isGod = godPrefixes.some(prefix => item.ip.startsWith(prefix));
        const nameStr = item.name || item.ip || '';
        const isHK = hkKeywords.some(k => nameStr.toUpperCase().includes(k));
        
        let score = 0;
        if (isGod) score += 100;
        if (isHK) score += 50;

        let finalName = nameStr;
        if (isGod) finalName = `🚀神级-${nameStr}`;
        else if (isHK && !isGod) finalName = `🇭🇰优选-${nameStr}`;

        return { ...item, _score: score, name: finalName };
    }).sort((a, b) => b._score - a._score); 

    if (sortedList.length > 0) {
        finalLinks.push(...generateNodesFromList(sortedList, config.user, config.nodeDomain, config.disableNonTLS, config.customPath, config.echConfig, protocols, config));
    }

    if (finalLinks.length === 0) {
        finalLinks.push(`vless://00000000-0000-0000-0000-000000000000@127.0.0.1:80?encryption=none&security=none&type=ws&host=error.com&path=%2F#${encodeURIComponent("所有节点获取失败")}`);
    }

    let subscriptionContent;
    let contentType = 'text/plain; charset=utf-8';
    
    switch (config.target.toLowerCase()) {
        case 'clash':
        case 'clashr':
            subscriptionContent = generateClashConfig(finalLinks, config);
            contentType = 'text/yaml; charset=utf-8';
            break;
        case 'surge':
        case 'surge2':
        case 'surge3':
        case 'surge4':
            subscriptionContent = generateSurgeConfig(finalLinks);
            break;
        default:
            subscriptionContent = safeBase64Encode(finalLinks.join('\n'));
    }
    
    return new Response(subscriptionContent, {
        headers: { 
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=600, s-maxage=600', 
            'Access-Control-Allow-Origin': '*',
            'Content-Disposition': 'attachment; filename="sub.txt"',
        },
    });
}

function generateClashConfig(links, config) {
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
        const path = link.match(/path=([^&#]+)/)?.[1] || '/';
        const host = link.match(/host=([^&#]+)/)?.[1] || '';
        const sni = link.match(/sni=([^&#]+)/)?.[1] || '';
        const echParam = link.match(/[?&]ech=([^&#]+)/)?.[1];
        const network = link.match(/[?&]type=([^&#]+)/)?.[1] || 'ws';
        
        yaml += `  - name: ${name}\n    type: ${isVless ? 'vless' : 'trojan'}\n    server: ${server}\n    port: ${port}\n    ${isVless ? 'uuid' : 'password'}: ${passOrUuid}\n    tls: ${tls}\n    network: ${network}\n    udp: ${config.enableUDP}\n`;
        
        if (tls) {
            yaml += `    alpn:\n`;
            if (config.strictH1) {
                yaml += `      - http/1.1\n`;
            } else if (config.enableUDP) {
                yaml += `      - h3\n      - h2\n      - http/1.1\n`;
            } else {
                yaml += `      - h2\n      - http/1.1\n`;
            }
        }

        if (network === 'ws') {
            yaml += `    ws-opts:\n      path: ${path}\n      headers:\n        Host: ${host}\n`;
        } else if (network === 'xhttp') {
            yaml += `    xhttp-opts:\n      path: ${path}\n      headers:\n        Host: ${host}\n`;
        }

        if (sni) yaml += `    servername: ${sni}\n`;
        if (echParam) yaml += `    ech-opts:\n      enable: true\n      query-server-name: ${decodeURIComponent(echParam).split('+')[0]}\n`;
    });
    yaml += `\nproxy-groups:\n  - name: PROXY\n    type: select\n    proxies: [${proxyNames.map(n => `'${n}'`).join(', ')}]\nrules:\n  - DOMAIN-SUFFIX,local,DIRECT\n  - IP-CIDR,127.0.0.0/8,DIRECT\n  - GEOIP,CN,DIRECT\n  - MATCH,PROXY\n`;
    return yaml;
}

function generateSurgeConfig(links) {
    let config = '[Proxy]\n';
    links.forEach((link, i) => {
        const name = decodeURIComponent(link.split('#')[1] || `节点${i+1}`);
        const network = link.match(/[?&]type=([^&#]+)/)?.[1] || 'ws';
        let netOptions = '';
        if (network === 'ws') {
            netOptions = `, ws=true, ws-path=${link.match(/path=([^&#]+)/)?.[1] || '/'}, ws-headers=Host:${link.match(/host=([^&#]+)/)?.[1] || ''}`;
        }
        config += `${name} = vless, ${link.match(/@([^:]+):(\d+)/)?.[1] || ''}, ${link.match(/@[^:]+:(\d+)/)?.[1] || '443'}, username=${link.match(/vless:\/\/([^@]+)@/)?.[1] || ''}, tls=${link.includes('security=tls')}${netOptions}\n`;
    });
    config += '\n[Proxy Group]\nPROXY = select, ' + links.map((_, i) => decodeURIComponent(links[i].split('#')[1] || `节点${i + 1}`)).join(', ') + '\n';
    return config;
}

// ================= 原汁原味 UI 逻辑回归 =================
function generateHomePage(scuValue) {
    const scu = scuValue || 'https://url.v1.mk/sub';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>服务器优选工具</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif; background: linear-gradient(180deg, #f5f5f7 0%, #ffffff 50%, #fafafa 100%); color: #1d1d1f; min-height: 100vh; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); overflow-x: hidden; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; padding: 48px 20px 32px; }
        .header h1 { font-size: 40px; font-weight: 700; letter-spacing: -0.3px; color: #1d1d1f; margin-bottom: 8px; line-height: 1.1; }
        .header p { font-size: 17px; color: #86868b; font-weight: 400; line-height: 1.5; }
        .card { background: rgba(255, 255, 255, 0.75); backdrop-filter: blur(30px) saturate(200%); -webkit-backdrop-filter: blur(30px) saturate(200%); border-radius: 24px; padding: 28px; margin-bottom: 20px; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.05); border: 0.5px solid rgba(0, 0, 0, 0.06); will-change: transform; }
        .form-group { margin-bottom: 24px; }
        .form-group:last-child { margin-bottom: 0; }
        .form-group label { display: block; font-size: 13px; font-weight: 600; color: #86868b; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        .form-group input, .form-group textarea { width: 100%; padding: 14px 16px; font-size: 17px; font-weight: 400; color: #1d1d1f; background: rgba(142, 142, 147, 0.12); border: 2px solid transparent; border-radius: 12px; outline: none; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); -webkit-appearance: none; }
        .form-group input:focus, .form-group textarea:focus { background: rgba(142, 142, 147, 0.16); border-color: #007AFF; transform: scale(1.005); }
        .form-group input::placeholder, .form-group textarea::placeholder { color: #86868b; }
        .form-group small { display: block; margin-top: 8px; color: #86868b; font-size: 13px; line-height: 1.4; }
        .list-item { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; min-height: 52px; cursor: pointer; border-bottom: 0.5px solid rgba(0, 0, 0, 0.08); transition: background-color 0.15s ease; }
        .list-item:last-child { border-bottom: none; }
        .list-item:active { background-color: rgba(142, 142, 147, 0.08); margin: 0 -28px; padding-left: 28px; padding-right: 28px; }
        .list-item-label { font-size: 17px; font-weight: 400; color: #1d1d1f; flex: 1; }
        .list-item-description { font-size: 13px; color: #86868b; margin-top: 4px; line-height: 1.4; }
        .switch { position: relative; width: 51px; height: 31px; background: rgba(142, 142, 147, 0.3); border-radius: 16px; transition: background 0.3s cubic-bezier(0.4, 0, 0.2, 1); cursor: pointer; flex-shrink: 0; }
        .switch.active { background: #34C759; }
        .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; background: #ffffff; border-radius: 50%; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15), 0 1px 2px rgba(0, 0, 0, 0.1); }
        .switch.active::after { transform: translateX(20px); }
        .btn { width: 100%; padding: 16px; font-size: 17px; font-weight: 600; color: #ffffff; background: #007AFF; border: none; border-radius: 14px; cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); margin-top: 8px; -webkit-appearance: none; box-shadow: 0 4px 12px rgba(0, 122, 255, 0.25); will-change: transform; }
        .btn:hover { background: #0051D5; box-shadow: 0 6px 16px rgba(0, 122, 255, 0.3); }
        .btn:active { transform: scale(0.97); box-shadow: 0 2px 8px rgba(0, 122, 255, 0.2); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .btn-secondary { background: rgba(142, 142, 147, 0.12); color: #007AFF; box-shadow: none; }
        .btn-secondary:hover { background: rgba(142, 142, 147, 0.16); }
        .btn-secondary:active { background: rgba(142, 142, 147, 0.2); }
        .result { margin-top: 20px; padding: 16px; background: rgba(142, 142, 147, 0.12); border-radius: 12px; font-size: 15px; color: #1d1d1f; word-break: break-all; display: none; line-height: 1.5; }
        .result.show { display: block; }
        .result-card { padding: 16px; background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 12px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06); border: 0.5px solid rgba(0, 0, 0, 0.06); }
        .result-url { margin-top: 12px; padding: 12px; background: rgba(0, 122, 255, 0.1); border-radius: 10px; font-size: 13px; color: #007aff; word-break: break-all; line-height: 1.5; }
        .copy-btn { margin-top: 8px; padding: 10px 16px; font-size: 15px; background: rgba(0, 122, 255, 0.1); color: #007aff; border: none; border-radius: 10px; cursor: pointer; transition: all 0.2s ease; }
        .copy-btn:active { background: rgba(0, 122, 255, 0.2); transform: scale(0.98); }
        .client-btn { padding: 12px 16px; font-size: 14px; font-weight: 500; color: #007AFF; background: rgba(0, 122, 255, 0.1); border: 1px solid rgba(0, 122, 255, 0.2); border-radius: 12px; cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); -webkit-appearance: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .client-btn:active { transform: scale(0.97); background: rgba(0, 122, 255, 0.2); border-color: rgba(0, 122, 255, 0.3); }
        .checkbox-label { display: flex; align-items: center; cursor: pointer; font-size: 17px; font-weight: 400; user-select: none; -webkit-user-select: none; position: relative; z-index: 1; padding: 8px 0; }
        .checkbox-label input[type="checkbox"] { margin-right: 12px; width: 22px; height: 22px; cursor: pointer; flex-shrink: 0; position: relative; z-index: 2; -webkit-appearance: checkbox; appearance: checkbox; }
        .checkbox-label span { cursor: pointer; position: relative; z-index: 1; }
        @media (max-width: 480px) { .client-btn { font-size: 12px; padding: 10px 12px; } .header h1 { font-size: 34px; } }
        .footer { text-align: center; padding: 32px 20px; color: #86868b; font-size: 13px; }
        .footer a { color: #007AFF; text-decoration: none; font-weight: 500; transition: opacity 0.2s ease; }
        .footer a:active { opacity: 0.6; }
        @media (prefers-color-scheme: dark) {
            body { background: linear-gradient(180deg, #000000 0%, #1c1c1e 50%, #2c2c2e 100%); color: #f5f5f7; }
            .card { background: rgba(28, 28, 30, 0.75); border: 0.5px solid rgba(255, 255, 255, 0.12); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2); }
            .form-group input, .form-group textarea { background: rgba(142, 142, 147, 0.2); color: #f5f5f7; }
            .form-group input:focus, .form-group textarea:focus { background: rgba(142, 142, 147, 0.25); border-color: #5ac8fa; }
            .list-item { border-bottom-color: rgba(255, 255, 255, 0.1); }
            .list-item:active { background: rgba(255, 255, 255, 0.08); }
            .list-item-label { color: #f5f5f7; }
            .switch { background: rgba(142, 142, 147, 0.4); }
            .switch.active { background: #30d158; }
            .switch::after { background: #ffffff; }
            .result { background: rgba(142, 142, 147, 0.2); color: #f5f5f7; }
            .result-card { background: rgba(28, 28, 30, 0.9); border-color: rgba(255, 255, 255, 0.1); }
            .checkbox-label span { color: #f5f5f7; }
            .client-btn { background: rgba(0, 122, 255, 0.15) !important; border-color: rgba(0, 122, 255, 0.3) !important; color: #5ac8fa !important; }
            .footer a { color: #5ac8fa !important; }
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
                <small style="display: block; margin-top: 6px; color: #86868b; font-size: 13px;">自定义传输路径，例如：/v2ray 或 /</small>
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
                <input type="text" id="githubUrl" placeholder="留空则使用内置的纯净链接" style="font-size: 15px;">
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
                    <button type="button" class="client-btn" onclick="generateClientLink('clash', 'CLASH')">CLASH</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('clash', 'STASH')">STASH</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('surge', 'SURGE')">SURGE</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('sing-box', 'SING-BOX')">SING-BOX</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('loon', 'LOON')">LOON</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('quanx', 'QUANTUMULT X')" style="font-size: 13px;">QUANTUMULT X</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'V2RAY')">V2RAY</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'V2RAYNG')">V2RAYNG</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'NEKORAY')">NEKORAY</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'Shadowrocket')" style="font-size: 13px;">Shadowrocket</button>
                </div>
                <div class="result-url" id="clientSubscriptionUrl" style="display: none; margin-top: 12px; padding: 12px; background: rgba(0, 122, 255, 0.1); border-radius: 8px; font-size: 13px; color: #007aff; word-break: break-all;"></div>
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
            
            <div class="list-item" onclick="toggleSwitch('switchXHTTP')" style="margin-top: 8px;">
                <div>
                    <div class="list-item-label">启用 XHTTP 协议</div>
                    <div class="list-item-description">不开启则默认使用最稳定的 WebSocket (推荐)</div>
                </div>
                <div class="switch" id="switchXHTTP"></div>
            </div>

            <div class="list-item" onclick="toggleSwitch('switchUDP')" style="margin-top: 8px;">
                <div>
                    <div class="list-item-label">启用 UDP 转发 (HTTP/3)</div>
                    <div class="list-item-description">易被国内运营商阻断，仅在 XHTTP 稳定时开启</div>
                </div>
                <div class="switch" id="switchUDP"></div>
            </div>

            <div class="list-item" onclick="toggleSwitch('switchH1')" style="margin-top: 8px;">
                <div>
                    <div class="list-item-label">Karing / Sing-box 兼容防报错</div>
                    <div class="list-item-description">强降 HTTP/1.1，彻底解决 END_STREAM 断流</div>
                </div>
                <div class="switch" id="switchH1"></div>
            </div>

            <div class="list-item" onclick="toggleSwitch('switchTLS')" style="margin-top: 8px;">
                <div>
                    <div class="list-item-label">仅TLS节点</div>
                    <div class="list-item-description">启用后只生成带TLS的节点，不生成非TLS节点（如80端口）</div>
                </div>
                <div class="switch" id="switchTLS"></div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchECH')" style="margin-top: 8px;">
                <div>
                    <div class="list-item-label">ECH (Encrypted Client Hello)</div>
                    <div class="list-item-description">启用后节点链接将携带 ECH 参数，需客户端支持；开启时自动仅TLS</div>
                </div>
                <div class="switch" id="switchECH"></div>
            </div>
            <div class="form-group" id="echOptionsGroup" style="margin-top: 12px; display: none;">
                <label>ECH 自定义 DNS（可选）</label>
                <input type="text" id="customDNS" placeholder="例如: https://dns.joeyblog.eu.org/joeyblog" style="font-size: 14px;">
                <small style="display: block; margin-top: 6px; color: #86868b; font-size: 13px;">用于 ECH 配置查询的 DoH 地址</small>
                <label style="margin-top: 12px; display: block;">ECH 域名（可选）</label>
                <input type="text" id="customECHDomain" placeholder="例如: cloudflare-ech.com" style="font-size: 14px;">
            </div>
        </div>
        
        <div class="footer">
            <p>极简命名版工具 • 纯净私有定制</p>
        </div>
    </div>
    
    <script>
        let switches = {
            switchDomain: false, switchIP: false, switchGitHub: true, switchVL: true,
            switchTJ: false, switchVM: false, switchTLS: false, switchECH: false,
            switchXHTTP: false, switchUDP: false, switchH1: false
        };
        
        function toggleSwitch(id) {
            const switchEl = document.getElementById(id);
            switches[id] = !switches[id];
            switchEl.classList.toggle('active');
            
            // 互斥逻辑保护
            if (id === 'switchH1' && switches.switchH1) {
                if (switches.switchUDP) toggleSwitch('switchUDP');
            }
            if (id === 'switchUDP' && switches.switchUDP) {
                if (switches.switchH1) toggleSwitch('switchH1');
            }
            if (id === 'switchECH') {
                const echOpt = document.getElementById('echOptionsGroup');
                if (echOpt) echOpt.style.display = switches.switchECH ? 'block' : 'none';
                if (switches.switchECH && !switches.switchTLS) {
                    switches.switchTLS = true;
                    const tlsEl = document.getElementById('switchTLS');
                    if (tlsEl) tlsEl.classList.add('active');
                }
            }
        }
        
        const SUB_CONVERTER_URL = "${ scu }";
        
        function tryOpenApp(schemeUrl, fallbackCallback, timeout) {
            timeout = timeout || 2500;
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
            
            if (!domain || !uuid) return alert('请先填写域名和UUID/Password');
            if (!switches.switchVL && !switches.switchTJ && !switches.switchVM) return alert('请至少选择一个协议');
            
            const ipv4 = document.getElementById('ipv4Enabled').checked;
            const ipv6 = document.getElementById('ipv6Enabled').checked;
            const ispMobile = document.getElementById('ispMobile').checked;
            const ispUnicom = document.getElementById('ispUnicom').checked;
            const ispTelecom = document.getElementById('ispTelecom').checked;
            const githubUrl = document.getElementById('githubUrl').value.trim();
            
            const baseUrl = new URL(window.location.href).origin;
            let subUrl = \`\${baseUrl}/\${uuid}/sub?domain=\${encodeURIComponent(domain)}&epd=\${switches.switchDomain ? 'yes' : 'no'}&epi=\${switches.switchIP ? 'yes' : 'no'}&egi=\${switches.switchGitHub ? 'yes' : 'no'}\`;
            
            if (githubUrl) subUrl += \`&piu=\${encodeURIComponent(githubUrl)}\`;
            if (switches.switchVL) subUrl += '&ev=yes';
            if (switches.switchTJ) subUrl += '&et=yes';
            if (switches.switchVM) subUrl += '&mess=yes';
            if (!ipv4) subUrl += '&ipv4=no';
            if (!ipv6) subUrl += '&ipv6=no';
            if (!ispMobile) subUrl += '&ispMobile=no';
            if (!ispUnicom) subUrl += '&ispUnicom=no';
            if (!ispTelecom) subUrl += '&ispTelecom=no';
            if (switches.switchTLS) subUrl += '&dkby=yes';
            
            // XHTTP 与底层优化传参
            if (switches.switchXHTTP) subUrl += '&net=xhttp';
            if (switches.switchUDP) subUrl += '&xudp=yes';
            if (switches.switchH1) subUrl += '&xh1=yes';
            
            if (switches.switchECH) {
                subUrl += '&ech=yes';
                const dnsVal = document.getElementById('customDNS')?.value.trim();
                if (dnsVal) subUrl += \`&customDNS=\${encodeURIComponent(dnsVal)}\`;
                const domainVal = document.getElementById('customECHDomain')?.value.trim();
                if (domainVal) subUrl += \`&customECHDomain=\${encodeURIComponent(domainVal)}\`;
            }
            if (customPath && customPath !== '/') subUrl += \`&path=\${encodeURIComponent(customPath)}\`;
            
            let finalUrl = subUrl, schemeUrl = '', displayName = clientName || '';
            
            if (clientType === 'v2ray') {
                document.getElementById('clientSubscriptionUrl').textContent = finalUrl;
                document.getElementById('clientSubscriptionUrl').style.display = 'block';
                const copyAction = () => navigator.clipboard.writeText(finalUrl).then(() => alert(displayName + ' 订阅链接已复制'));
                
                if (clientName === 'V2RAY') copyAction();
                else if (clientName === 'Shadowrocket') tryOpenApp('shadowrocket://add/' + encodeURIComponent(finalUrl), copyAction);
                else if (clientName === 'V2RAYNG') tryOpenApp('v2rayng://install?url=' + encodeURIComponent(finalUrl), copyAction);
                else if (clientName === 'NEKORAY') tryOpenApp('nekoray://install-config?url=' + encodeURIComponent(finalUrl), copyAction);
            } else {
                finalUrl = SUB_CONVERTER_URL + '?target=' + clientType + '&url=' + encodeURIComponent(subUrl) + '&insert=false&emoji=true&list=false&xudp=' + (switches.switchUDP ? 'true' : 'false') + '&udp=' + (switches.switchUDP ? 'true' : 'false') + '&tfo=false&expand=true&scv=false&fdn=false&new_name=true';
                document.getElementById('clientSubscriptionUrl').textContent = finalUrl;
                document.getElementById('clientSubscriptionUrl').style.display = 'block';
                
                if (clientType === 'clash') {
                    schemeUrl = clientName === 'STASH' ? 'stash://install?url=' + encodeURIComponent(finalUrl) : 'clash://install-config?url=' + encodeURIComponent(finalUrl);
                } else if (clientType === 'surge') schemeUrl = 'surge:///install-config?url=' + encodeURIComponent(finalUrl);
                else if (clientType === 'sing-box') schemeUrl = 'sing-box://install-config?url=' + encodeURIComponent(finalUrl);
                else if (clientType === 'loon') schemeUrl = 'loon://install?url=' + encodeURIComponent(finalUrl);
                else if (clientType === 'quanx') schemeUrl = 'quantumult-x://install-config?url=' + encodeURIComponent(finalUrl);
                
                const copyAction = () => navigator.clipboard.writeText(finalUrl).then(() => alert(displayName + ' 订阅链接已复制'));
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
                user: pathMatch[1], workerDomain: url.hostname, nodeDomain: url.searchParams.get('domain') || url.hostname, target: url.searchParams.get('target') || 'base64', customPath: url.searchParams.get('path') || '/', piu: url.searchParams.get('piu') || DEFAULT_CONFIG.defaultIPURL,
                epdEnabled: url.searchParams.get('epd') === 'yes', epiEnabled: url.searchParams.get('epi') === 'yes', egiEnabled: url.searchParams.get('egi') !== 'no',
                evEnabled: url.searchParams.get('ev') === 'yes' || (url.searchParams.get('ev') === null && DEFAULT_CONFIG.ev), etEnabled: url.searchParams.get('et') === 'yes', vmEnabled: url.searchParams.get('mess') === 'yes',
                ipv4Enabled: url.searchParams.get('ipv4') !== 'no', ipv6Enabled: url.searchParams.get('ipv6') !== 'no', ispMobile: url.searchParams.get('ispMobile') !== 'no', ispUnicom: url.searchParams.get('ispUnicom') !== 'no', ispTelecom: url.searchParams.get('ispTelecom') !== 'no',
                disableNonTLS: url.searchParams.get('dkby') === 'yes', 
                
                // 隐藏的性能优化与降级防御传参
                network: url.searchParams.get('net') === 'xhttp' ? 'xhttp' : 'ws',
                enableUDP: url.searchParams.get('xudp') === 'yes',
                strictH1: url.searchParams.get('xh1') === 'yes',
                echConfig: null
            };

            if (!url.searchParams.get('domain')) return new Response('缺少域名参数', { status: 400 });

            const echParam = url.searchParams.get('ech');
            if (echParam === 'yes' || (echParam === null && DEFAULT_CONFIG.enableECH)) {
                reqConfig.disableNonTLS = true;
                reqConfig.echConfig = `${url.searchParams.get('customECHDomain') || DEFAULT_CONFIG.customECHDomain}+${url.searchParams.get('customDNS') || DEFAULT_CONFIG.customDNS}`;
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
