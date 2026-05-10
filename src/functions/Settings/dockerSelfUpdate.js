const fs = require('fs');
const http = require('http');

const DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_CONTAINER = 'woslandjs';
const DEFAULT_IMAGE = 'ghcr.io/whiteout-project/whiteout-survival-discord-bot';
const DEFAULT_TAG = 'latest';
const HELPER_DELAY_MS = 2500;

function isDockerEngineUpdateDisabled() {
    return /^(1|true|yes|file)$/i.test(process.env.WOS_DOCKER_UPDATE_MODE || '')
        || /^(1|true|yes)$/i.test(process.env.WOS_DISABLE_DOCKER_ENGINE_UPDATE || '');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function hasDockerSocket() {
    if (isDockerEngineUpdateDisabled()) return false;
    return !!(global.isDocker || process.env.DOCKER_CONTAINER) && fs.existsSync(DOCKER_SOCKET);
}

function normalizeImageRef(image = DEFAULT_IMAGE, defaultTag = DEFAULT_TAG) {
    if (image.includes('@')) {
        return { image, tag: null, ref: image };
    }

    const lastSlash = image.lastIndexOf('/');
    const lastColon = image.lastIndexOf(':');
    if (lastColon > lastSlash) {
        const baseImage = image.slice(0, lastColon);
        const tag = image.slice(lastColon + 1);
        return { image: baseImage, tag, ref: image };
    }

    return { image, tag: defaultTag, ref: `${image}:${defaultTag}` };
}

function dockerApi(method, apiPath, body = null, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            socketPath: DOCKER_SOCKET,
            path: apiPath,
            method,
            headers: {},
            timeout: timeoutMs
        };

        let bodyStr = null;
        if (body) {
            bodyStr = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let data;
                try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ statusCode: res.statusCode, data });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Docker API timeout: ${method} ${apiPath}`));
        });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

async function pullDockerImage(imageRef) {
    const normalized = normalizeImageRef(imageRef);
    const encodedImage = encodeURIComponent(normalized.image);
    const tagPart = normalized.tag ? `&tag=${encodeURIComponent(normalized.tag)}` : '';
    const { statusCode, data } = await dockerApi(
        'POST',
        `/images/create?fromImage=${encodedImage}${tagPart}`,
        null,
        { timeoutMs: 120000 }
    );

    if (statusCode !== 200) {
        throw new Error(`Image pull failed with HTTP ${statusCode}: ${JSON.stringify(data)}`);
    }
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function replaceEnv(envList = [], replacements = {}) {
    const envMap = new Map();
    for (const entry of envList) {
        const eq = String(entry).indexOf('=');
        if (eq === -1) continue;
        envMap.set(entry.slice(0, eq), entry.slice(eq + 1));
    }

    for (const key of [
        'WOS_DOCKER_UPDATE_HELPER',
        'WOS_DOCKER_TARGET_CONTAINER',
        'WOS_DOCKER_TARGET_IMAGE',
        'WOS_DOCKER_REPLACEMENT_CONTAINER'
    ]) {
        envMap.delete(key);
    }

    for (const [key, value] of Object.entries(replacements)) {
        envMap.set(key, value);
    }

    return Array.from(envMap.entries()).map(([key, value]) => `${key}=${value}`);
}

function buildNetworkingConfig(containerInfo) {
    const endpoints = {};
    for (const [networkName, networkConfig] of Object.entries(containerInfo.NetworkSettings?.Networks || {})) {
        endpoints[networkName] = {
            IPAMConfig: networkConfig.IPAMConfig || undefined,
            Aliases: networkConfig.Aliases || undefined,
            Links: networkConfig.Links || undefined
        };
    }
    return { EndpointsConfig: endpoints };
}

function buildReplacementCreateBody(containerInfo, imageRef, targetContainer, targetImage) {
    const config = cloneJson(containerInfo.Config);
    const hostConfig = cloneJson(containerInfo.HostConfig);

    config.Image = imageRef;
    config.Env = replaceEnv(config.Env, {
        BOT_CONTAINER: targetContainer,
        BOT_IMAGE: targetImage,
        DOCKER_CONTAINER: '1'
    });

    return {
        ...config,
        Image: imageRef,
        HostConfig: hostConfig,
        NetworkingConfig: buildNetworkingConfig(containerInfo)
    };
}

async function inspectContainer(containerName) {
    return dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
}

async function inspectImage(imageRef) {
    return dockerApi('GET', `/images/${encodeURIComponent(imageRef)}/json`);
}

async function checkDockerUpdate({
    targetContainer = process.env.BOT_CONTAINER || DEFAULT_CONTAINER,
    targetImage = process.env.BOT_IMAGE || DEFAULT_IMAGE
} = {}) {
    const normalized = normalizeImageRef(targetImage);
    const { statusCode: cStatus, data: cData } = await inspectContainer(targetContainer);
    if (cStatus !== 200) throw new Error(`Cannot inspect container: HTTP ${cStatus}`);

    await pullDockerImage(normalized.ref);

    const { statusCode: iStatus, data: iData } = await inspectImage(normalized.ref);
    if (iStatus !== 200) throw new Error(`Cannot inspect image: HTTP ${iStatus}`);

    const currentVersion = cData.Config?.Labels?.['org.opencontainers.image.version'] || null;
    const latestVersion = iData.Config?.Labels?.['org.opencontainers.image.version'] || null;

    return {
        available: cData.Image !== null && iData.Id !== null && cData.Image !== iData.Id,
        current: currentVersion,
        latest: latestVersion || currentVersion
    };
}

async function createPreparedReplacement({ targetContainer, targetImage, imageRef }) {
    const replacementName = `${targetContainer}-next-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const { statusCode, data: containerInfo } = await inspectContainer(targetContainer);
    if (statusCode !== 200) {
        throw new Error(`Failed to inspect container: HTTP ${statusCode}`);
    }

    const createBody = buildReplacementCreateBody(containerInfo, imageRef, targetContainer, targetImage);
    const { statusCode: createStatus, data: createData } = await dockerApi(
        'POST',
        `/containers/create?name=${encodeURIComponent(replacementName)}`,
        createBody
    );

    if (createStatus !== 201) {
        throw new Error(`Failed to prepare replacement container: HTTP ${createStatus} - ${JSON.stringify(createData)}`);
    }

    return { replacementName, replacementId: createData.Id };
}

async function createAndStartHelper({ targetContainer, targetImage, imageRef, replacementName }) {
    const helperName = `${targetContainer}-updater-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const helperBody = {
        Image: imageRef,
        Cmd: ['node', 'starter.js', '--docker-update-helper'],
        WorkingDir: '/app',
        Env: [
            'DOCKER_CONTAINER=1',
            'WOS_DOCKER_UPDATE_HELPER=1',
            `WOS_DOCKER_TARGET_CONTAINER=${targetContainer}`,
            `WOS_DOCKER_TARGET_IMAGE=${targetImage}`,
            `WOS_DOCKER_REPLACEMENT_CONTAINER=${replacementName}`
        ],
        Labels: {
            'wosland.update.helper': 'true',
            'wosland.update.target': targetContainer,
            'wosland.update.replacement': replacementName
        },
        HostConfig: {
            AutoRemove: true,
            Binds: [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`],
            NetworkMode: 'none'
        }
    };

    const { statusCode: createStatus, data: createData } = await dockerApi(
        'POST',
        `/containers/create?name=${encodeURIComponent(helperName)}`,
        helperBody
    );
    if (createStatus !== 201) {
        throw new Error(`Failed to create update helper: HTTP ${createStatus} - ${JSON.stringify(createData)}`);
    }

    const { statusCode: startStatus, data: startData } = await dockerApi('POST', `/containers/${createData.Id}/start`);
    if (startStatus !== 204 && startStatus !== 304) {
        throw new Error(`Failed to start update helper: HTTP ${startStatus} - ${JSON.stringify(startData)}`);
    }

    return { helperName, helperId: createData.Id };
}

async function scheduleDockerUpdate({
    targetContainer = process.env.BOT_CONTAINER || DEFAULT_CONTAINER,
    targetImage = process.env.BOT_IMAGE || DEFAULT_IMAGE
} = {}) {
    if (!hasDockerSocket()) {
        throw new Error('Docker socket is not available inside this container.');
    }

    const normalized = normalizeImageRef(targetImage);
    console.log('[AUTO-UPDATE] Pulling latest Docker image...');
    await pullDockerImage(normalized.ref);

    let replacement = null;
    try {
        console.log('[AUTO-UPDATE] Preparing replacement container...');
        replacement = await createPreparedReplacement({
            targetContainer,
            targetImage,
            imageRef: normalized.ref
        });

        console.log('[AUTO-UPDATE] Starting Docker update helper...');
        await createAndStartHelper({
            targetContainer,
            targetImage,
            imageRef: normalized.ref,
            replacementName: replacement.replacementName
        });
    } catch (error) {
        if (replacement?.replacementName) {
            await dockerApi('DELETE', `/containers/${encodeURIComponent(replacement.replacementName)}?v=false&force=true`)
                .catch(() => {});
        }
        throw error;
    }

    console.log('[AUTO-UPDATE] Docker replacement scheduled. The bot container will restart shortly.');
    return {
        success: true,
        restartHandled: true,
        message: 'Docker update scheduled. Replacement container will start shortly.'
    };
}

async function runDockerUpdateHelper() {
    const targetContainer = process.env.WOS_DOCKER_TARGET_CONTAINER || process.env.BOT_CONTAINER || DEFAULT_CONTAINER;
    const replacementName = process.env.WOS_DOCKER_REPLACEMENT_CONTAINER;

    if (!replacementName) {
        throw new Error('Missing WOS_DOCKER_REPLACEMENT_CONTAINER.');
    }

    console.log(`[DOCKER-UPDATE] Helper will replace ${targetContainer} with ${replacementName}...`);
    await sleep(HELPER_DELAY_MS);

    const replacementInspect = await inspectContainer(replacementName);
    if (replacementInspect.statusCode !== 200) {
        throw new Error(`Replacement container not found: HTTP ${replacementInspect.statusCode}`);
    }

    console.log('[DOCKER-UPDATE] Stopping old bot container...');
    const stopResult = await dockerApi(
        'POST',
        `/containers/${encodeURIComponent(targetContainer)}/stop?t=10`,
        null,
        { timeoutMs: 20000 }
    ).catch(error => ({ statusCode: 500, data: error.message }));
    if (![204, 304, 404].includes(stopResult.statusCode)) {
        throw new Error(`Failed to stop old container: HTTP ${stopResult.statusCode} - ${JSON.stringify(stopResult.data)}`);
    }

    console.log('[DOCKER-UPDATE] Removing old bot container...');
    const removeResult = await dockerApi('DELETE', `/containers/${encodeURIComponent(targetContainer)}?v=false&force=true`)
        .catch(error => ({ statusCode: 500, data: error.message }));
    if (![204, 404].includes(removeResult.statusCode)) {
        throw new Error(`Failed to remove old container: HTTP ${removeResult.statusCode} - ${JSON.stringify(removeResult.data)}`);
    }

    console.log('[DOCKER-UPDATE] Promoting replacement container...');
    const renameResult = await dockerApi(
        'POST',
        `/containers/${encodeURIComponent(replacementName)}/rename?name=${encodeURIComponent(targetContainer)}`
    );
    if (renameResult.statusCode !== 204) {
        throw new Error(`Failed to rename replacement container: HTTP ${renameResult.statusCode} - ${JSON.stringify(renameResult.data)}`);
    }

    console.log('[DOCKER-UPDATE] Starting updated bot container...');
    const startResult = await dockerApi('POST', `/containers/${encodeURIComponent(targetContainer)}/start`);
    if (![204, 304].includes(startResult.statusCode)) {
        throw new Error(`Failed to start updated container: HTTP ${startResult.statusCode} - ${JSON.stringify(startResult.data)}`);
    }

    console.log('[DOCKER-UPDATE] Docker update complete.');
}

module.exports = {
    DOCKER_SOCKET,
    isDockerEngineUpdateDisabled,
    hasDockerSocket,
    dockerApi,
    pullDockerImage,
    checkDockerUpdate,
    scheduleDockerUpdate,
    runDockerUpdateHelper
};
