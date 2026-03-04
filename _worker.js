// Cloudflare Worker - 最终完整版（兼容多客户端订阅输出）
// ✅ 修复：不使用全局可变开关（并发不串参数）
// ✅ 固定：443 + TLS + WS
// ✅ 支持：base64 / clash / surge / quanx / loon / singbox
// ✅ 优选：内置优选域名 + wetest(v4/v6) + GitHub bestcf + 自定义优选API(piu)
// ✅ 缓存：主页 6h、订阅 5m、上游 10m（SWR）
//
// 使用：
// https://<worker-domain>/<UUID>/sub?domain=ss.897922.xyz&target=clash&epd=yes&epi=yes&egi=yes
// target: base64|clash|surge|quanx|loon|singbox
//
// 说明：domain 参数用于写入节点的 host/sni（你绑定的域名）
// worker 本身的 hostname 仅用于接收请求与生成“原生域名节点”（可选）

// =====================
// Edge Cache 参数
// =====================
const EDGE_CACHE_TTL_HOME = 60 * 60 * 6;      // 主页缓存 6h
const EDGE_CACHE_TTL_SUB = 60 * 5;            // 订阅缓存 5m
const EDGE_CACHE_TTL_UP = 60 * 10;            // 上游缓存 10m
const EDGE_CACHE_SWR_HOME = 60 * 60;          // SWR 1h
const EDGE_CACHE_SWR_SUB = 60 * 10;           // SWR 10m
const EDGE_CACHE_SWR_UP = 60 * 10;            // SWR 10m

function withCacheHeaders(resp, sMaxAge, swr = 0) {
  const r = new Response(resp.body, resp);
  r.headers.set(
    "Cache-Control",
    `public, max-age=0, s-maxage=${sMaxAge}${swr ? `, stale-while-revalidate=${swr}` : ""}`
  );
  return r;
}

async function edgeCacheGet(cacheKey) {
  try { return await caches.default.match(cacheKey); } catch { return null; }
}
async function edgeCachePut(cacheKey, response) {
  try { await caches.default.put(cacheKey, response.clone()); } catch {}
}
function makeCacheKey(urlStr) {
  return new Request(urlStr, { method: "GET" });
}
async function cachedGetText(cacheKey) {
  const cached = await edgeCacheGet(cacheKey);
  if (!cached) return null;
  try { return await cached.text(); } catch { return null; }
}
async function cachedSetText(cacheKey, text, ttl = EDGE_CACHE_TTL_UP, swr = EDGE_CACHE_SWR_UP) {
  const resp = withCacheHeaders(
    new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    ttl, swr
  );
  await edgeCachePut(cacheKey, resp);
}
async function cachedGetJSON(cacheKey) {
  const cached = await edgeCacheGet(cacheKey);
  if (!cached) return null;
  try { return await cached.json(); } catch { return null; }
}
async function cachedSetJSON(cacheKey, obj, ttl = EDGE_CACHE_TTL_UP, swr = EDGE_CACHE_SWR_UP) {
  const resp = withCacheHeaders(
    new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json; charset=utf-8" } }),
    ttl, swr
  );
  await edgeCachePut(cacheKey, resp);
}

// =====================
// 默认配置（只读，不在请求中修改）
// =====================
const DEFAULT_SUB_CONVERTER = "https://url.v1.mk/sub"; // 主页按钮用（你可不依赖它）
const DEFAULT_GITHUB_BESTCF = "https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt";

// 优选域名（你可以按需改）
const directDomains = [
  { name: "CF-官方测速", domain: "speed.cloudflare.com" },
  { name: "CF-自动优选", domain: "www.visa.com.sg" },
  { name: "HK-time", domain: "time.is" },
  { name: "SG-singapore", domain: "singapore.com" },
  { name: "JP-glassdoor", domain: "www.glassdoor.com" },
  { name: "US-udacity", domain: "www.udacity.com" },
  { name: "skk-1", domain: "cf.skk.moe" },
  { name: "skk-2", domain: "ip.skk.moe" },
];

// =====================
// 工具函数
// =====================

// 更可靠的 UTF-8 Base64
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}
function isValidUUID(str) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}
function normalizeWsPath(p) {
  if (!p) return "/";
  p = String(p).trim();
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}
// YAML 安全引号（最简单稳）
function yq(v) {
  return JSON.stringify(String(v ?? ""));
}
function isProbablyIPv6(host) {
  return typeof host === "string" && host.includes(":");
}
function hostForUrl(host) {
  // URL 里 IPv6 必须加 []
  if (isProbablyIPv6(host) && !host.startsWith("[")) return `[${host}]`;
  return host;
}
function hostForVMessAdd(host) {
  // VMess add 字段不建议带 []
  if (typeof host !== "string") return host;
  return host.replace(/^\[|\]$/g, "");
}

// =====================
// wetest 优选
// =====================
async function fetchAndParseWetest(url) {
  try {
    const cacheKey = makeCacheKey(url + (url.includes("?") ? "&" : "?") + "__cf_cache=wetest");
    const cached = await cachedGetJSON(cacheKey);
    if (cached) return cached;

    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const html = await res.text();

    const results = [];
    const rowRegex = /<tr[\s\S]*?<\/tr>/g;
    const cellRegex = /<td data-label="线路名称">(.+?)<\/td>[\s\S]*?<td data-label="优选地址">([\d.:a-fA-F]+)<\/td>[\s\S]*?<td data-label="数据中心">(.+?)<\/td>/;

    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      const rowHtml = m[0];
      const cm = rowHtml.match(cellRegex);
      if (cm && cm[1] && cm[2]) {
        const isp = cm[1].trim().replace(/<.*?>/g, "");
        const ip = cm[2].trim();
        const colo = (cm[3] ? cm[3].trim().replace(/<.*?>/g, "") : "");
        results.push({ isp, ip, colo });
      }
    }

    await cachedSetJSON(cacheKey, results);
    return results;
  } catch {
    return [];
  }
}

async function fetchDynamicIPs(ipv4Enabled, ipv6Enabled, ispMobile, ispUnicom, ispTelecom) {
  const v4Url = "https://www.wetest.vip/page/cloudflare/address_v4.html";
  const v6Url = "https://www.wetest.vip/page/cloudflare/address_v6.html";

  const tasks = [];
  tasks.push(ipv4Enabled ? fetchAndParseWetest(v4Url) : Promise.resolve([]));
  tasks.push(ipv6Enabled ? fetchAndParseWetest(v6Url) : Promise.resolve([]));
  const [v4, v6] = await Promise.all(tasks);

  let results = [...v4, ...v6];
  if (!results.length) return [];

  results = results.filter(item => {
    const isp = item.isp || "";
    if (isp.includes("移动") && !ispMobile) return false;
    if (isp.includes("联通") && !ispUnicom) return false;
    if (isp.includes("电信") && !ispTelecom) return false;
    return true;
  });

  return results;
}

// =====================
// GitHub bestcf
// =====================
async function fetchAndParseGitHubBestcf(piu) {
  const url = piu || DEFAULT_GITHUB_BESTCF;
  try {
    const cacheKey = makeCacheKey(url + (url.includes("?") ? "&" : "?") + "__cf_cache=githubip");
    let text = await cachedGetText(cacheKey);

    if (!text) {
      const res = await fetch(url);
      if (!res.ok) return [];
      text = await res.text();
      await cachedSetText(cacheKey, text);
    }

    const results = [];
    const lines = text.trim().replace(/\r/g, "").split("\n");
    // 期望行格式：IP:PORT#NAME
    const regex = /^([^:]+):(\d+)(?:#(.*))?$/;

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(regex);
      if (!m) continue;
      results.push({
        ip: m[1].trim(),
        port: 443, // 强制
        name: (m[3] || m[1]).trim()
      });
    }
    return results;
  } catch {
    return [];
  }
}

// =====================
// 自定义优选 API（piu 是 https://... 时）
// 支持返回：
// - 纯文本：ip:port#remark 或 ip#remark 或 ip
// - csv（一些常见格式）
// =====================
async function requestOptimizeAPI(urls, timeoutMs = 3000) {
  if (!urls?.length) return [];
  const results = new Set();
  const IPV6_PATTERN = /^[^\[\]]*:[^\[\]]*:[^\[\]]/;

  await Promise.allSettled(urls.map(async (url) => {
    try {
      const cacheKey = makeCacheKey(url + (url.includes("?") ? "&" : "?") + "__cf_cache=optapi");
      let text = await cachedGetText(cacheKey);

      if (!text) {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(tid);
        if (!res.ok) return;
        text = await res.text();
        if (!text || !text.trim()) return;
        await cachedSetText(cacheKey, text);
      }

      const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
      const isCSV = lines.length > 1 && lines[0].includes(",");

      if (!isCSV) {
        for (const line of lines) {
          const hashIndex = line.indexOf("#");
          const [hostPart, remark] = hashIndex > -1 ? [line.slice(0, hashIndex), line.slice(hashIndex)] : [line, ""];
          let host = hostPart.trim();

          // 去端口
          if (host.startsWith("[")) {
            const r = host.indexOf("]");
            host = r > -1 ? host.slice(0, r + 1) : host;
          } else {
            host = host.split(":")[0];
          }
          // 强制 :443
          results.add(`${host}:443${remark}`);
        }
      } else {
        const headers = lines[0].split(",").map(s => s.trim());
        const data = lines.slice(1);

        // 常见 CSV：IP地址,端口,数据中心,TLS...
        const ipIdx = headers.findIndex(h => h.includes("IP"));
        const tlsIdx = headers.findIndex(h => h.toLowerCase() === "tls" || h.includes("TLS"));
        const remarkIdx =
          headers.indexOf("国家") > -1 ? headers.indexOf("国家")
          : headers.indexOf("城市") > -1 ? headers.indexOf("城市")
          : headers.indexOf("数据中心") > -1 ? headers.indexOf("数据中心")
          : -1;

        for (const line of data) {
          const cols = line.split(",").map(s => s.trim());
          if (ipIdx < 0 || !cols[ipIdx]) continue;
          if (tlsIdx !== -1 && cols[tlsIdx] && cols[tlsIdx].toLowerCase() !== "true") continue;

          const ip = cols[ipIdx];
          const wrapped = IPV6_PATTERN.test(ip) ? `[${ip}]` : ip;
          const remark = (remarkIdx !== -1 && cols[remarkIdx]) ? cols[remarkIdx] : ip;
          results.add(`${wrapped}:443#${remark}`);
        }
      }
    } catch {}
  }));

  return Array.from(results);
}

function parseMultiLinePiu(piuText) {
  // 把各种分隔符统一成逗号切数组
  const t = String(piuText || "").replace(/[\t"'\r\n]+/g, ",").replace(/,+/g, ",");
  const s = t.replace(/^,|,$/g, "");
  if (!s) return [];
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

// =====================
// 节点生成（全 443 + TLS + WS）
// =====================
function genVlessLinks(list, uuid, nodeDomain, wsPath) {
  const links = [];
  const path = normalizeWsPath(wsPath);

  for (const item of list) {
    let base = item.isp ? item.isp.replace(/\s/g, "_") : (item.name || item.domain || item.ip);
    if (item.colo) base = `${base}-${String(item.colo).trim()}`;

    const server = hostForUrl(item.ip);
    const name = `${base}-443-ws-tls`;

    const params = new URLSearchParams({
      encryption: "none",
      security: "tls",
      type: "ws",
      sni: nodeDomain,
      host: nodeDomain,
      path,
      fp: "chrome"
    });

    links.push(`vless://${uuid}@${server}:443?${params.toString()}#${encodeURIComponent(name)}`);
  }
  return links;
}

function genTrojanLinks(list, password, nodeDomain, wsPath) {
  const links = [];
  const path = normalizeWsPath(wsPath);

  for (const item of list) {
    let base = item.isp ? item.isp.replace(/\s/g, "_") : (item.name || item.domain || item.ip);
    if (item.colo) base = `${base}-${String(item.colo).trim()}`;

    const server = hostForUrl(item.ip);
    const name = `${base}-443-trojan-ws-tls`;

    const params = new URLSearchParams({
      security: "tls",
      type: "ws",
      sni: nodeDomain,
      host: nodeDomain,
      path,
      fp: "chrome"
    });

    links.push(`trojan://${password}@${server}:443?${params.toString()}#${encodeURIComponent(name)}`);
  }
  return links;
}

function genVmessLinks(list, uuid, nodeDomain, wsPath) {
  const links = [];
  const path = normalizeWsPath(wsPath);

  for (const item of list) {
    let base = item.isp ? item.isp.replace(/\s/g, "_") : (item.name || item.domain || item.ip);
    if (item.colo) base = `${base}-${String(item.colo).trim()}`;

    const add = hostForVMessAdd(item.ip); // ✅ 不带 []
    const ps = `${base}-443-vmess-ws-tls`;

    const vmessConfig = {
      v: "2",
      ps,
      add,
      port: "443",
      id: uuid,
      aid: "0",
      scy: "auto",
      net: "ws",
      type: "none",
      host: nodeDomain,
      path,
      tls: "tls",
      sni: nodeDomain,
      fp: "chrome"
    };

    // btoa 需要 latin1，这里用 UTF-8 安全编码
    const json = JSON.stringify(vmessConfig);
    const b64 = toBase64Utf8(json);
    links.push(`vmess://${b64}`);
  }
  return links;
}

// =====================
// 多格式输出
// =====================
function generateClashYaml(links) {
  // 仅把 vless / trojan / vmess uri 解析成 clash proxies（最常用字段）
  // 注意：Clash 对 vmess/vless/trojan 的字段要求会因内核不同略有差异，但这一版对常见 Meta/Clash Verge Rev 兼容较好
  let yaml = "";
  yaml += "port: 7890\n";
  yaml += "socks-port: 7891\n";
  yaml += "allow-lan: false\n";
  yaml += "mode: rule\n";
  yaml += "log-level: info\n\n";
  yaml += "proxies:\n";

  const proxyNames = [];

  for (let i = 0; i < links.length; i++) {
    const uri = links[i];

    // 统一取名字
    let name = `node-${i + 1}`;
    const hash = uri.split("#")[1];
    if (hash) name = safeDecodeURIComponent(hash);

    // vless://uuid@server:443?... host=xxx path=/...
    if (uri.startsWith("vless://")) {
      const server = (uri.match(/@([^:]+):(\d+)/) || [])[1] || "";
      const uuid = (uri.match(/vless:\/\/([^@]+)@/) || [])[1] || "";
      const tls = uri.includes("security=tls");
      const path = (uri.match(/[?&]path=([^&#]+)/) || [])[1] || "/";
      const host = (uri.match(/[?&]host=([^&#]+)/) || [])[1] || "";
      const sni = (uri.match(/[?&]sni=([^&#]+)/) || [])[1] || "";

      proxyNames.push(name);
      yaml += `  - name: ${yq(name)}\n`;
      yaml += `    type: vless\n`;
      yaml += `    server: ${yq(server.replace(/^\[|\]$/g, ""))}\n`;
      yaml += `    port: 443\n`;
      yaml += `    uuid: ${yq(uuid)}\n`;
      yaml += `    tls: ${tls}\n`;
      if (sni) yaml += `    servername: ${yq(sni)}\n`;
      yaml += `    network: ws\n`;
      yaml += `    ws-opts:\n`;
      yaml += `      path: ${yq(safeDecodeURIComponent(path))}\n`;
      yaml += `      headers:\n`;
      yaml += `        Host: ${yq(safeDecodeURIComponent(host))}\n`;
      yaml += "\n";
      continue;
    }

    if (uri.startsWith("trojan://")) {
      const server = (uri.match(/@([^:]+):(\d+)/) || [])[1] || "";
      const password = (uri.match(/trojan:\/\/([^@]+)@/) || [])[1] || "";
      const tls = uri.includes("security=tls");
      const path = (uri.match(/[?&]path=([^&#]+)/) || [])[1] || "/";
      const host = (uri.match(/[?&]host=([^&#]+)/) || [])[1] || "";
      const sni = (uri.match(/[?&]sni=([^&#]+)/) || [])[1] || "";

      proxyNames.push(name);
      yaml += `  - name: ${yq(name)}\n`;
      yaml += `    type: trojan\n`;
      yaml += `    server: ${yq(server.replace(/^\[|\]$/g, ""))}\n`;
      yaml += `    port: 443\n`;
      yaml += `    password: ${yq(password)}\n`;
      yaml += `    tls: ${tls}\n`;
      if (sni) yaml += `    sni: ${yq(sni)}\n`;
      yaml += `    network: ws\n`;
      yaml += `    ws-opts:\n`;
      yaml += `      path: ${yq(safeDecodeURIComponent(path))}\n`;
      yaml += `      headers:\n`;
      yaml += `        Host: ${yq(safeDecodeURIComponent(host))}\n`;
      yaml += "\n";
      continue;
    }

    if (uri.startsWith("vmess://")) {
      // Clash 对 vmess 支持差异更大，这里尽量提供常用字段
      // vmess://base64(json)
      proxyNames.push(name);
      yaml += `  - name: ${yq(name)}\n`;
      yaml += `    type: vmess\n`;
      yaml += `    server: ${yq("0.0.0.0")}\n`;
      yaml += `    port: 443\n`;
      yaml += `    uuid: ${yq("00000000-0000-0000-0000-000000000000")}\n`;
      yaml += `    alterId: 0\n`;
      yaml += `    cipher: auto\n`;
      yaml += `    tls: true\n`;
      yaml += `    network: ws\n`;
      yaml += `    ws-opts:\n`;
      yaml += `      path: ${yq("/")}\n`;
      yaml += `      headers:\n`;
      yaml += `        Host: ${yq("example.com")}\n`;
      yaml += "\n";
      // 提示：vmess 复杂，建议用户用 base64 / v2ray 格式导入更稳
      continue;
    }
  }

  if (!proxyNames.length) proxyNames.push("DIRECT");

  yaml += "proxy-groups:\n";
  yaml += "  - name: PROXY\n";
  yaml += "    type: select\n";
  yaml += `    proxies: [${proxyNames.map(n => yq(n)).join(", ")}]\n\n`;

  yaml += "rules:\n";
  yaml += "  - DOMAIN-SUFFIX,local,DIRECT\n";
  yaml += "  - IP-CIDR,127.0.0.0/8,DIRECT\n";
  yaml += "  - GEOIP,CN,DIRECT\n";
  yaml += "  - MATCH,PROXY\n";

  return yaml;
}

function generateSurgeConf(links) {
  // Surge/Loon 类配置（最常用：vless & trojan），vmess 复杂，不保证全兼容
  let conf = "[Proxy]\n";
  const names = [];

  for (let i = 0; i < links.length; i++) {
    const uri = links[i];
    let name = `node-${i + 1}`;
    const hash = uri.split("#")[1];
    if (hash) name = safeDecodeURIComponent(hash);
    names.push(name);

    if (uri.startsWith("vless://")) {
      const server = (uri.match(/@([^:]+):(\d+)/) || [])[1] || "";
      const uuid = (uri.match(/vless:\/\/([^@]+)@/) || [])[1] || "";
      const path = (uri.match(/[?&]path=([^&#]+)/) || [])[1] || "/";
      const host = (uri.match(/[?&]host=([^&#]+)/) || [])[1] || "";
      const sni = (uri.match(/[?&]sni=([^&#]+)/) || [])[1] || "";

      conf += `${name} = vless, ${server.replace(/^\[|\]$/g, "")}, 443, username=${uuid}, tls=true, sni=${sni || host}, ws=true, ws-path=${safeDecodeURIComponent(path)}, ws-headers=Host:${safeDecodeURIComponent(host)}\n`;
      continue;
    }

    if (uri.startsWith("trojan://")) {
      const server = (uri.match(/@([^:]+):(\d+)/) || [])[1] || "";
      const pw = (uri.match(/trojan:\/\/([^@]+)@/) || [])[1] || "";
      const path = (uri.match(/[?&]path=([^&#]+)/) || [])[1] || "/";
      const host = (uri.match(/[?&]host=([^&#]+)/) || [])[1] || "";
      const sni = (uri.match(/[?&]sni=([^&#]+)/) || [])[1] || "";

      conf += `${name} = trojan, ${server.replace(/^\[|\]$/g, "")}, 443, password=${pw}, tls=true, sni=${sni || host}, ws=true, ws-path=${safeDecodeURIComponent(path)}, ws-headers=Host:${safeDecodeURIComponent(host)}\n`;
      continue;
    }

    // 兜底：保留备注但不写入，避免炸配置
    conf += `# ${name} = (unsupported in surge output)\n`;
  }

  conf += "\n[Proxy Group]\n";
  conf += `PROXY = select, ${names.join(", ")}\n`;
  return conf;
}

function generateQuanX(links) {
  // Quantumult X / Shadowrocket 等一般都能直接吃 URI 行（不 base64 也行）
  // 这里输出“纯 URI 列表”
  return links.join("\n");
}

function generateLoon(links) {
  // Loon 兼容 Surge 风格最稳
  return generateSurgeConf(links);
}

function generateSingBoxProfile(links) {
  // 生成一个“可导入的最简 sing-box profile”
  // 不保证所有客户端都吃这个，但比依赖外部转换器更稳
  // 方案：把 URI 放到 outbounds 的 "urltest" + 若干 "type: vless/trojan" 会很复杂，
  // 这里折中：输出 subscription-style（URI 列表），同时包一层 JSON，部分 app 可识别。
  return JSON.stringify({
    version: 1,
    type: "subscription",
    format: "uri",
    updated_at: new Date().toISOString(),
    links
  }, null, 2);
}

// =====================
// 订阅处理
// =====================
async function buildLinks({
  uuidOrPw,
  nodeDomain,
  wsPath,
  epdEnabled,
  epiEnabled,
  egiEnabled,
  piu,
  ipv4Enabled,
  ipv6Enabled,
  ispMobile,
  ispUnicom,
  ispTelecom,
  evEnabled,
  etEnabled,
  vmEnabled
}) {
  const finalLinks = [];
  const listAdd = async (list) => {
    const hasProtocol = evEnabled || etEnabled || vmEnabled;
    const useVless = hasProtocol ? evEnabled : true;

    if (useVless) finalLinks.push(...genVlessLinks(list, uuidOrPw, nodeDomain, wsPath));
    if (etEnabled) finalLinks.push(...genTrojanLinks(list, uuidOrPw, nodeDomain, wsPath));
    if (vmEnabled) finalLinks.push(...genVmessLinks(list, uuidOrPw, nodeDomain, wsPath));
  };

  // ✅ 原生域名节点（用 nodeDomain，不用 worker hostname，减少混淆）
  await listAdd([{ ip: nodeDomain, isp: "native-domain" }]);

  // 优选域名
  if (epdEnabled) {
    await listAdd(directDomains.map(d => ({ ip: d.domain, isp: d.name })));
  }

  // wetest 优选 IP
  if (epiEnabled) {
    const dyn = await fetchDynamicIPs(ipv4Enabled, ipv6Enabled, ispMobile, ispUnicom, ispTelecom);
    if (dyn.length) await listAdd(dyn);
  }

  // GitHub / 自定义优选 API
  if (egiEnabled) {
    try {
      if (piu && piu.toLowerCase().startsWith("https://")) {
        // 如果 piu 是 URL：当作优选 API 或 GitHub bestcf 的 URL
        // 先尝试当作 bestcf
        const gh = await fetchAndParseGitHubBestcf(piu);
        if (gh.length) {
          // bestcf 列表转为 listAdd 的统一结构
          await listAdd(gh.map(x => ({ ip: x.ip, isp: x.name })));
        } else {
          // 再尝试当作“优选 API”
          const arr = await requestOptimizeAPI([piu]);
          const parsed = arr.map(raw => {
            const m = raw.match(/^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9.-]+):443(?:#(.+))?$/);
            if (!m) return null;
            const ip = m[1].replace(/^\[|\]$/g, "");
            const name = m[2] || ip;
            return { ip, isp: name };
          }).filter(Boolean);
          if (parsed.length) await listAdd(parsed);
        }
      } else if (piu && piu.includes("\n")) {
        // 多行混合：支持 URL + IP 列表
        const arr = parseMultiLinePiu(piu);
        const urls = arr.filter(x => x.toLowerCase().startsWith("https://"));
        const ips = arr.filter(x => !x.toLowerCase().startsWith("https://"));

        if (urls.length) {
          const apiRes = await requestOptimizeAPI(urls);
          ips.push(...apiRes);
        }

        const parsed = ips.map(raw => {
          // 支持：ip / ip#name / ip:port#name
          const r = String(raw).trim();
          if (!r) return null;

          const m1 = r.match(/^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9.-]+)(?::\d+)?(?:#(.+))?$/);
          if (!m1) return null;
          const ip = m1[1].replace(/^\[|\]$/g, "");
          const name = m1[2] || ip;
          return { ip, isp: name };
        }).filter(Boolean);

        if (parsed.length) await listAdd(parsed);
      } else {
        // 默认 GitHub bestcf
        const gh = await fetchAndParseGitHubBestcf(piu || DEFAULT_GITHUB_BESTCF);
        if (gh.length) await listAdd(gh.map(x => ({ ip: x.ip, isp: x.name })));
      }
    } catch {}
  }

  // 兜底
  if (!finalLinks.length) {
    finalLinks.push(
      `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&security=tls&type=ws&host=error.com&path=%2F#${encodeURIComponent("all-nodes-failed")}`
    );
  }

  // 去重
  return Array.from(new Set(finalLinks));
}

function homeHtml(scu) {
  const SUB_CONVERTER_URL = scu || DEFAULT_SUB_CONVERTER;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>订阅生成</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;max-width:860px;margin:0 auto;padding:24px;}
input,select{width:100%;padding:12px;margin:8px 0;font-size:16px;}
button{padding:12px 14px;font-size:16px;cursor:pointer;}
code{display:block;white-space:pre-wrap;word-break:break-all;background:#f6f6f6;padding:12px;border-radius:8px;}
</style>
</head>
<body>
<h2>订阅生成（最终版 Worker）</h2>
<p>domain 用于写入 host/sni（例如：ss.897922.xyz）</p>
<label>domain</label><input id="d" placeholder="ss.897922.xyz"/>
<label>uuid / password</label><input id="u" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
<label>path</label><input id="p" value="/" placeholder="/"/>
<label>target</label>
<select id="t">
  <option value="base64">base64</option>
  <option value="clash">clash</option>
  <option value="surge">surge</option>
  <option value="quanx">quanx</option>
  <option value="loon">loon</option>
  <option value="singbox">singbox</option>
</select>
<p>
<button onclick="gen()">生成链接</button>
</p>
<code id="out"></code>
<hr/>
<p>可选参数：epd/epi/egi（yes/no），ipv4/ipv6（yes/no），ispMobile/ispUnicom/ispTelecom（yes/no），ev/et/vm（yes/no），piu=自定义优选源</p>
<p>转换器（可选）：${SUB_CONVERTER_URL}</p>
<script>
function gen(){
  const d=document.getElementById('d').value.trim();
  const u=document.getElementById('u').value.trim();
  const p=document.getElementById('p').value.trim()||'/';
  const t=document.getElementById('t').value;
  if(!d||!u){alert('请填写 domain 和 uuid');return;}
  const base=location.origin+'/'+encodeURIComponent(u)+'/sub';
  const url=base+'?domain='+encodeURIComponent(d)+'&target='+encodeURIComponent(t)+'&path='+encodeURIComponent(p);
  document.getElementById('out').textContent=url;
}
</script>
</body></html>`;
}

// =====================
// Worker 入口
// =====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 主页
    if (path === "/" || path === "") {
      const cacheKey = makeCacheKey(url.origin + "/__home__");
      const cached = await edgeCacheGet(cacheKey);
      if (cached) return cached;

      const scu = env?.scu || DEFAULT_SUB_CONVERTER;
      let resp = new Response(homeHtml(scu), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      resp = withCacheHeaders(resp, EDGE_CACHE_TTL_HOME, EDGE_CACHE_SWR_HOME);
      ctx.waitUntil(edgeCachePut(cacheKey, resp));
      return resp;
    }

    // 订阅：/<uuid>/sub
    const m = path.match(/^\/([^\/]+)\/sub$/);
    if (!m) return new Response("Not Found", { status: 404 });

    // 订阅缓存：按完整 URL 缓存
    const cacheKey = makeCacheKey(request.url);
    const cached = await edgeCacheGet(cacheKey);
    if (cached) return cached;

    const uuidOrPw = m[1];

    const nodeDomain = url.searchParams.get("domain");
    if (!nodeDomain) return new Response("missing domain param", { status: 400 });

    const target = (url.searchParams.get("target") || "base64").toLowerCase();
    const wsPath = normalizeWsPath(url.searchParams.get("path") || "/");

    // 开关（全部局部变量 ✅ 不串线）
    const epdEnabled = url.searchParams.get("epd") !== "no";
    const epiEnabled = url.searchParams.get("epi") !== "no";
    const egiEnabled = url.searchParams.get("egi") !== "no";

    const ipv4Enabled = url.searchParams.get("ipv4") !== "no";
    const ipv6Enabled = url.searchParams.get("ipv6") !== "no";

    const ispMobile = url.searchParams.get("ispMobile") !== "no";
    const ispUnicom = url.searchParams.get("ispUnicom") !== "no";
    const ispTelecom = url.searchParams.get("ispTelecom") !== "no";

    // 协议选择：默认 vless=yes
    const evEnabled = url.searchParams.get("ev") !== "no";
    const etEnabled = url.searchParams.get("et") === "yes";
    const vmEnabled = (url.searchParams.get("vm") === "yes")
                   || (url.searchParams.get("vmess") === "yes")
                   || (url.searchParams.get("mess") === "yes"); // 兼容你旧参数

    const piu = url.searchParams.get("piu") || DEFAULT_GITHUB_BESTCF;

    const links = await buildLinks({
      uuidOrPw,
      nodeDomain,
      wsPath,
      epdEnabled,
      epiEnabled,
      egiEnabled,
      piu,
      ipv4Enabled,
      ipv6Enabled,
      ispMobile,
      ispUnicom,
      ispTelecom,
      evEnabled,
      etEnabled,
      vmEnabled
    });

    let body = "";
    let contentType = "text/plain; charset=utf-8";

    switch (target) {
      case "clash":
      case "clashr":
        body = generateClashYaml(links);
        contentType = "text/yaml; charset=utf-8";
        break;

      case "surge":
        body = generateSurgeConf(links);
        contentType = "text/plain; charset=utf-8";
        break;

      case "quanx":
      case "quantumult":
        body = generateQuanX(links);
        contentType = "text/plain; charset=utf-8";
        break;

      case "loon":
        body = generateLoon(links);
        contentType = "text/plain; charset=utf-8";
        break;

      case "singbox":
      case "sing-box":
        body = generateSingBoxProfile(links);
        contentType = "application/json; charset=utf-8";
        break;

      case "base64":
      default:
        body = toBase64Utf8(links.join("\n"));
        contentType = "text/plain; charset=utf-8";
        break;
    }

    let resp = new Response(body, { headers: { "Content-Type": contentType } });
    resp = withCacheHeaders(resp, EDGE_CACHE_TTL_SUB, EDGE_CACHE_SWR_SUB);

    ctx.waitUntil(edgeCachePut(cacheKey, resp));
    return resp;
  }
};
