const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const agentCache = new Map();
let cachedProxyUrl;
let proxyWasLogged = false;

function readCliProxyUrl(argv = process.argv.slice(2)) {
    let rawProxyUrl = null;
    const inlineArg = argv.find(arg => /^--proxy=/i.test(arg));
    if (inlineArg) {
        rawProxyUrl = inlineArg.slice(inlineArg.indexOf('=') + 1).trim();
    } else {
        const proxyFlagIndex = argv.indexOf('--proxy');
        if (proxyFlagIndex !== -1) {
            const nextArg = argv[proxyFlagIndex + 1];
            rawProxyUrl = (nextArg && !nextArg.startsWith('--')) ? nextArg : 'http://localhost:18080';
        }
    }

    if (!rawProxyUrl) {
        rawProxyUrl = process.env.WOS_GAME_PROXY_URL
            || process.env.npm_config_proxy
            || process.env.npm_config_https_proxy
            || process.env.HTTP_PROXY
            || process.env.HTTPS_PROXY
            || null;
    }

    if (!rawProxyUrl) return null;

    try {
        const parsed = new URL(rawProxyUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Proxy URL must use http or https');
        }
        return rawProxyUrl;
    } catch (error) {
        console.error(`[proxy] Invalid proxy URL "${rawProxyUrl}": ${error.message}`);
        return null;
    }
}

function getConfiguredProxyUrl() {
    if (cachedProxyUrl !== undefined) return cachedProxyUrl;
    cachedProxyUrl = readCliProxyUrl();
    return cachedProxyUrl;
}

function isCenturyGameUrl(input) {
    try {
        const targetUrl = input instanceof URL ? input : new URL(input);
        return targetUrl.hostname.toLowerCase().endsWith('.centurygame.com');
    } catch {
        return false;
    }
}

function getGameProxyAgent(url) {
    if (!isCenturyGameUrl(url)) return null;

    const proxyUrl = getConfiguredProxyUrl();
    if (!proxyUrl) return null;

    const targetUrl = url instanceof URL ? url : new URL(url);
    const isSecureTarget = targetUrl.protocol === 'https:';
    const cacheKey = `${isSecureTarget ? 'https' : 'http'}:${proxyUrl}`;

    if (!agentCache.has(cacheKey)) {
        agentCache.set(
            cacheKey,
            isSecureTarget ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl)
        );
    }

    if (!proxyWasLogged) {
        console.log(`[proxy] Century Games API traffic routed through: ${proxyUrl}`);
        proxyWasLogged = true;
    }

    return agentCache.get(cacheKey);
}

module.exports = {
    getGameProxyAgent,
    isCenturyGameUrl
};
