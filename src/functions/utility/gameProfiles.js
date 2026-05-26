const GAME_PROFILES = Object.freeze({
    wos: {
        type: 'wos',
        shortLabel: 'WOS',
        displayName: 'Whiteout Survival',
        api: {
            secret: 'tB87#kPtkxqOS2',
            playerUrl: 'https://wos-giftcode-api.centurygame.com/api/player',
            playerUrl2: 'https://gof-report-api-formal.centurygame.com/api/player',
            giftCodeUrl: 'https://wos-giftcode-api.centurygame.com/api/gift_code',
            captchaUrl: 'https://wos-giftcode-api.centurygame.com/api/captcha',
            origin: 'https://wos-giftcode.centurygame.com',
            origin2: 'https://gof-report-api-formal.centurygame.com',
            hasCaptcha: true
        },
        syncApi: {
            apiKey: 'super_secret_bot_token_nobody_will_ever_find',
            apiUrl: 'http://gift-code-api.whiteout-bot.com/giftcode_api.php'
        },
        storageKey: 'wos',
        requiresOnnx: true
    },
    ks: {
        type: 'ks',
        shortLabel: 'KS',
        displayName: 'Kingshot',
        api: {
            secret: 'mN4!pQs6JrYwV9',
            playerUrl: 'https://kingshot-giftcode.centurygame.com/api/player',
            playerUrl2: null,
            giftCodeUrl: 'https://kingshot-giftcode.centurygame.com/api/gift_code',
            captchaUrl: null,
            origin: 'https://kingshot-giftcode.centurygame.com',
            origin2: null,
            hasCaptcha: false
        },
        syncApi: {
            apiKey: 'super_secret_bot_token_nobody_will_ever_find',
            apiUrl: 'http://ks-gift-code-api.whiteout-bot.com/giftcode_api.php'
        },
        storageKey: 'ks',
        requiresOnnx: false
    }
});

function isSupportedGameType(gameType) {
    return Object.prototype.hasOwnProperty.call(GAME_PROFILES, gameType);
}

function normalizeGameType(gameType, fallback = 'wos') {
    const normalized = String(gameType || '').trim().toLowerCase();
    return isSupportedGameType(normalized) ? normalized : fallback;
}

function getGameProfile(gameType = 'wos') {
    return GAME_PROFILES[normalizeGameType(gameType)];
}

function getAllGameProfiles() {
    return Object.values(GAME_PROFILES);
}

module.exports = {
    GAME_PROFILES,
    getAllGameProfiles,
    getGameProfile,
    isSupportedGameType,
    normalizeGameType
};
