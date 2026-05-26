const {
    getDefaultGameType,
    isMultiGameModeEnabled
} = require('../utility/gameRuntime');
const {
    isSupportedGameType,
    normalizeGameType
} = require('../utility/gameProfiles');

function parseGameScopedGiftCode(rawInput, options = {}) {
    const {
        strictBothMode = true,
        fallbackGameType = getDefaultGameType()
    } = options;

    const trimmed = String(rawInput || '').trim();
    if (!trimmed) {
        return { error: 'Gift code is required.' };
    }

    const prefixedMatch = trimmed.match(/^([a-zA-Z]{2,10})\s*:\s*(.+)$/);
    if (prefixedMatch) {
        const requestedGameType = normalizeGameType(prefixedMatch[1], null);
        if (!requestedGameType || !isSupportedGameType(requestedGameType)) {
            return { error: 'Unsupported game type prefix. Use wos:CODE or ks:CODE.' };
        }

        return {
            gameType: requestedGameType,
            giftCode: prefixedMatch[2].trim()
        };
    }

    if (strictBothMode && isMultiGameModeEnabled()) {
        return { error: 'Gift codes must include a game prefix in both mode. Use wos:CODE or ks:CODE.' };
    }

    return {
        gameType: normalizeGameType(fallbackGameType),
        giftCode: trimmed
    };
}

module.exports = {
    parseGameScopedGiftCode
};
