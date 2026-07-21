const {
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { allianceQueries, giftCodeQueries, playerQueries, systemLogQueries } = require('../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { createRedeemProcess } = require('./redeemFunction');
const { parseGameScopedGiftCode } = require('./gameScopedGiftCode');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, handleError, getUserInfo, assertUserMatches, updateComponentsV2AfterSeparator, getAlliancesForUserByGame, createGameSelectionComponents } = require('../utility/commonFunctions');
const { formatAllianceStateDescription } = require('../Alliance/allianceStateDescription');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');
const { getActiveGameTypes, isMultiGameModeEnabled, getDefaultGameType } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');

function getScopedActiveGiftCodes(gameType = null) {
    const resolvedGameType = normalizeGameType(gameType, null);
    const activeGiftCodes = [];

    for (const activeGameType of getActiveGameTypes()) {
        if (resolvedGameType && activeGameType !== resolvedGameType) continue;

        const gameGiftCodes = giftCodeQueries.getAllGiftCodes(activeGameType)
            .filter(code => code.status === 'active')
            .map(code => ({
                ...code,
                game_type: code.game_type || activeGameType
            }));

        activeGiftCodes.push(...gameGiftCodes);
    }

    return activeGiftCodes;
}

function getRedeemAlliancesForGame(adminData, gameType) {
    return getAlliancesForUserByGame(adminData, gameType, PERMISSIONS.GIFT_CODE_MANAGEMENT);
}

function filterAlliancesWithPlayers(alliances, gameType) {
    const allianceIds = alliances.map(a => a.id);
    const playerCountResults = allianceIds.length > 0
        ? playerQueries.getPlayerCountsByAllianceIds(allianceIds, gameType)
        : [];

    const alliancesWithPlayers = new Set(playerCountResults.map(row => row.alliance_id));
    return alliances.filter(alliance => alliancesWithPlayers.has(alliance.id));
}

function buildGiftCodeOptionValue(giftCode) {
    const gameType = giftCode.game_type || 'wos';
    return isMultiGameModeEnabled()
        ? `${gameType}:${giftCode.gift_code}`
        : giftCode.gift_code;
}

/**
 * Creates a manual redeem gift code button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The manual redeem button
 */
function createManualRedeemButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`manual_redeem_gift_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.useGiftCode)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1043'));
}

/**
 * Handles manual redeem button - shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleManualRedeemButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        // Extract and verify user ID
        const expectedUserId = interaction.customId.split('_')[3];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const playerCount = playerQueries.getAllPlayers();
        if (playerCount.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noPlayers,
                ephemeral: true
            });
        }

        if (isMultiGameModeEnabled()) {
            const { components } = createGameSelectionComponents({
                interaction,
                lang,
                customIdPrefix: 'select_manual_redeem_game',
                title: lang.giftCode.redeemGiftCode.content.title.base,
                description: lang.giftCode.redeemGiftCode.content.selectGameDescription
            });

            return await interaction.update({
                components,
                flags: MessageFlags.IsComponentsV2
            });
        }

        const selectedGameType = getDefaultGameType();

        // check if there is any giftcode available, if not, return error
        const allGiftCodes = getScopedActiveGiftCodes(selectedGameType);
        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noGiftCodes,
                ephemeral: true
            });
        }

        let alliances = getRedeemAlliancesForGame(adminData, selectedGameType);
        alliances = filterAlliancesWithPlayers(alliances, selectedGameType);

        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noAlliances,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(
            alliances,
            interaction.user.id,
            lang,
            0,
            hasFullAccess,
            interaction,
            selectedGameType
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleManualRedeemButton');
    }
}

async function handleManualRedeemGameSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[4]; // select_manual_redeem_game_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedGameType = normalizeGameType(interaction.values[0], null);
        if (!selectedGameType) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.invalidGameType,
                ephemeral: true
            });
        }

        const allGiftCodes = getScopedActiveGiftCodes(selectedGameType);
        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noGiftCodesForGame,
                ephemeral: true
            });
        }

        let alliances = getRedeemAlliancesForGame(adminData, selectedGameType);
        alliances = filterAlliancesWithPlayers(alliances, selectedGameType);

        if (alliances.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noAlliancesForGame,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(
            alliances,
            interaction.user.id,
            lang,
            0,
            hasFullAccess,
            interaction,
            selectedGameType
        );

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleManualRedeemGameSelection');
    }
}

/**
 * Creates alliance selection embed with pagination
 * @param {Array} alliances - Array of alliance objects
 * @param {string} userId - User ID
 * @param {Object} lang - Language object
 * @param {number} page - Current page number
 * @param {boolean} isOwnerOrFullAccess - Whether user is owner or has full access
 * @returns {Object} Embed and components
 */
function createAllianceSelectionContainer(alliances, userId, lang, page = 0, isOwnerOrFullAccess = false, interaction, gameType = null) {
    const resolvedGameType = normalizeGameType(gameType, null);
    const itemsPerPage = 24;
    const totalPages = Math.max(1, Math.ceil(alliances.length / itemsPerPage));
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = alliances.slice(startIndex, endIndex);

    // Pre-fetch player counts for all alliances on this page (and overall for totals)
    const allianceIds = alliances.map(a => a.id);
    const playerCountResults = allianceIds.length > 0 && resolvedGameType
        ? playerQueries.getPlayerCountsByAllianceIds(allianceIds, resolvedGameType)
        : [];

    const playerCounts = new Map();
    playerCountResults.forEach(row => {
        playerCounts.set(row.alliance_id, row.player_count);
    });

    const totalPlayers = playerCountResults.reduce((sum, row) => sum + row.player_count, 0);

    // Create dropdown options
    const options = [];

    // Add "All Alliances" option for owner/full access users on first page
    if (isOwnerOrFullAccess && page === 0) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(lang.giftCode.redeemGiftCode.selectMenu.selectAlliance.allAlliances)
                .setValue('ALL_ALLIANCES')
                .setDescription(`Select all ${alliances.length} alliances (${totalPlayers} total players)`)
                .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1039'))
        );
    }

    // Add individual alliance options
    const allianceOptions = currentPageAlliances.map(alliance => {
        const playerCount = playerCounts.get(alliance.id) || 0;
        return new StringSelectMenuOptionBuilder()
            .setLabel(alliance.name)
            .setValue(alliance.id.toString())
            .setDescription(formatAllianceStateDescription(alliance, lang, lang.giftCode.redeemGiftCode.selectMenu.selectAlliance.description
                .replace('{priority}', alliance.priority)
                .replace('{playerCount}', playerCount)))
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1001'));
    });

    options.push(...allianceOptions);

    // Create dropdown menu (multi-select)
    const allianceSelect = new StringSelectMenuBuilder()
        .setCustomId(`manual_redeem_alliance_select_${userId}_${page}${resolvedGameType ? `_${resolvedGameType}` : ''}`)
        .setPlaceholder(lang.giftCode.redeemGiftCode.selectMenu.selectAlliance.placeholder)
        .setMinValues(1)
        .setMaxValues(Math.min(options.length, 25)) // Discord max is 25
        .addOptions(options);

    const actionRows = [];

    // Add dropdown menu first
    actionRows.push(new ActionRowBuilder().addComponents(allianceSelect));

    // Add pagination buttons if needed
    const paginationRow = createUniversalPaginationButtons({
        feature: 'manual_redeem_alliance',
        userId: userId,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: resolvedGameType ? [resolvedGameType] : []
    });
    if (paginationRow) {
        actionRows.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109) // blue color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.giftCode.redeemGiftCode.content.title.base}\n` +
                    `${lang.giftCode.redeemGiftCode.content.description.base}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1))
                        .replace('{total}', totalPages)}`
                )
            ).addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addActionRowComponents(
                actionRows
            ),
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);


    return { components: content };
}

/**
 * Handles alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleAllianceSelectionPagination(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, isMultiGameModeEnabled() ? 1 : 0);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedGameType = normalizeGameType(contextData[0] || getDefaultGameType());
        let alliances = getRedeemAlliancesForGame(adminData, selectedGameType);
        alliances = filterAlliancesWithPlayers(alliances, selectedGameType);

        const { components } = createAllianceSelectionContainer(
            alliances,
            userId,
            lang,
            newPage,
            hasFullAccess,
            interaction,
            selectedGameType
        );

        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleAllianceSelectionPagination');
    }
}

/**
 * Handles alliance selection from dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleAllianceSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        // Extract user ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // manual_redeem_alliance_select_userId_page
        const selectedGameType = normalizeGameType(customIdParts[6] || getDefaultGameType());

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get selected alliance IDs
        const selectedAllianceIds = interaction.values;

        // Handle "All Alliances" selection
        let finalAllianceIds = selectedAllianceIds;
        if (selectedAllianceIds.includes('ALL_ALLIANCES')) {
            let allAlliances = getRedeemAlliancesForGame(adminData, selectedGameType);
            finalAllianceIds = allAlliances.map(alliance => alliance.id.toString());
        }

        // Get active gift codes
        const activeGiftCodes = getScopedActiveGiftCodes(selectedGameType);

        if (activeGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.redeemGiftCode.errors.noActiveGiftCodes,
                ephemeral: true,
            });
        }

        const { components } = createGiftCodeSelectionContainer(
            activeGiftCodes,
            finalAllianceIds,
            interaction.user.id,
            lang,
            0,
            interaction,
            selectedGameType
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleAllianceSelection');
    }
}

/**
 * Creates gift code selection embed with pagination
 * @param {Array} giftCodes - Array of active gift code objects
 * @param {Array} allianceIds - Selected alliance IDs
 * @param {string} userId - User ID
 * @param {Object} lang - Language object
 * @param {number} page - Current page number
 * @returns {Object} container and components
 */
function createGiftCodeSelectionContainer(giftCodes, allianceIds, userId, lang, page = 0, interaction, gameType = null) {
    const resolvedGameType = normalizeGameType(gameType, null);
    const itemsPerPage = 24;
    const totalPages = Math.max(1, Math.ceil(giftCodes.length / itemsPerPage));
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageCodes = giftCodes.slice(startIndex, endIndex);

    // Get alliance names with a single batch query
    const allianceIdsNumeric = allianceIds.map(id => Number(id));
    const allianceRows = allianceIdsNumeric.length > 0 && resolvedGameType
        ? allianceQueries.getAlliancesByIds(allianceIdsNumeric, resolvedGameType)
        : [];
    const allianceNameMap = new Map(allianceRows.map(a => [a.id, a.name]));

    const allianceNames = allianceIdsNumeric
        .map(id => allianceNameMap.get(id) || `ID:${id}`)
        .join(', ');

    // Create dropdown options
    const options = [];
    const emojiMap = getEmojiMapForUser(userId);

    // Add "All Gift Codes" option on first page
    if (page === 0) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(lang.giftCode.redeemGiftCode.selectMenu.selectGiftCode.allGiftCodes)
                .setValue('ALL_GIFT_CODES')
                .setDescription(`Select all ${giftCodes.length} active gift codes`)
                .setEmoji(getComponentEmoji(emojiMap, '1039'))
        );
    }

    // Add individual gift code options
    const giftCodeOptions = currentPageCodes.map(code => {
        const vipLabel = code.is_vip ? lang.giftCode.redeemGiftCode.content.vip : '';
        const sourceLabel = code.source === 'api' ? ` ${lang.giftCode.redeemGiftCode.content.api}` : ` ${lang.giftCode.redeemGiftCode.content.manual}`;
        const gameLabel = isMultiGameModeEnabled() ? `[${String(code.game_type || 'wos').toUpperCase()}] ` : '';
        return new StringSelectMenuOptionBuilder()
            .setLabel(`${gameLabel}${vipLabel} ${code.gift_code}`.trim())
            .setValue(buildGiftCodeOptionValue(code))
            .setDescription(lang.giftCode.redeemGiftCode.selectMenu.selectGiftCode.description
                .replace('{source}', sourceLabel)
                .replace('{date}', new Date(code.date).toLocaleDateString()))
            .setEmoji(getComponentEmoji(emojiMap, '1013'));
    });

    options.push(...giftCodeOptions);

    // Create dropdown menu
    const giftCodeSelect = new StringSelectMenuBuilder()
        .setCustomId(`manual_redeem_code_select_${userId}_${allianceIds.join('-')}_${page}${resolvedGameType ? `_${resolvedGameType}` : ''}`)
        .setPlaceholder(lang.giftCode.redeemGiftCode.selectMenu.selectGiftCode.placeholder)
        .addOptions(options);

    const actionRows = [];

    // Add dropdown menu first
    actionRows.push(new ActionRowBuilder().addComponents(giftCodeSelect));

    // Add pagination buttons if needed
    const paginationRow = createUniversalPaginationButtons({
        feature: 'manual_redeem_code',
        userId: userId,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [allianceIds.join('-'), ...(resolvedGameType ? [resolvedGameType] : [])]
    });
    if (paginationRow) {
        actionRows.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(0x2ecc71) // Green color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.giftCode.redeemGiftCode.content.title.selectGiftCode}\n` +
                    `${lang.giftCode.redeemGiftCode.content.description.selectGiftCode.replace('{alliances}', allianceNames)}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1))
                        .replace('{total}', totalPages)}`
                )
            ).addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(
                actionRows
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    return { components: content };
}

/**
 * Handles gift code selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleGiftCodeSelectionPagination(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        // Parse pagination with alliance IDs as context
        const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, isMultiGameModeEnabled() ? 2 : 1);

        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Context data contains alliance IDs joined with '-'
        const allianceIds = contextData[0].split('-');
        const selectedGameType = normalizeGameType(contextData[1] || getDefaultGameType());

        const activeGiftCodes = getScopedActiveGiftCodes(selectedGameType);

        const { components } = createGiftCodeSelectionContainer(
            activeGiftCodes,
            allianceIds,
            userId,
            lang,
            newPage,
            interaction,
            selectedGameType
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleGiftCodeSelectionPagination');
    }
}

/**
 * Handles gift code selection and starts redemption
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleGiftCodeSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        // Extract data from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // manual_redeem_code_select_userId_allianceIds_page
        const allianceIdsStr = customIdParts[5];
        const selectedGameType = normalizeGameType(customIdParts[7] || getDefaultGameType());

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;
        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedGiftCode = interaction.values[0];
        const allianceIds = allianceIdsStr.split('-').map(id => parseInt(id));

        // Handle "All Gift Codes" selection
        let giftCodesToRedeem = [];
        if (selectedGiftCode === 'ALL_GIFT_CODES') {
            if (hasFullAccess) {
                // Get all active gift codes
                giftCodesToRedeem = getScopedActiveGiftCodes(selectedGameType);
            } else {
                // Unauthorized attempt to use ALL_GIFT_CODES without full access
                return await interaction.reply({
                    content: lang.common.noPermission,
                    ephemeral: true
                });
            }
        } else {
            // Single gift code selection
            const { gameType, giftCode, error } = parseGameScopedGiftCode(selectedGiftCode, {
                strictBothMode: false
            });

            if (error) {
                return await interaction.reply({
                    content: error,
                    ephemeral: true,
                });
            }

            const giftCodeData = giftCodeQueries.getGiftCode(giftCode, gameType);
            if (giftCodeData && giftCodeData.status === 'active' && normalizeGameType(giftCodeData.game_type || gameType) === selectedGameType) {
                giftCodesToRedeem = [{
                    ...giftCodeData,
                    game_type: giftCodeData.game_type || gameType
                }];
            } else {
                return await interaction.reply({
                    content: lang.giftCode.redeemGiftCode.errors.invalidGiftCode,
                    ephemeral: true,
                });
            }
        }

        // Start redemption processes for each alliance and gift code combination
        const processResults = [];

        for (const allianceId of allianceIds) {
            const alliance = allianceQueries.getAllianceById(allianceId, selectedGameType);
            if (!alliance) continue;

            const players = playerQueries.getPlayersByAllianceId(allianceId, selectedGameType);
            if (players.length === 0) continue;

            // Create redeem processes for each gift code
            for (const giftCode of giftCodesToRedeem) {
                const gameType = giftCode.game_type || 'wos';

                // Create redeem data
                const redeemData = players.map(player => ({
                    id: player.fid,
                    giftCode: giftCode.gift_code,
                    status: 'redeem'
                }));

                // Create alliance context for progress tracking
                const allianceContext = {
                    id: alliance.id,
                    name: alliance.name,
                    channelId: alliance.channel_id,
                    guildId: interaction.guildId,
                    gameType
                };

                // Create redeem process
                const result = await createRedeemProcess(redeemData, {
                    adminId: interaction.user.id,
                    allianceContext: allianceContext,
                    gameType
                });

                processResults.push({
                    alliance: alliance.name,
                    giftCode: giftCode.gift_code,
                    success: result.success,
                    processId: result.processId,
                    message: result.message
                });
            }
        }

        // Create summary embed
        const totalProcesses = processResults.length;
        const successfulProcesses = processResults.filter(r => r.success).length;
        const displayCode = selectedGiftCode === 'ALL_GIFT_CODES' ?
            `${giftCodesToRedeem.length} gift codes` : giftCodesToRedeem[0]?.gift_code || selectedGiftCode;

        const container = [
            new ContainerBuilder()
                .setAccentColor(successfulProcesses === totalProcesses ? 0x2ecc71 : 0xf39c12) // Green or Orange color
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.redeemGiftCode.content.title.success}\n` +
                        `${lang.giftCode.redeemGiftCode.content.description.success
                            .replace('{code}', displayCode)
                            .replace('{count}', allianceIds.length.toString())}\n` +

                        `${lang.giftCode.redeemGiftCode.content.summeryField.name}\n` +
                        `${lang.giftCode.redeemGiftCode.content.summeryField.value
                            .replace('{total}', totalProcesses.toString())
                            .replace('{success}', successfulProcesses.toString())}`
                    )
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleGiftCodeSelection');
    }
}

module.exports = {
    createManualRedeemButton,
    handleManualRedeemButton,
    handleManualRedeemGameSelection,
    handleAllianceSelectionPagination,
    handleAllianceSelection,
    handleGiftCodeSelectionPagination,
    handleGiftCodeSelection
};
