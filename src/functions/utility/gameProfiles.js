const GAME_PROFILES = Object.freeze({
    wos: {
        type: 'wos',
        shortLabel: 'WOS',
        displayName: 'Whiteout Survival',
        api: {
            secret: 'tB87#kPtkxqOS2',
            giftCodeUrl: 'https://wos-giftcode-api.centurygame.com/api/gift_code',
            origin: 'https://wos-giftcode.centurygame.com'
        },
        syncApi: {
            apiKey: 'super_secret_bot_token_nobody_will_ever_find',
            apiUrl: 'http://gift-code-api.whiteout-bot.com/giftcode_api.php'
        },
        storageKey: 'wos'
    },
    ks: {
        type: 'ks',
        shortLabel: 'KS',
        displayName: 'Kingshot',
        api: {
            secret: 'mN4!pQs6JrYwV9',
            giftCodeUrl: 'https://kingshot-giftcode.centurygame.com/api/gift_code',
            origin: 'https://ks-giftcode.centurygame.com'
        },
        syncApi: {
            apiKey: 'super_secret_bot_token_nobody_will_ever_find',
            apiUrl: 'http://ks-gift-code-api.whiteout-bot.com/giftcode_api.php'
        },
        storageKey: 'ks'
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
