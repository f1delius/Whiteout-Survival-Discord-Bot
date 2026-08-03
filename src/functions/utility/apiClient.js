/**
 * Shared API client for game APIs
 * Centralizes gift-code signing and HTTP requests.
 */

const crypto = require('crypto');
const { getGameProxyAgent } = require('./proxySupport');
const { getDefaultGameType } = require('./gameRuntime');

const http = require('http');
const https = require('https');
const { API_CONFIG, getApiConfig } = require('./apiConfig');
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// Persistent agents for gift code API — reuses TCP+TLS connections across requests
const giftCodeHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 30000 });
const giftCodeHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 30000 });

function getDirectAgent(url, preferKeepAlive = false) {
    const isHttpsUrl = url.startsWith('https');
    if (preferKeepAlive) {
        return isHttpsUrl ? giftCodeHttpsAgent : giftCodeHttpAgent;
    }
    return isHttpsUrl ? httpsAgent : httpAgent;
}

function getAgentForGameRequest(url, preferKeepAlive = false) {
    return getGameProxyAgent(url) || getDirectAgent(url, preferKeepAlive);
}

// Browser profiles for header randomization
const BROWSER_PROFILES = [
    {
        browser: 'Chrome',
        versions: [124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135],
        platforms: [
            { os: 'Windows NT 10.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Windows NT 11.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Macintosh; Intel Mac OS X 10_15_7', secPlatform: '"macOS"' },
            { os: 'X11; Linux x86_64', secPlatform: '"Linux"' }
        ],
        buildSecUa: (ver) => `"Not:A-Brand";v="99", "Google Chrome";v="${ver}", "Chromium";v="${ver}"`
    },
    {
        browser: 'Brave',
        versions: [132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145],
        platforms: [
            { os: 'Windows NT 10.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Windows NT 11.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Macintosh; Intel Mac OS X 10_15_7', secPlatform: '"macOS"' }
        ],
        buildSecUa: (ver) => `"Not:A-Brand";v="99", "Brave";v="${ver}", "Chromium";v="${ver}"`
    },
    {
        browser: 'Edge',
        versions: [124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135],
        platforms: [
            { os: 'Windows NT 10.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Windows NT 11.0; Win64; x64', secPlatform: '"Windows"' },
            { os: 'Macintosh; Intel Mac OS X 10_15_7', secPlatform: '"macOS"' }
        ],
        buildSecUa: (ver) => `"Not A(B)rand";v="8", "Chromium";v="${ver}", "Microsoft Edge";v="${ver}"`
    }
];

/**
 * Generates randomized browser-like headers to avoid server-side bot detection.
 * Rotates browser type, version, OS, and related sec-* headers on every call.
 * @param {string} [origin] - Origin URL override. Defaults to API_CONFIG.ORIGIN.
 * @returns {Object} Headers object
 */
function generateBrowserHeaders(origin = API_CONFIG.ORIGIN) {
    const profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
    const version = profile.versions[Math.floor(Math.random() * profile.versions.length)];
    const platform = profile.platforms[Math.floor(Math.random() * profile.platforms.length)];

    return {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.7',
        'Origin': origin,
        'Referer': `${origin}/`,
        'User-Agent': `Mozilla/5.0 (${platform.os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
        'sec-ch-ua': profile.buildSecUa(version),
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': platform.secPlatform,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'sec-gpc': '1',
    };
}

/**
 * Resolves a game API configuration.
 */
function resolveApiConfig(gameTypeOrConfig = null) {
    if (gameTypeOrConfig && typeof gameTypeOrConfig === 'object' && gameTypeOrConfig.SECRET) {
        return gameTypeOrConfig;
    }
    if (typeof gameTypeOrConfig === 'string') {
        return getApiConfig(gameTypeOrConfig);
    }
    return getApiConfig(getDefaultGameType());
}

/**
 * Builds MD5 signed form data with alphabetically sorted keys
 * Used for gift-code redemption calls.
 * @param {Object} data - Key-value pairs to encode
 * @returns {string} Signed form data string
 */
function encodeData(data, gameTypeOrConfig = null) {
    const apiConfig = resolveApiConfig(gameTypeOrConfig);
    const sortedKeys = Object.keys(data).sort();
    const encodedData = sortedKeys
        .map(key => `${key}=${typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key]}`)
        .join('&');

    const sign = crypto.createHash('md5')
        .update(encodedData + apiConfig.SECRET)
        .digest('hex');

    return `sign=${sign}&${encodedData}`;
}

/**
 * Makes a POST request using native http/https (for gift code API)
 * Includes Origin header required by the gift code endpoint
 * @param {string} url - API endpoint URL
 * @param {Object} payload - Data to encode and send
 * @param {string} label - Label for error logging
 * @param {string|Object} [gameTypeOrConfig] - Game type or resolved API configuration
 * @returns {Promise<{ok: boolean, status: number, data: Object, raw: string, rateLimit: Object}>} Response
 */
async function nativePost(url, payload, label, gameTypeOrConfig = null) {
    const apiConfig = resolveApiConfig(gameTypeOrConfig);
    return new Promise((resolve, reject) => {
        const postData = encodeData(payload, apiConfig);

        const urlObject = new URL(url);
        const browserHeaders = generateBrowserHeaders(apiConfig.ORIGIN);
        const isHttps = urlObject.protocol === 'https:';
        const agent = getAgentForGameRequest(url, true);
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            ...browserHeaders
        };

        const options = {
            hostname: urlObject.hostname,
            port: urlObject.port || (isHttps ? 443 : 80),
            path: urlObject.pathname,
            method: 'POST',
            agent,
            headers
        };

        const client = urlObject.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
            let raw = '';

            // Capture rate limit headers for adaptive throttling
            const rateLimit = {
                limit: res.headers['x-ratelimit-limit'] ? parseInt(res.headers['x-ratelimit-limit'], 10) : undefined,
                remaining: res.headers['x-ratelimit-remaining'] ? parseInt(res.headers['x-ratelimit-remaining'], 10) : undefined
            };

            res.on('data', (chunk) => {
                raw += chunk;
            });

            res.on('end', () => {
                let data;
                try {
                    data = JSON.parse(raw);
                } catch (error) {
                    data = raw;
                }

                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    data,
                    raw,
                    rateLimit
                });
            });
        });

        // Destroy the socket and reject if the server hangs for more than 15 seconds
        req.setTimeout(15000, () => {
            req.destroy();
            const msg = `${label} request timed out after 15 seconds`;
            console.warn(`[timeout] ${msg} — ${url}`);
            reject(new Error(msg));
        });

        req.on('error', (error) => {
            console.error(`${label} request failed: ${error.message} — ${url}`);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

module.exports = {
    encodeData,
    nativePost
};
