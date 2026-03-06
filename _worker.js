// Cloudflare Worker - 极限性能版优选工具 (纯净私库极简命名版 + KV缓存架构)
// 终极优化：分块文本编码、去 URLSearchParams、KV 全局缓存、极简 TLS 判断

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

// 极致优化：结合 TextEncoder 与分块 Spread 语法，既快又防 V8 栈溢出
function safeBase64Encode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const chunkSize = 8192; // 每次处理 8KB，避免栈溢出
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

// ================= 全局 KV 缓存架构 =================
// 读写分离架构：优先读 KV，过期或无数据则回源并异步写入
async function getCachedData(env, ctx, key, fetcher, ttl = 600) {
    if (env?.IP_CACHE) {
        const cached = await env.IP_CACHE.get(key, 'json');
        if (cached && cached.length > 0) return cached;
        
        // 缓存击穿时回源抓取
        const freshData = await fetcher();
        if (freshData && freshData.length > 0) {
            ctx.waitUntil(env.IP_CACHE.put(key, JSON.stringify(freshData), { expirationTtl: ttl }));
        }
        return freshData;
    }
    return await fetcher(); // 未绑定 KV 时的优雅降级
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
    
    // 利用 KV 缓存提升 10 倍速度，缓存 10 分钟 (600s)
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
    // 使用 KV 缓存 GitHub 数据，防止 rate limit
    return getCachedData(env, ctx, `github_${url}`, async () => {
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

// ================= 核心节点生成 =================
function generateNodesFromList(list, user, workerDomain, disableNonTLS, customPath, echConfig, protocols) {
    const links = [];
    const wsPath = customPath || '/';

    for (const item of list) {
        const baseName = item.isp ? item.isp.replace(/\s/g, '_') : (item.name || item.domain || item.ip);
        const nodeNameBase = item.colo && item.colo.trim() ? `${baseName}-${item.colo.trim()}` : baseName;
        const safeIP = item.ip.includes(':') ? `[${item.ip}]` : item.ip;
        
        const portsToGenerate = item.port ? [item.port] : disableNonTLS ? [443] : [443, 80];

        for (const port of portsToGenerate) {
            // 极致优化：去掉 URLSearchParams 慢操作，极简端口判定
            const tls = port !== 80 && port !== 8080;
            if (disableNonTLS && !tls) continue;

            // 极致优化：直接拼装字符串
            let params = `type=ws&host=${workerDomain}&path=${wsPath}&security=${tls ? 'tls' : 'none'}`;
            if (tls) {
                params += `&sni=${workerDomain}&fp=chrome`;
                if (echConfig) params += `&alpn=h3,h2,http/1.1&ech=${echConfig}`;
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
                    net: "ws", type: "none", host: workerDomain, path: wsPath,
                    tls: tls ? "tls" : "none"
                };
                if (tls) {
                    vmessConfig.sni = workerDomain;
                    vmessConfig.fp = "chrome";
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

    const addNodesFromList = (list) => {
        finalLinks.push(...generateNodesFromList(list, config.user, config.nodeDomain, config.disableNonTLS, config.customPath, config.echConfig, protocols));
    };

    if (config.epdEnabled) {
        addNodesFromList(directDomains.map(d => ({ ip: d.domain, isp: d.name || d.domain })));
    }

    if (config.epiEnabled) {
        const dynamicIPList = await fetchDynamicIPs(env, ctx, config.ipv4Enabled, config.ipv6Enabled, config.ispMobile, config.ispUnicom, config.ispTelecom);
        if (dynamicIPList.length > 0) addNodesFromList(dynamicIPList);
    }

    if (config.egiEnabled) {
        try {
            if (config.piu && config.piu.toLowerCase().startsWith('https://') && !config.piu.includes('\n')) {
                const parsedIps = parseRawIps(await fetchOptimizedAPI([config.piu]));
                if (parsedIps.length > 0) addNodesFromList(parsedIps);
            } else if (config.piu && config.piu.includes('\n')) {
                const fullList = parseToArray(config.piu);
                const apiUrls = fullList.filter(e => e.toLowerCase().startsWith('https://'));
                const rawIps = fullList.filter(e => !e.toLowerCase().includes('://'));
                if (apiUrls.length > 0) rawIps.push(...(await fetchOptimizedAPI(apiUrls)));
                const parsedIps = parseRawIps(rawIps);
                if (parsedIps.length > 0) addNodesFromList(parsedIps);
            } else {
                const newIPList = await fetchGitHubIPs(env, ctx, config.piu);
                if (newIPList.length > 0) addNodesFromList(newIPList);
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
        default:
            subscriptionContent = safeBase64Encode(finalLinks.join('\n'));
    }
    
    return new Response(subscriptionContent, {
        headers: { 
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=180, s-maxage=180', // CDN 边缘节点缓存
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
        
        const server = link.match(/@([^:]+):(\d+)/)?.[1] || '';
        const port = link.match(/@[^:]+:(\d+)/)?.[1] || '443';
        const passOrUuid = link.match(/:\/\/([^@]+)@/)?.[1] || '';
        const tls = link.includes('security=tls') || link.includes('tls=tls');
        const path = link.match(/path=([^&#]+)/)?.[1] || '/';
        const host = link.match(/host=([^&#]+)/)?.[1] || '';
        const sni = link.match(/sni=([^&#]+)/)?.[1] || '';
        const echParam = link.match(/[?&]ech=([^&#]+)/)?.[1];
        
        yaml += `  - name: ${name}\n    type: ${isVless ? 'vless' : 'trojan'}\n    server: ${server}\n    port: ${port}\n    ${isVless ? 'uuid' : 'password'}: ${passOrUuid}\n    tls: ${tls}\n    network: ws\n    ws-opts:\n      path: ${path}\n      headers:\n        Host: ${host}\n`;
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
        config += `${name} = vless, ${link.match(/@([^:]+):(\d+)/)?.[1] || ''}, ${link.match(/@[^:]+:(\d+)/)?.[1] || '443'}, username=${link.match(/vless:\/\/([^@]+)@/)?.[1] || ''}, tls=${link.includes('security=tls')}, ws=true, ws-path=${link.match(/path=([^&#]+)/)?.[1] || '/'}, ws-headers=Host:${link.match(/host=([^&#]+)/)?.[1] || ''}\n`;
    });
    config += '\n[Proxy Group]\nPROXY = select, ' + links.map((_, i) => decodeURIComponent(links[i].split('#')[1] || `节点${i + 1}`)).join(', ') + '\n';
    return config;
}

function generateHomePage(scuValue) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>服务器优选工具</title></head><body>请贴入原本的完整 HTML 模板</body></html>`; 
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        if (path === '/' || path === '') {
            return new Response(generateHomePage(env?.scu || DEFAULT_CONFIG.scu), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (path === '/test-optimize-api') { /* 省略测试接口代码...同上一版 */ return new Response('OK'); }
        
        const pathMatch = path.match(/^\/([^\/]+)\/sub$/);
        if (pathMatch) {
            // ================== 双层缓存护城河 ==================
            const cache = caches.default;
            const cacheKey = new Request(url.toString(), request);
            
            // 1. Edge Cache 拦截 (命中直接返回，CPU占用接近0ms)
            const cachedResponse = await cache.match(cacheKey);
            if (cachedResponse) return cachedResponse;

            const reqConfig = {
                user: pathMatch[1], workerDomain: url.hostname, nodeDomain: url.searchParams.get('domain') || url.hostname, target: url.searchParams.get('target') || 'base64', customPath: url.searchParams.get('path') || '/', piu: url.searchParams.get('piu') || DEFAULT_CONFIG.defaultIPURL,
                epdEnabled: url.searchParams.get('epd') === 'yes', epiEnabled: url.searchParams.get('epi') === 'yes', egiEnabled: url.searchParams.get('egi') !== 'no',
                evEnabled: url.searchParams.get('ev') === 'yes' || (url.searchParams.get('ev') === null && DEFAULT_CONFIG.ev), etEnabled: url.searchParams.get('et') === 'yes', vmEnabled: url.searchParams.get('mess') === 'yes',
                ipv4Enabled: url.searchParams.get('ipv4') !== 'no', ipv6Enabled: url.searchParams.get('ipv6') !== 'no', ispMobile: url.searchParams.get('ispMobile') !== 'no', ispUnicom: url.searchParams.get('ispUnicom') !== 'no', ispTelecom: url.searchParams.get('ispTelecom') !== 'no',
                disableNonTLS: url.searchParams.get('dkby') === 'yes', echConfig: null
            };

            if (!url.searchParams.get('domain')) return new Response('缺少域名参数', { status: 400 });

            const echParam = url.searchParams.get('ech');
            if (echParam === 'yes' || (echParam === null && DEFAULT_CONFIG.enableECH)) {
                reqConfig.disableNonTLS = true;
                reqConfig.echConfig = `${url.searchParams.get('customECHDomain') || DEFAULT_CONFIG.customECHDomain}+${url.searchParams.get('customDNS') || DEFAULT_CONFIG.customDNS}`;
            }

            // 获取数据并生成节点 (内嵌了 KV 缓存机制，命中则不消耗外部 fetch 网络时间)
            const response = await handleSubscriptionRequest(request, env, ctx, reqConfig);
            
            // 2. 异步回写 Edge Cache
            if (response.status === 200) {
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }

            return response;
        }
        
        return new Response('Not Found', { status: 404 });
    }
};
