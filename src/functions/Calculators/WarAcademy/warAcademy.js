const {
    ButtonBuilder, ButtonStyle, ActionRowBuilder,
    ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
    SeparatorSpacingSize, MessageFlags, StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, LabelBuilder
} = require('discord.js');
const { handleError, assertUserMatches, getUserInfo } = require('../../utility/commonFunctions');
const { checkFeatureAccess } = require('../../utility/checkAccess');
const { userQueries } = require('../../utility/database');
const { getComponentEmoji, getEmojiMapForUser } = require('../../utility/emojis');
const { getFurnaceReadable } = require('../../Players/furnaceReadable');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../../utility/gameRuntime');
const { normalizeGameType } = require('../../utility/gameProfiles');

const infantryData = require('./Infantry.json');
const marksmanData = require('./Marksman.json');
const lancerData   = require('./Lancer.json');
const kingshotInfantryData = require('./kingshot_infantry.json');
const kingshotArcherData = require('./kingshot_archer.json');
const kingshotCavalryData = require('./kingshot_cavalry.json');

// Lazy-load ascii85 once; falls back to null if unavailable
let _ascii85 = null;
function getAscii85() {
    if (_ascii85 === null) {
        try { _ascii85 = require('ascii85'); } catch { _ascii85 = undefined; }
    }
    return _ascii85;
}

const PAGE_SIZE = 24;

const CATEGORY_META = {
    wos: {
        i: { localeKey: 'infantry', emoji: '1001' },
        m: { localeKey: 'marksman', emoji: '1043' },
        l: { localeKey: 'lancer', emoji: '1035' }
    },
    ks: {
        i: { localeKey: 'infantry', emoji: '1001' },
        a: { localeKey: 'archer', emoji: '1043' },
        c: { localeKey: 'cavalry', emoji: '1035' }
    }
};

// ─── Category / data helpers ──────────────────────────────────────────────────

/** Returns the JSON data object for a category key. */
function getCategoryData(cat, gameType = getDefaultGameType()) {
    const resolvedGameType = normalizeGameType(gameType, 'wos');
    if (resolvedGameType === 'ks') {
        switch (cat) {
            case 'i': return kingshotInfantryData;
            case 'a': return kingshotArcherData;
            case 'c': return kingshotCavalryData;
            default:  return kingshotInfantryData;
        }
    }
    switch (cat) {
        case 'i': return infantryData;
        case 'm': return marksmanData;
        case 'l': return lancerData;
        default:  return infantryData;
    }
}

/** Returns the list of skill names for a category. */
function getSkillNames(cat, gameType = getDefaultGameType()) {
    return Object.keys(getCategoryData(cat, gameType).skills);
}

/** Returns the skill data object for a given category + skill id (name). */
function getSkillData(cat, skillId, gameType = getDefaultGameType()) {
    return getCategoryData(cat, gameType).skills[skillId];
}

/** Returns sorted level keys for a skill. */
function getSkillLevelKeys(skillData) {
    if (!skillData?.levels) return [];
    return Object.keys(skillData.levels)
        .sort((a, b) => parseInt(a) - parseInt(b));
}

// Short 2-char codes for compact copy-button customIds — must be unique and contain no `_` or `-`.
const SKILL_SHORT = {};
const SHORT_TO_SKILL = {};

/**
 * Builds the short code mappings on first use.
 * Uses a 2-char base-36 hash of the skill name to keep it compact.
 */
function ensureShortCodes() {
    if (Object.keys(SKILL_SHORT).length > 0) return;
    for (const gameType of ['wos', 'ks']) {
        const cats = Object.keys(CATEGORY_META[gameType]);
        for (const cat of cats) {
            for (const name of getSkillNames(cat, gameType)) {
            if (SKILL_SHORT[name]) continue;
            // Create a short 2-char code from a simple hash
            let hash = 0;
            for (let i = 0; i < name.length; i++) {
                hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
            }
            let code = Math.abs(hash).toString(36).slice(0, 2).toUpperCase();
            // Handle collisions by appending index
            while (SHORT_TO_SKILL[code]) {
                hash++;
                code = Math.abs(hash).toString(36).slice(0, 2).toUpperCase();
            }
            SKILL_SHORT[name] = code;
            SHORT_TO_SKILL[code] = name;
        }
        }
    }
}

function getCategoryLabel(cat, lang, gameType = getDefaultGameType()) {
    const resolvedGameType = normalizeGameType(gameType, 'wos');
    const meta = CATEGORY_META[resolvedGameType]?.[cat] || CATEGORY_META.wos.i;
    const categories = lang.calculators.warAcademy.categories?.[resolvedGameType]
        || lang.calculators.warAcademy.categories;
    return categories?.[meta.localeKey] || categories?.infantry || meta.localeKey;
}

/** Returns the human-readable display string for a level key. */
function getLevelDisplay(key, lang) {
    if (key === '0') return lang.calculators.warAcademy.notResearched;
    return lang.calculators.warAcademy.levelDisplay.replace('{key}', key);
}

/** Maps single-char category code to the i18n skills key. */
const CAT_KEY_MAP = {
    wos: { i: 'infantry', m: 'marksman', l: 'lancer' },
    ks: { i: 'infantry', a: 'archer', c: 'cavalry' }
};

/**
 * Maps raw JSON skill names to short camelCase i18n keys.
 * Helios variants drop the troop type since they're already inside the category.
 */
const SKILL_NAME_TO_KEY = {
    // Shared across categories
    'Flame Squad': 'flameSquad',
    'Flame Legion': 'flameLegion',
    // Infantry
    'Flame Shield': 'flameShield',
    'Flame Strike': 'flameStrike',
    'Flame Tomahawk': 'flameTomahawk',
    'Flame Protection': 'flameProtection',
    'Helios Infantry': 'helios',
    'Helios Infantry Healing': 'heliosHealing',
    'Helios Infantry Training': 'heliosTraining',
    'Helios Infantry First Aid': 'heliosFirstAid',
    // Marksman
    'Crystal Armor': 'crystalArmor',
    'Crystal Vision': 'crystalVision',
    'Crystal Arrow': 'crystalArrow',
    'Crystal Protection': 'crystalProtection',
    'Helios Marksman': 'helios',
    'Helios Marksman Healing': 'heliosHealing',
    'Helios Marksman Training': 'heliosTraining',
    'Helios Marksman First Aid': 'heliosFirstAid',
    // Lancer
    'Blazing Armor': 'blazingArmor',
    'Blazing Charge': 'blazingCharge',
    'Blazing Lance': 'blazingLance',
    'Blazing Guardian': 'blazingGuardian',
    'Helios Lancer': 'helios',
    'Helios Lancer Healing': 'heliosHealing',
    'Helios Lancer Training': 'heliosTraining',
    'Helios Lancer First Aid': 'heliosFirstAid',
};

const KSHOT_SKILL_NAME_TO_KEY = {
    'Truegold Battalion': 'truegoldBattalion',
    'Truegold Blades': 'truegoldBlades',
    'Truegold Shields': 'truegoldShields',
    'Truegold Legionaries': 'truegoldLegionaries',
    'Truegold Plating': 'truegoldPlating',
    'Truegold Mauls': 'truegoldMauls',
    'Truegold Infantry': 'truegoldInfantry',
    'Truegold Infantry Training': 'truegoldInfantryTraining',
    'Truegold Infantry Aid': 'truegoldInfantryAid',
    'Truegold Infantry Healing': 'truegoldInfantryHealing',
    'Truegold Bows': 'truegoldBows',
    'Truegold Bracers': 'truegoldBracers',
    'Truegold Vests': 'truegoldVests',
    'Truegold Arrows': 'truegoldArrows',
    'Truegold Archers': 'truegoldArchers',
    'Truegold Archer Training': 'truegoldArcherTraining',
    'Truegold Archer Aid': 'truegoldArcherAid',
    'Truegold Archer Healing': 'truegoldArcherHealing',
    'Truegold Charge': 'truegoldCharge',
    'Truegold Farriery': 'truegoldFarriery',
    'Truegold Platecraft': 'truegoldPlatecraft',
    'Truegold Lances': 'truegoldLances',
    'Truegold Cavalry': 'truegoldCavalry',
    'Truegold Cavalry Training': 'truegoldCavalryTraining',
    'Truegold Cavalry Aid': 'truegoldCavalryAid',
    'Truegold Cavalry Healing': 'truegoldCavalryHealing'
};

/** Returns the localized display name for a skill. Falls back to the raw JSON key. */
function getSkillDisplayName(cat, skillName, lang, gameType = getDefaultGameType()) {
    const resolvedGameType = normalizeGameType(gameType, 'wos');
    const catKey = CAT_KEY_MAP[resolvedGameType]?.[cat] || 'infantry';
    const skillMap = resolvedGameType === 'ks' ? KSHOT_SKILL_NAME_TO_KEY : SKILL_NAME_TO_KEY;
    const i18nKey = skillMap[skillName] || skillName;
    return lang.calculators.warAcademy.content.skills?.[resolvedGameType]?.[catKey]?.[i18nKey]
        || lang.calculators.warAcademy.content.skills?.[catKey]?.[i18nKey]
        || skillName;
}

function getResourceLabels(lang, gameType = getDefaultGameType()) {
    const resolvedGameType = normalizeGameType(gameType, 'wos');
    const resourceGroups = lang.calculators.warAcademy.content.resources;
    const r = resourceGroups[resolvedGameType] || resourceGroups;
    return {
        meat:      r.meat,
        food:      r.food,
        wood:      r.wood,
        coal:      r.coal,
        stone:     r.stone,
        iron:      r.iron,
        steel:     r.steel,
        gold:      r.gold,
        fc_shards: r.fcShards,
        truegoldDust: r.truegoldDust
    };
}

function getWarAcademyModalLocale(lang, gameType = getDefaultGameType()) {
    const baseModal = lang.calculators.warAcademy.modal;
    if (normalizeGameType(gameType, 'wos') !== 'ks') {
        return baseModal;
    }

    return {
        ...baseModal,
        vp: {
            ...baseModal.vp,
            ...((baseModal.ks || {}).vp || {})
        }
    };
}

function getWarAcademyResultBuffLocale(lang, gameType = getDefaultGameType()) {
    const resultBuffs = lang.calculators.warAcademy.results.buffs;
    if (normalizeGameType(gameType, 'wos') !== 'ks') {
        return resultBuffs;
    }

    return {
        ...resultBuffs,
        ...((lang.calculators.warAcademy.results.ks || {}).buffs || {})
    };
}

// ─── Number / time formatting ─────────────────────────────────────────────────

/** Formats a large number as a compact string (B/M/K suffix). */
function formatNumber(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000)         return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toLocaleString();
}

/** Formats a duration in seconds as a human-readable string (Xd Xh Xm Xs). */
function formatSeconds(sec) {
    if (!sec || sec <= 0) return '0s';
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0) parts.push(`${s}s`);
    return parts.join(' ') || '0s';
}

// ─── Buff helpers ─────────────────────────────────────────────────────────────

/** Clamp a value between 0 and a max. */
function clamp(v, max) { return Math.min(max, Math.max(0, v || 0)); }

/** VP flat speed bonuses */
const VP_SPEED = { 0: 0, 10: 10, 15: 15 };

/** Loads and parses the user's saved WA buff settings from the database. */
function getUserBuffs(userId) {
    try {
        const row = userQueries.getBuffs(userId);
        if (!row?.buffs) return { vpBonus: 0, researchSpeed: 0 };
        const parsed = JSON.parse(row.buffs);
        return {
            vpBonus:       Number(parsed.waVpBonus) || 0,
            researchSpeed: Number(parsed.waResearchSpeed) || 0
        };
    } catch {
        return { vpBonus: 0, researchSpeed: 0 };
    }
}

/** Returns true if any WA buff field is active (non-zero). */
function hasAnyBuff(buffs) {
    return buffs.vpBonus > 0 || buffs.researchSpeed > 0;
}

// Empty resource totals template
const EMPTY_TOTALS = {
    meat: 0,
    food: 0,
    wood: 0,
    coal: 0,
    stone: 0,
    iron: 0,
    steel: 0,
    gold: 0,
    fc_shards: 0,
    truegoldDust: 0
};

/** Buff names that are flat numbers (not percentages). */
const FLAT_BUFFS = new Set(['Troop Deployment Capacity', 'Rally Capacity', 'Squad Capacity']);

/** Formats a buff amount: flat buffs as plain integer, % buffs with % suffix. Strips trailing .00. */
function formatBuffAmount(name, amount) {
    const num = Number(amount);
    const display = Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
    if (FLAT_BUFFS.has(name) || name.startsWith('Unlock')) return `+${display}`;
    return `+${display}%`;
}

// ─── Calculation ──────────────────────────────────────────────────────────────

/**
 * Calculates the total resource cost, research time, requirements, and buff for
 * upgrading a skill from `fromKey` to `toKey`.
 * @param {object} skillData - Data object for the specific skill
 * @param {string} fromKey   - Starting level key
 * @param {string} toKey     - Target level key
 * @param {object} buffs     - User buff settings
 * @returns {{ totals, totalSeconds, reducedSeconds, maxResearchCenter, otherSkillReqs, buffInfo, numLevels } | null}
 */
function calculateUpgrade(skillData, fromKey, toKey, buffs) {
    if (!skillData) return null;

    const levelKeys = getSkillLevelKeys(skillData);
    const fromIdx   = fromKey === '0' ? -1 : levelKeys.indexOf(String(fromKey));
    const toIdx     = levelKeys.indexOf(String(toKey));

    if ((fromIdx === -1 && fromKey !== '0') || toIdx === -1 || fromIdx >= toIdx) return null;

    // Combined speed %: manual input + VP bonus
    const totalSpeedPct = (Number(buffs?.researchSpeed) || 0) + (Number(buffs?.vpBonus) || 0);

    const totals        = { ...EMPTY_TOTALS };
    const otherSkillReqs = {};
    let totalSeconds       = 0;
    let maxResearchCenter  = 0;
    let numLevels          = 0;
    let buffName           = '';
    let totalBuffAmount    = 0;

    for (let i = fromIdx + 1; i <= toIdx; i++) {
        const levelData = skillData.levels[levelKeys[i]];
        if (!levelData) continue;

        if (levelData.cost) {
            for (const [res, amt] of Object.entries(levelData.cost)) {
                const amount = parseFloat(amt) || 0;
                if (Object.hasOwn(totals, res)) totals[res] += amount;
            }
        }

        if (levelData.time?.['raw-seconds']) {
            totalSeconds += levelData.time['raw-seconds'];
        }

        // Track max research center requirement
        const requirements = levelData.requirements || {};
        const rcLevel = parseInt(requirements['war-academy'] ?? requirements.warAcademy);
        if (!isNaN(rcLevel) && rcLevel > maxResearchCenter) {
            maxResearchCenter = rcLevel;
        }

        // Track other-skill requirements (keep max level per skill)
        const otherSkills = requirements['other-skill'] || requirements.otherSkill;
        if (otherSkills) {
            for (const [reqSkill, reqLevel] of Object.entries(otherSkills)) {
                const lvl = parseInt(reqLevel);
                if (!isNaN(lvl) && (!otherSkillReqs[reqSkill] || lvl > otherSkillReqs[reqSkill])) {
                    otherSkillReqs[reqSkill] = lvl;
                }
            }
        }

        // Accumulate buff amounts
        if (levelData.buff?.name && levelData.buff?.amount) {
            if (!buffName) buffName = levelData.buff.name;
            if (buffName === levelData.buff.name) {
                totalBuffAmount += parseFloat(levelData.buff.amount);
            }
        }

        numLevels++;
    }

    // Apply research speed: time / (1 + speed%)
    const reducedSeconds = totalSpeedPct > 0
        ? Math.ceil(totalSeconds / (1 + totalSpeedPct / 100))
        : totalSeconds;

    const buffInfo = buffName
        ? { name: buffName, amount: totalBuffAmount }
        : null;

    return { totals, totalSeconds, reducedSeconds, maxResearchCenter, otherSkillReqs, buffInfo, numLevels };
}

// ─── Entry encoding/decoding for copy button ─────────────────────────────────

/**
 * Encodes upgrade entries into the copy-button customId.
 * Format: calc_wa_copy_{gameType}|{cat}:{shortCode}{from}-{to}.{shortCode}{from}-{to}_{userId}
 * @param {{ gameType, cat, skillId, fromKey, toKey }[]} entries
 * @param {string} userId
 * @returns {string | null} null if the final customId would exceed 100 characters
 */
function encodeResultsCustomId(entries, userId) {
    if (!entries?.length) return null;
    ensureShortCodes();
    const gameType = normalizeGameType(entries[0].gameType, 'wos');
    const cat  = entries[0].cat;
    const segs = entries.map(e => `${SKILL_SHORT[e.skillId] ?? e.skillId}${e.fromKey}-${e.toKey}`);
    const plain = `${gameType}|${cat}:${segs.join('.')}`;

    let payload = plain;
    try {
        const lib = getAscii85();
        if (lib) {
            const b85 = lib.encode(Buffer.from(plain, 'utf8')).toString();
            if (b85.length + 1 < plain.length) payload = `~${b85}`;
        }
    } catch { /* keep plain */ }

    const full = `calc_wa_copy_${payload}_${userId}`;
    return full.length <= 100 ? full : null;
}

/**
 * Decodes all upgrade entries from a copy-button customId.
 * @param {string} copyId  full customId string
 * @param {object} buffs
 * @returns {{ gameType, cat, skillId, fromKey, toKey, result }[]}
 */
function decodeResultsEntries(copyId, buffs) {
    if (!copyId.startsWith('calc_wa_copy_')) return [];
    ensureShortCodes();
    const withoutPrefix = copyId.slice('calc_wa_copy_'.length);
    const lastUnderscore = withoutPrefix.lastIndexOf('_');
    if (lastUnderscore === -1) return [];
    let encoded = withoutPrefix.slice(0, lastUnderscore);

    // Decompress Base85 if flagged with leading '~'
    if (encoded.startsWith('~')) {
        try {
            const lib = getAscii85();
            if (!lib) return [];
            encoded = lib.decode(encoded.slice(1)).toString('utf8');
        } catch { return []; }
    }

    const colonIdx = encoded.indexOf(':');
    if (colonIdx === -1) return [];
    const header = encoded.slice(0, colonIdx);
    const [maybeGameType, maybeCat] = header.includes('|')
        ? header.split('|')
        : ['wos', header];
    const gameType = normalizeGameType(maybeGameType, 'wos');
    const cat     = maybeCat;
    const segsStr = encoded.slice(colonIdx + 1);

    return segsStr.split('.').flatMap(seg => {
        if (seg.length < 4) return [];
        const cShort  = seg.slice(0, 2);
        const skillId = SHORT_TO_SKILL[cShort];
        const levelStr = seg.slice(2);
        const dashIdx  = levelStr.indexOf('-');
        if (dashIdx === -1 || !skillId) return [];
        const fromKey = levelStr.slice(0, dashIdx);
        const toKey   = levelStr.slice(dashIdx + 1);
        const result  = calculateUpgrade(getSkillData(cat, skillId, gameType), fromKey, toKey, buffs);
        return result ? [{ gameType, cat, skillId, fromKey, toKey, result }] : [];
    });
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

/**
 * Aggregates all numeric totals and requirements across a set of upgrade entries.
 * @param {{ result: object }[]} entries
 * @returns {{ totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxResearchCenter, allOtherSkillReqs, allBuffs }}
 */
function aggregateEntries(entries) {
    const totalRes           = { ...EMPTY_TOTALS };
    const allOtherSkillReqs  = {};
    const allBuffs           = [];
    let totalSeconds       = 0;
    let reducedSeconds     = 0;
    let totalNumLevels     = 0;
    let maxResearchCenter  = 0;

    for (const e of entries) {
        for (const [res, amt] of Object.entries(e.result.totals)) {
            if (Object.hasOwn(totalRes, res)) totalRes[res] += amt;
        }
        totalSeconds   += e.result.totalSeconds;
        reducedSeconds += e.result.reducedSeconds;
        totalNumLevels += e.result.numLevels;

        if (e.result.maxResearchCenter > maxResearchCenter) {
            maxResearchCenter = e.result.maxResearchCenter;
        }

        // Merge other-skill requirements (keep max)
        for (const [sk, lv] of Object.entries(e.result.otherSkillReqs)) {
            if (!allOtherSkillReqs[sk] || lv > allOtherSkillReqs[sk]) {
                allOtherSkillReqs[sk] = lv;
            }
        }

        if (e.result.buffInfo) {
            allBuffs.push(e.result.buffInfo);
        }
    }

    return { totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxResearchCenter, allOtherSkillReqs, allBuffs };
}

/**
 * Reads the results container (index 1) from the current message and decodes
 * its copy-button customId back into upgrade entries.
 */
function getExistingEntries(message, buffs) {
    const components = message.components;
    if (components.length <= 1) return [];
    const subComponents = components[1].components ?? [];
    const lastRow       = subComponents[subComponents.length - 1];
    const copyId        = lastRow?.components?.[0]?.customId ?? lastRow?.components?.[0]?.custom_id ?? '';
    return copyId.startsWith('calc_wa_copy_') ? decodeResultsEntries(copyId, buffs) : [];
}

// ─── UI builders ──────────────────────────────────────────────────────────────

/**
 * Container shown after clicking "War Academy" in both mode — lets user pick the game first.
 */
function buildGameSelectionContainer(userId, lang) {
    const lc       = lang.calculators.warAcademy;
    const emojiMap = getEmojiMapForUser(userId);
    const options = lang.common?.gameSelection?.options || {};

    const wosBtn = new ButtonBuilder()
        .setCustomId(`calc_wa_game_wos_${userId}`)
        .setLabel(options.wos || 'Whiteout Survival')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1040'));

    const ksBtn = new ButtonBuilder()
        .setCustomId(`calc_wa_game_ks_${userId}`)
        .setLabel(options.ks || 'Kingshot')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1012'));

    const backBtn = new ButtonBuilder()
        .setCustomId(`calc_wa_back_main_x_${userId}`)
        .setLabel(lc.buttons.back)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1002'));

    return new ContainerBuilder()
        .setAccentColor(0xe74c3c)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(lc.header.gameSelection)
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(new ActionRowBuilder().addComponents(wosBtn, ksBtn, backBtn));
}

/**
 * Container shown after clicking "War Academy" — lets user pick troop category for the selected game.
 */
function buildCategorySelectionContainer(userId, lang, gameType = getDefaultGameType()) {
    const lc       = lang.calculators.warAcademy;
    const emojiMap = getEmojiMapForUser(userId);
    const resolvedGameType = normalizeGameType(gameType, 'wos');
    const categories = Object.entries(CATEGORY_META[resolvedGameType]).map(([cat, meta]) =>
        new ButtonBuilder()
            .setCustomId(`calc_wa_cat_${resolvedGameType}_${cat}_${userId}`)
            .setLabel(getCategoryLabel(cat, lang, resolvedGameType))
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, meta.emoji))
    );
    const backTarget = isMultiGameModeEnabled() ? 'game' : 'main';
    const backBtn = new ButtonBuilder()
        .setCustomId(`calc_wa_back_${backTarget}_${resolvedGameType}_${userId}`)
        .setLabel(lc.buttons.back)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1002'));

    return new ContainerBuilder()
        .setAccentColor(0xe74c3c)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(lc.header.categorySelection)
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(new ActionRowBuilder().addComponents(...categories, backBtn));
}

/**
 * Controls container — skill select, optional level selects, buffs + back buttons.
 * @param {string} cat     - 'i' (infantry), 'm' (marksman), 'l' (lancer)
 * @param {string} skillId - Skill name or 'x' if not yet selected
 * @param {string} fromKey - From-level key or 'x' if not yet selected
 * @param {string} toKey   - To-level key or 'x' if not yet selected
 * @param {number} pageFrom - Current page (0-based) for from-level select
 * @param {number} pageTo   - Current page (0-based) for to-level select
 * @param {string} userId
 * @param {object} lang
 */
function buildControlsContainer(cat, skillId, fromKey, toKey, pageFrom, pageTo, userId, lang, gameType = getDefaultGameType()) {
    const lc       = lang.calculators.warAcademy;
    const emojiMap = getEmojiMapForUser(userId);
    const resolvedGameType = normalizeGameType(gameType, 'wos');
    const catData  = getCategoryData(cat, resolvedGameType);

    const headerText = lc.header.controls.replace('{category}', getCategoryLabel(cat, lang, resolvedGameType));

    // Skill select menu
    const skillNames  = getSkillNames(cat, resolvedGameType);
    const skillOptions = skillNames.map(name => ({
        label: getSkillDisplayName(cat, name, lang, resolvedGameType),
        value: name,
        default: false
    }));

    const skillSelect = new StringSelectMenuBuilder()
        .setCustomId(`calc_wa_select_${resolvedGameType}_${cat}_${userId}`)
        .setPlaceholder(lc.placeholders.selectSkill)
        .addOptions(skillOptions.slice(0, 25));

    const container = new ContainerBuilder()
        .setAccentColor(0xe74c3c)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    // Show selected skill name and from-level (both as text)
    if (skillId !== 'x' && catData.skills[skillId]) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(lc.header.selected.replace('{name}', getSkillDisplayName(cat, skillId, lang, resolvedGameType)))
        );
        if (fromKey !== 'x') {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(lc.header.from.replace('{level}', getLevelDisplay(fromKey, lang)))
            );
        }
    }

    container.addActionRowComponents(new ActionRowBuilder().addComponents(skillSelect));

    // ── Level select rows ──────────────────────────────────────────────────
    let needFromPagination = false, needToPagination = false;
    let fromPrevPage = -1, fromNextPage = -1;
    let toPrevPage = -1, toNextPage = -1;

    if (skillId !== 'x' && catData.skills[skillId]) {
        const skillData = catData.skills[skillId];
        const levelKeys = getSkillLevelKeys(skillData);

        if (fromKey === 'x') {
            // Show from-level select with "Not Researched" as first option
            const fromLevelKeys = ['0', ...levelKeys.slice(0, -1)];
            const pf = Math.max(0, parseInt(pageFrom) || 0);
            const startFrom = pf * PAGE_SIZE;
            const sliceFrom = fromLevelKeys.slice(startFrom, startFrom + PAGE_SIZE);

            if (sliceFrom.length > 0) {
                container.addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`calc_wa_from_${resolvedGameType}_${cat}_${skillId}_${pf}_${userId}`)
                            .setPlaceholder(lc.placeholders.selectStartingLevel)
                            .addOptions(sliceFrom.map(key => ({
                                label: getLevelDisplay(key, lang),
                                value: key,
                                default: false
                            })))
                    )
                );

                if (fromLevelKeys.length > PAGE_SIZE) {
                    needFromPagination = true;
                    fromPrevPage = pf > 0 ? pf - 1 : -1;
                    fromNextPage = startFrom + PAGE_SIZE < fromLevelKeys.length ? pf + 1 : -1;
                }
            }
        } else {
            // from-level already chosen — show to-level select
            const fromIdx = fromKey === '0' ? -1 : levelKeys.indexOf(fromKey);
            const toKeys  = levelKeys.slice(fromIdx + 1);
            const pt      = Math.max(0, parseInt(pageTo) || 0);
            const startTo = pt * PAGE_SIZE;
            const sliceTo = toKeys.slice(startTo, startTo + PAGE_SIZE);

            if (sliceTo.length > 0) {
                container.addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`calc_wa_to_${resolvedGameType}_${cat}_${skillId}_${fromKey}_${pt}_${userId}`)
                            .setPlaceholder(lc.placeholders.selectTargetLevel)
                            .addOptions(sliceTo.map(key => ({
                                label: lc.levelDisplay.replace('{key}', key),
                                value: key,
                                default: key === toKey
                            })))
                    )
                );

                if (toKeys.length > PAGE_SIZE) {
                    needToPagination = true;
                    toPrevPage = pt > 0 ? pt - 1 : -1;
                    toNextPage = startTo + PAGE_SIZE < toKeys.length ? pt + 1 : -1;
                }
            }
        }
    }

    // ── Bottom action row: [◀Prev] [▶Next] [⚙ Buffs] [◀ Back] ──────────────
    const bottomButtons = [];

    if (needFromPagination) {
        const pf = Math.max(0, parseInt(pageFrom) || 0);
        if (fromPrevPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_wa_fprev_${resolvedGameType}_${cat}_${skillId}_${pf}_${userId}`).setLabel(lc.buttons.prev).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1019')));
        if (fromNextPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_wa_fnext_${resolvedGameType}_${cat}_${skillId}_${pf}_${userId}`).setLabel(lc.buttons.next).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1034')));
    }

    if (needToPagination) {
        const pt = Math.max(0, parseInt(pageTo) || 0);
        if (toPrevPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_wa_tprev_${resolvedGameType}_${cat}_${skillId}_${fromKey}_${pt}_${userId}`).setLabel(lc.buttons.prev).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1019')));
        if (toNextPage >= 0) bottomButtons.push(new ButtonBuilder().setCustomId(`calc_wa_tnext_${resolvedGameType}_${cat}_${skillId}_${fromKey}_${pt}_${userId}`).setLabel(lc.buttons.next).setStyle(ButtonStyle.Secondary).setEmoji(getComponentEmoji(emojiMap, '1034')));
    }

    bottomButtons.push(
        new ButtonBuilder()
            .setCustomId(`calc_wa_buffs_${resolvedGameType}_${cat}_${skillId}_${fromKey}_${toKey}_${userId}`)
            .setLabel(lc.buttons.buffs)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1035')),
        new ButtonBuilder()
            .setCustomId(`calc_wa_back_category_${resolvedGameType}_${userId}`)
            .setLabel(lc.buttons.back)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1002'))
    );

    container.addActionRowComponents(new ActionRowBuilder().addComponents(...bottomButtons));

    return container;
}

/**
 * Builds the aggregated results container for all accumulated upgrade entries.
 */
function buildResultsContainer(entries, buffs, userId, lang, activeState) {
    const lc             = lang.calculators.warAcademy;
    const gameType       = normalizeGameType(activeState?.gameType || entries[0]?.gameType, 'wos');
    const resourceLabels = getResourceLabels(lang, gameType);
    const { totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxResearchCenter, allOtherSkillReqs, allBuffs } = aggregateEntries(entries);
    const buffActive = hasAnyBuff(buffs);

    const lines = [lc.results.upgradePlan];

    // Per-entry upgrade summary
    lines.push(lc.results.skillsList);
    for (const e of entries) {
        lines.push(`  - ${getSkillDisplayName(e.cat, e.skillId, lang, gameType)}: ${getLevelDisplay(e.fromKey, lang)} → ${getLevelDisplay(e.toKey, lang)}`);
    }

    // Resources (non-zero only)
    const nonZero = Object.entries(totalRes).filter(([, v]) => v > 0);
    if (nonZero.length > 0) {
        lines.push(lc.results.resourcesRequired);
        for (const [res, amt] of nonZero) lines.push(`  - ${resourceLabels[res] || res}: **${formatNumber(amt)}**`);
    }

    // Research time
    lines.push(lc.results.researchTime);
    lines.push(lc.results.original.replace('{time}', formatSeconds(totalSeconds)));
    if (buffActive) lines.push(lc.results.withBuffs.replace('{time}', formatSeconds(reducedSeconds)));

    // Requirements — research center
    if (maxResearchCenter > 0) {
        lines.push(lc.results.requirements);
        lines.push(`  - ${lc.results.warAcademy}: ${getFurnaceReadable(maxResearchCenter, lang, gameType)}`);
    }

    // Other skill requirements
    const otherReqEntries = Object.entries(allOtherSkillReqs);
    if (otherReqEntries.length > 0) {
        if (maxResearchCenter <= 0) lines.push(lc.results.requirements);
        lines.push(lc.results.skillRequirements);
        for (const [sk, lv] of otherReqEntries) {
            lines.push(`  - ${getSkillDisplayName(entries[0].cat, sk, lang, gameType)}: ${lc.levelDisplay.replace('{key}', lv)}`);
        }
    }

    // Buff gained
    if (allBuffs.length > 0) {
        lines.push(lc.results.buffGained);
        for (const b of allBuffs) {
            lines.push(`  - ${b.name}: ${formatBuffAmount(b.name, b.amount)}`);
        }
    }

    // Applied speed buffs summary
    if (buffActive) {
        const resultBuffs = getWarAcademyResultBuffLocale(lang, gameType);
        const buffParts = [];
        if (buffs.researchSpeed > 0) buffParts.push(resultBuffs.researchSpeed.replace('{pct}', buffs.researchSpeed));
        if (buffs.vpBonus > 0)        buffParts.push(resultBuffs.vpBonus.replace('{pct}', buffs.vpBonus));
        lines.push(lc.results.buffsLine.replace('{parts}', buffParts.join('\n  - ')));
    }

    // Copy button
    const copyId   = encodeResultsCustomId(entries, userId);
    const emojiMap = getEmojiMapForUser(userId);
    const copyBtn  = new ButtonBuilder()
        .setCustomId(copyId ?? `calc_wa_copy_overflow_${userId}`)
        .setLabel(lc.buttons.copy)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!copyId)
        .setEmoji(getComponentEmoji(emojiMap, '1021'));

    // Remove button — opens a modal to select entries to remove
    const { cat: ac, skillId: as, fromKey: af, toKey: ak } = activeState || {};
    const removeBtn = new ButtonBuilder()
        .setCustomId(`calc_wa_remove_${gameType}_${ac || 'x'}_${as || 'x'}_${af || 'x'}_${ak || 'x'}_${userId}`)
        .setLabel(lc.buttons.remove)
        .setStyle(ButtonStyle.Danger);

    return new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
        .addActionRowComponents(new ActionRowBuilder().addComponents(copyBtn, removeBtn));
}

/**
 * Builds the plain-text copy summary (sent via DM).
 */
function buildCopySummary(entries, buffs, lang) {
    const lc             = lang.calculators.warAcademy;
    const gameType       = normalizeGameType(entries[0]?.gameType, 'wos');
    const resourceLabels = getResourceLabels(lang, gameType);
    const { totalRes, totalSeconds, reducedSeconds, totalNumLevels, maxResearchCenter, allOtherSkillReqs, allBuffs } = aggregateEntries(entries);
    const buffActive = hasAnyBuff(buffs);

    const lines = [lc.results.upgradePlan];

    lines.push(lc.results.skillsList);
    for (const e of entries) {
        lines.push(`  - ${getSkillDisplayName(e.cat, e.skillId, lang, gameType)}: ${getLevelDisplay(e.fromKey, lang)} → ${getLevelDisplay(e.toKey, lang)}`);
    }

    const nonZero = Object.entries(totalRes).filter(([, v]) => v > 0);
    if (nonZero.length > 0) {
        lines.push(lc.results.resourcesRequired);
        for (const [res, amt] of nonZero) lines.push(`  - ${resourceLabels[res] || res}: ${formatNumber(amt)}`);
    }

    lines.push(lc.results.researchTime);
    lines.push(lc.results.original.replace('{time}', formatSeconds(totalSeconds)));
    if (buffActive) lines.push(lc.results.withBuffs.replace('{time}', formatSeconds(reducedSeconds)));

    if (maxResearchCenter > 0) {
        lines.push(lc.results.requirements);
        lines.push(`  - ${lc.results.warAcademy}: ${getFurnaceReadable(maxResearchCenter, lang, gameType)}`);
    }

    const otherReqEntries = Object.entries(allOtherSkillReqs);
    if (otherReqEntries.length > 0) {
        if (maxResearchCenter <= 0) lines.push(lc.results.requirements);
        lines.push(lc.results.skillRequirements);
        for (const [sk, lv] of otherReqEntries) {
            lines.push(`  - ${getSkillDisplayName(entries[0].cat, sk, lang, gameType)}: ${lc.levelDisplay.replace('{key}', lv)}`);
        }
    }

    if (allBuffs.length > 0) {
        lines.push(lc.results.buffGained);
        for (const b of allBuffs) lines.push(`  - ${b.name}: ${formatBuffAmount(b.name, b.amount)}`);
    }

    if (buffActive) {
        const resultBuffs = getWarAcademyResultBuffLocale(lang, gameType);
        const buffParts = [];
        if (buffs.researchSpeed > 0) buffParts.push(resultBuffs.researchSpeed.replace('{pct}', buffs.researchSpeed));
        if (buffs.vpBonus > 0)        buffParts.push(resultBuffs.vpBonus.replace('{pct}', buffs.vpBonus));
        lines.push(lc.results.buffsLine.replace('{parts}', buffParts.join('\n  - ')));
    }

    return lines.join('\n');
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Bootstraps an interaction handler: verifies the button owner, extracts parts,
 * and resolves the user's current language.
 */
async function initHandler(interaction) {
    const parts  = interaction.customId.split('_');
    const userId = parts[parts.length - 1];
    if (!(await assertUserMatches(interaction, userId))) return null;
    const { lang } = getUserInfo(userId);
    return { parts, userId, lang };
}

/**
 * Handles the "War Academy" button on the /calculators panel.
 * CustomId: calc_main_wa_{userId}
 */
async function handleWarAcademyButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { userId, lang } = ctx;

        if (!checkFeatureAccess('calculators', interaction)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const catContainer = isMultiGameModeEnabled()
            ? buildGameSelectionContainer(userId, lang)
            : buildCategorySelectionContainer(userId, lang, getDefaultGameType());
        const updatedComponents = require('../../utility/commonFunctions').updateComponentsV2AfterSeparator(interaction, [catContainer]);
        await interaction.update({ components: updatedComponents, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleWarAcademyButton');
    }
}

async function handleGameSelection(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        const gameType = normalizeGameType(parts[3], getDefaultGameType());

        if (!checkFeatureAccess('calculators', interaction)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        await interaction.update({
            components: [buildCategorySelectionContainer(userId, lang, gameType)],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleGameSelection');
    }
}

/**
 * Handles category selection (Infantry / Marksman / Lancer).
 * Drops the original /calculators panel — from here the message has only 2 containers.
 * CustomId: calc_wa_cat_{i|m|l}_{userId}
 */
async function handleCategorySelection(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;

        if (!checkFeatureAccess('calculators', interaction)) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        // parts: ['calc', 'wa', 'cat', gameType, cat, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat = parts[4];
        const controlsContainer = buildControlsContainer(cat, 'x', 'x', 'x', 0, 0, userId, lang, gameType);
        await interaction.update({ components: [controlsContainer], flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleCategorySelection');
    }
}

/**
 * Handles skill selection from the select menu.
 * CustomId: calc_wa_select_{cat}_{userId}
 */
async function handleSkillSelect(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'select', gameType, cat, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat     = parts[4];
        const skillId = interaction.values[0];
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        await interaction.update({
            components: [buildControlsContainer(cat, skillId, 'x', 'x', 0, 0, userId, lang, gameType), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleSkillSelect');
    }
}

/**
 * Handles from-level selection.
 * CustomId: calc_wa_from_{cat}_{skillId}_{page}_{userId}
 */
async function handleFromLevelSelect(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'from', gameType, cat, skillId, page, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat     = parts[4];
        const skillId = parts[5];
        const fromKey = interaction.values[0];
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        await interaction.update({
            components: [buildControlsContainer(cat, skillId, fromKey, 'x', 0, 0, userId, lang, gameType), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleFromLevelSelect');
    }
}

/**
 * Handles to-level selection — triggers calculation and shows results.
 * CustomId: calc_wa_to_{cat}_{skillId}_{fromKey}_{page}_{userId}
 */
async function handleToLevelSelect(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'to', gameType, cat, skillId, fromKey, page, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat     = parts[4];
        const skillId = parts[5];
        const fromKey = parts[6];
        const toKey   = interaction.values[0];

        const buffs  = getUserBuffs(userId);
        const result = calculateUpgrade(getSkillData(cat, skillId, gameType), fromKey, toKey, buffs);

        if (!result) {
            return await interaction.reply({
                content: lang.calculators.warAcademy.errors.calcFailed,
                ephemeral: true
            });
        }

        // Decode existing entries, replace any existing one for the same skill, append new
        const existingEntries = getExistingEntries(interaction.message, buffs);
        const allEntries      = [...existingEntries.filter(e => !(e.gameType === gameType && e.cat === cat && e.skillId === skillId)), { gameType, cat, skillId, fromKey, toKey, result }];

        await interaction.update({
            components: [
                buildControlsContainer(cat, skillId, fromKey, toKey, 0, 0, userId, lang, gameType),
                buildResultsContainer(allEntries, buffs, userId, lang, { gameType, cat, skillId, fromKey, toKey })
            ],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleToLevelSelect');
    }
}

/**
 * Handles pagination for from-level select menu.
 * CustomId: calc_wa_fprev_{cat}_{skillId}_{curPage}_{userId}
 *           calc_wa_fnext_{cat}_{skillId}_{curPage}_{userId}
 */
async function handleFromLevelPage(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'fprev'|'fnext', gameType, cat, skillId, curPage, userId]
        const direction = parts[2];
        const gameType  = normalizeGameType(parts[3], getDefaultGameType());
        const cat       = parts[4];
        const skillId   = parts[5];
        const curPage   = parseInt(parts[6]) || 0;
        const newPage   = direction === 'fnext' ? curPage + 1 : Math.max(0, curPage - 1);
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        await interaction.update({
            components: [buildControlsContainer(cat, skillId, 'x', 'x', newPage, 0, userId, lang, gameType), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleFromLevelPage');
    }
}

/**
 * Handles pagination for to-level select menu.
 * CustomId: calc_wa_tprev_{cat}_{skillId}_{fromKey}_{curPage}_{userId}
 *           calc_wa_tnext_{cat}_{skillId}_{fromKey}_{curPage}_{userId}
 */
async function handleToLevelPage(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'tprev'|'tnext', gameType, cat, skillId, fromKey, curPage, userId]
        const direction = parts[2];
        const gameType  = normalizeGameType(parts[3], getDefaultGameType());
        const cat       = parts[4];
        const skillId   = parts[5];
        const fromKey   = parts[6];
        const curPage   = parseInt(parts[7]) || 0;
        const newPage   = direction === 'tnext' ? curPage + 1 : Math.max(0, curPage - 1);
        const existingResults = interaction.message.components.length > 1
            ? interaction.message.components.slice(1) : [];

        await interaction.update({
            components: [buildControlsContainer(cat, skillId, fromKey, 'x', 0, newPage, userId, lang, gameType), ...existingResults],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleToLevelPage');
    }
}

/**
 * Shows the buffs configuration modal.
 * Modal has 2 labels:
 *   1. VP Bonus (select 0/10/15%)
 *   2. Research Speed % (text input)
 * CustomId: calc_wa_buffs_{cat}_{skillId}_{fromKey}_{toKey}_{userId}
 */
async function handleBuffsButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId } = ctx;
        // parts: ['calc', 'wa', 'buffs', gameType, cat, skillId, fromKey, toKey, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat     = parts[4];
        const skillId = parts[5];
        const fromKey = parts[6];
        const toKey   = parts[7];

        const cur = getUserBuffs(userId);
        const lang = ctx.lang;
        const ml = getWarAcademyModalLocale(lang, gameType);

        const modal = new ModalBuilder()
            .setCustomId(`calc_wa_modal_${gameType}_${cat}_${skillId}_${fromKey}_${toKey}_${userId}`)
            .setTitle(ml.title);

        // ── 1. VP Bonus ───────────────────────────────────────────────────────
        const vpSelect = new StringSelectMenuBuilder()
            .setCustomId('wa_vp_bonus')
            .setPlaceholder(ml.vp.placeholder)
            .setRequired(false)
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel(ml.vp.off).setValue('0').setDefault(cur.vpBonus === 0),
                new StringSelectMenuOptionBuilder().setLabel(ml.vp.vp10).setValue('10').setDefault(cur.vpBonus === 10),
                new StringSelectMenuOptionBuilder().setLabel(ml.vp.vp15).setValue('15').setDefault(cur.vpBonus === 15)
            );
        const vpLabel = new LabelBuilder()
            .setLabel(ml.vp.label)
            .setStringSelectMenuComponent(vpSelect);

        // ── 2. Research Speed % ───────────────────────────────────────────────
        const speedInput = new TextInputBuilder()
            .setCustomId('wa_research_speed')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(ml.speed.placeholder)
            .setValue(cur.researchSpeed > 0 ? String(cur.researchSpeed) : '')
            .setRequired(false);
        const speedLabel = new LabelBuilder()
            .setLabel(ml.speed.label)
            .setDescription(ml.speed.description)
            .setTextInputComponent(speedInput);

        modal.addLabelComponents(vpLabel, speedLabel);

        await interaction.showModal(modal);
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuffsButton');
    }
}

/**
 * Saves buffs from the modal and recalculates if a full selection exists.
 * CustomId: calc_wa_modal_{cat}_{skillId}_{fromKey}_{toKey}_{userId}
 */
async function handleBuffsModal(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'modal', gameType, cat, skillId, fromKey, toKey, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat     = parts[4];
        const skillId = parts[5];
        const fromKey = parts[6];
        const toKey   = parts[7];

        const vpValues  = interaction.fields.getStringSelectValues('wa_vp_bonus');
        const rawSpeed  = interaction.fields.getTextInputValue('wa_research_speed').trim();

        const newBuffs = {
            vpBonus:       parseInt(vpValues[0] ?? '0') || 0,
            researchSpeed: Math.max(0, parseFloat(rawSpeed) || 0)
        };

        // Read existing buffs and merge WA-specific fields
        let existing = {};
        try {
            const row = userQueries.getBuffs(userId);
            if (row?.buffs) existing = JSON.parse(row.buffs);
        } catch { /* ignore */ }

        existing.waVpBonus       = newBuffs.vpBonus;
        existing.waResearchSpeed = newBuffs.researchSpeed;

        userQueries.upsertBuffs(userId, JSON.stringify(existing));

        const controlsContainer = buildControlsContainer(cat, skillId, fromKey, toKey, 0, 0, userId, lang, gameType);
        const entries           = getExistingEntries(interaction.message, newBuffs);
        const components        = entries.length > 0
            ? [controlsContainer, buildResultsContainer(entries, newBuffs, userId, lang, { gameType, cat, skillId, fromKey, toKey })]
            : [controlsContainer];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleBuffsModal');
    }
}

/**
 * Sends the upgrade summary as a DM (falls back to channel if DMs are closed).
 * CustomId: calc_wa_copy_{encoded}_{userId}
 */
async function handleCopyButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { userId, lang } = ctx;

        const buffs   = getUserBuffs(userId);
        const entries = decodeResultsEntries(interaction.customId, buffs);

        if (entries.length === 0) {
            return await interaction.reply({ content: lang.calculators.warAcademy.errors.noSummary, ephemeral: true });
        }

        const content = buildCopySummary(entries, buffs, lang);

        try {
            await interaction.user.send({ content });
            await interaction.reply({ content: lang.calculators.warAcademy.errors.dmSent, ephemeral: true });
        } catch {
            await interaction.reply({ content });
        }
    } catch (err) {
        await handleError(interaction, null, err, 'handleCopyButton');
    }
}

/**
 * Handles War Academy back navigation.
 */
async function handleBackButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        const target = parts[3];
        const gameType = normalizeGameType(parts[4], getDefaultGameType());
        let components;

        if (target === 'category') {
            components = [buildCategorySelectionContainer(userId, lang, gameType)];
        } else if (target === 'game') {
            components = [buildGameSelectionContainer(userId, lang)];
        } else {
            const { buildCalculatorsPanel } = require('../calculators');
            components = [buildCalculatorsPanel(userId)];
        }

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, null, err, 'handleWABackButton');
    }
}

/**
 * Shows a modal with a multi-select to remove entries from the plan.
 * CustomId: calc_wa_remove_{cat}_{skillId}_{fromKey}_{toKey}_{userId}
 */
async function handleRemoveButton(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'remove', gameType, cat, skillId, fromKey, toKey, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat     = parts[4];
        const skillId = parts[5];
        const fromKey = parts[6];
        const toKey   = parts[7];

        const buffs   = getUserBuffs(userId);
        const entries = getExistingEntries(interaction.message, buffs);

        if (entries.length === 0) {
            return await interaction.reply({ content: lang.calculators.warAcademy.errors.noSummary, ephemeral: true });
        }

        const lc = lang.calculators.warAcademy;
        const rm = lc.removeModal;

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('remove_entries')
            .setPlaceholder(rm.placeholder)
            .setMinValues(1)
            .setMaxValues(entries.length)
            .addOptions(entries.map((e, i) => {
                const name = getSkillDisplayName(e.cat, e.skillId, lang, e.gameType || gameType);
                return new StringSelectMenuOptionBuilder()
                    .setLabel(name)
                    .setValue(String(i));
            }));

        const label = new LabelBuilder()
            .setLabel(rm.label)
            .setStringSelectMenuComponent(selectMenu);

        const modal = new ModalBuilder()
            .setCustomId(`calc_wa_rmmodal_${gameType}_${cat}_${skillId}_${fromKey}_${toKey}_${userId}`)
            .setTitle(rm.title)
            .addLabelComponents(label);

        await interaction.showModal(modal);
    } catch (err) {
        await handleError(interaction, null, err, 'handleRemoveButton');
    }
}

/**
 * Processes removal of selected entries from the plan.
 * CustomId: calc_wa_rmmodal_{cat}_{skillId}_{fromKey}_{toKey}_{userId}
 */
async function handleRemoveModal(interaction) {
    try {
        const ctx = await initHandler(interaction);
        if (!ctx) return;
        const { parts, userId, lang } = ctx;
        // parts: ['calc', 'wa', 'rmmodal', gameType, cat, skillId, fromKey, toKey, userId]
        const gameType = normalizeGameType(parts[3], getDefaultGameType());
        const cat     = parts[4];
        const skillId = parts[5];
        const fromKey = parts[6];
        const toKey   = parts[7];

        const buffs     = getUserBuffs(userId);
        const entries   = getExistingEntries(interaction.message, buffs);
        const toRemove  = new Set(interaction.fields.getStringSelectValues('remove_entries'));
        const remaining = entries.filter((_, i) => !toRemove.has(String(i)));

        const controlsContainer = buildControlsContainer(cat, skillId, fromKey, toKey, 0, 0, userId, lang, gameType);
        const components = remaining.length > 0
            ? [controlsContainer, buildResultsContainer(remaining, buffs, userId, lang, { gameType, cat, skillId, fromKey, toKey })]
            : [controlsContainer];

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await handleError(interaction, null, err, 'handleRemoveModal');
    }
}

module.exports = {
    handleWarAcademyButton,
    handleGameSelection,
    handleCategorySelection,
    handleSkillSelect,
    handleFromLevelSelect,
    handleToLevelSelect,
    handleFromLevelPage,
    handleToLevelPage,
    handleBuffsButton,
    handleBuffsModal,
    handleCopyButton,
    handleBackButton,
    handleRemoveButton,
    handleRemoveModal
};
