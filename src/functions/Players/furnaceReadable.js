const { normalizeGameType } = require('../utility/gameProfiles');

/**
 * Furnace level mapping for user-friendly display
 */
const FURNACE_LEVEL_MAPPING = {
    31: "30-1", 32: "30-2", 33: "30-3", 34: "30-4", 35: "FC 1",
    36: "FC 1 - 1", 37: "FC 1 - 2", 38: "FC 1 - 3", 39: "FC 1 - 4", 40: "FC 2",
    41: "FC 2 - 1", 42: "FC 2 - 2", 43: "FC 2 - 3", 44: "FC 2 - 4", 45: "FC 3",
    46: "FC 3 - 1", 47: "FC 3 - 2", 48: "FC 3 - 3", 49: "FC 3 - 4", 50: "FC 4",
    51: "FC 4 - 1", 52: "FC 4 - 2", 53: "FC 4 - 3", 54: "FC 4 - 4", 55: "FC 5",
    56: "FC 5 - 1", 57: "FC 5 - 2", 58: "FC 5 - 3", 59: "FC 5 - 4", 60: "FC 6",
    61: "FC 6 - 1", 62: "FC 6 - 2", 63: "FC 6 - 3", 64: "FC 6 - 4", 65: "FC 7",
    66: "FC 7 - 1", 67: "FC 7 - 2", 68: "FC 7 - 3", 69: "FC 7 - 4", 70: "FC 8",
    71: "FC 8 - 1", 72: "FC 8 - 2", 73: "FC 8 - 3", 74: "FC 8 - 4", 75: "FC 9",
    76: "FC 9 - 1", 77: "FC 9 - 2", 78: "FC 9 - 3", 79: "FC 9 - 4", 80: "FC 10",
    81: "FC 10 - 1", 82: "FC 10 - 2", 83: "FC 10 - 3", 84: "FC 10 - 4"
};

function getLocalizedCommonValue(lang, key, fallback) {
    return lang?.common?.[key] || fallback;
}

function getSettlementName(gameType = 'wos', lang = null) {
    const resolvedGameType = normalizeGameType(gameType, 'wos');

    if (resolvedGameType === 'ks') {
        return getLocalizedCommonValue(lang, 'townCenter', 'Town Center');
    }

    return getLocalizedCommonValue(lang, 'furnace', 'Furnace');
}

function getSettlementLevelLabel(gameType = 'wos', lang = null) {
    const resolvedGameType = normalizeGameType(gameType, 'wos');

    if (resolvedGameType === 'ks') {
        return getLocalizedCommonValue(lang, 'townCenterLevel', 'Town Center Level');
    }

    return getLocalizedCommonValue(lang, 'furnaceLevel', 'Furnace Level');
}

function resolveReadableArgs(langOrGameType = null, explicitGameType = 'wos') {
    if (typeof langOrGameType === 'string' && explicitGameType === 'wos') {
        return {
            lang: null,
            gameType: langOrGameType
        };
    }

    return {
        lang: langOrGameType,
        gameType: explicitGameType
    };
}

/**
 * Converts a furnace level number to a readable format with i18n support
 * @param {number} level - The furnace level number
 * @param {Object|string} langOrGameType - Language object or game type
 * @param {string} gameType - Game type when language object is provided
 * @returns {string} Readable furnace level (e.g., "FC 5 - 2" for level 57, or "25" for unmapped levels)
 * 
 * @example
 * getFurnaceReadable(57)  // Returns "FC 5 - 2"
 * getFurnaceReadable(57, lang)  // Returns "كريستال 5 - 2" (if Arabic)
 * getFurnaceReadable(57, null, 'ks')  // Returns "TG 5 - 2"
 * getFurnaceReadable(35)  // Returns "FC 1"
 * getFurnaceReadable(25)  // Returns "25"
 * getFurnaceReadable(0)   // Returns "0"
 */
function getFurnaceReadable(level, langOrGameType = null, gameType = 'wos') {
    // Handle invalid input
    if (level === null || level === undefined || (typeof level === 'number' && Number.isNaN(level))) {
        return 'Unknown';
    }

    const { lang, gameType: resolvedGameType } = resolveReadableArgs(langOrGameType, gameType);

    // Convert to number if string
    const furnaceLevel = typeof level === 'string' ? parseInt(level, 10) : level;

    // Handle NaN result after parsing (e.g., non-numeric strings)
    if (Number.isNaN(furnaceLevel)) {
        return 'Unknown';
    }

    // Check if level is in mapping
    if (FURNACE_LEVEL_MAPPING.hasOwnProperty(furnaceLevel)) {
        const mappedValue = FURNACE_LEVEL_MAPPING[furnaceLevel];
        const crystalPrefix = normalizeGameType(resolvedGameType, 'wos') === 'ks'
            ? getLocalizedCommonValue(lang, 'townCenterGold', 'TG')
            : getLocalizedCommonValue(lang, 'furnaceCrystal', 'FC');

        return mappedValue.replace(/^FC/, crystalPrefix);
    }

    // For levels not in mapping, return as string
    return String(furnaceLevel);
}

module.exports = {
    getSettlementName,
    getSettlementLevelLabel,
    getFurnaceReadable,
    FURNACE_LEVEL_MAPPING  // Export the mapping too in case I need direct access
};
