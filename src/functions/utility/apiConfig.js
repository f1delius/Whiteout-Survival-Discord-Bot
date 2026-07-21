const { getGameProfile } = require('./gameProfiles');
const { getDefaultGameType } = require('./gameRuntime');

const SHARED_LIMITS = Object.freeze({
    RATE_LIMIT_DELAY: 60000, // 60 seconds
    RETRY_DELAY: 3000, // 3 seconds
    MAX_RETRIES: 3,
    MAX_REDEEM_ATTEMPTS: 3,
    MEMBER_PROCESS_DELAY_MIN: 700, // min inter-player delay ms
    MEMBER_PROCESS_DELAY_MAX: 1300, // max inter-player delay ms
    MAX_RETRY_CYCLES: 10 // max retry cycles per player for rate limits
});

function buildApiConfig(gameType = getDefaultGameType()) {
    const profile = getGameProfile(gameType);
    return Object.freeze({
        GAME_TYPE: profile.type,
        GAME_NAME: profile.displayName,
        SHORT_LABEL: profile.shortLabel,
        SECRET: profile.api.secret,
        GIFT_CODE_URL: profile.api.giftCodeUrl,
        ORIGIN: profile.api.origin,
        ...SHARED_LIMITS
    });
}

function buildGiftCodeApiConfig(gameType = getDefaultGameType()) {
    const profile = getGameProfile(gameType);
    return Object.freeze({
        GAME_TYPE: profile.type,
        GAME_NAME: profile.displayName,
        API_KEY: profile.syncApi.apiKey,
        API_URL: profile.syncApi.apiUrl
    });
}

function getApiConfig(gameType) {
    return buildApiConfig(gameType);
}

function getGiftCodeApiConfig(gameType) {
    return buildGiftCodeApiConfig(gameType);
}

// Backward-compatible default exports for callers that still assume one global config.
const API_CONFIG = buildApiConfig();
const GIFT_CODE_API_CONFIG = buildGiftCodeApiConfig();

module.exports = {
    API_CONFIG,
    GIFT_CODE_API_CONFIG,
    SHARED_LIMITS,
    getApiConfig,
    getGiftCodeApiConfig
};
