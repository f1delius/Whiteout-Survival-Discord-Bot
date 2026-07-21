const { getGameProfile, normalizeGameType } = require('./gameProfiles');

function parseGameTypeArg(argv = process.argv.slice(2)) {
    const inlineArg = argv.find(arg => /^--type=/i.test(arg));
    if (inlineArg) {
        return inlineArg.split('=')[1] || null;
    }

    const flagIndex = argv.findIndex(arg => /^--type$/i.test(arg));
    if (flagIndex >= 0) {
        return argv[flagIndex + 1] || null;
    }

    return process.env.BOT_GAME_TYPE || null;
}

function normalizeRuntimeMode(rawValue) {
    const value = String(rawValue || 'wos').trim().toLowerCase();
    if (value === 'both') return 'both';
    if (value === 'ks') return 'ks';
    return 'wos';
}

function expandRuntimeMode(mode) {
    if (mode === 'both') {
        return ['wos', 'ks'];
    }
    return [normalizeGameType(mode)];
}

function buildRuntimeState() {
    const mode = normalizeRuntimeMode(parseGameTypeArg());
    const activeGameTypes = expandRuntimeMode(mode);
    const defaultGameType = activeGameTypes[0] || 'wos';
    return {
        mode,
        activeGameTypes,
        defaultGameType
    };
}

if (!global.__wosRuntimeGameState) {
    global.__wosRuntimeGameState = buildRuntimeState();
}

function getRuntimeGameState() {
    return global.__wosRuntimeGameState;
}

function getRuntimeGameMode() {
    return getRuntimeGameState().mode;
}

function getActiveGameTypes() {
    return [...getRuntimeGameState().activeGameTypes];
}

function getDefaultGameType() {
    return getRuntimeGameState().defaultGameType;
}

function getDefaultGameProfile() {
    return getGameProfile(getDefaultGameType());
}

function isGameEnabled(gameType) {
    return getActiveGameTypes().includes(normalizeGameType(gameType));
}

function isMultiGameModeEnabled() {
    return getRuntimeGameMode() === 'both';
}

module.exports = {
    getActiveGameTypes,
    getDefaultGameProfile,
    getDefaultGameType,
    getRuntimeGameMode,
    getRuntimeGameState,
    isGameEnabled,
    isMultiGameModeEnabled,
    parseGameTypeArg
};
