const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { allianceQueries, playerQueries, processQueries } = require('../utility/database');
const { createProcess, updateProcessStatus, PROCESS_STATUS } = require('../Processes/createProcesses');
const { queueManager } = require('../Processes/queueManager');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { autoRefreshManager } = require('./refreshAlliance');
const { getUserInfo, assertUserMatches, handleError, hasPermission, updateComponentsV2AfterSeparator, getAlliancesForUserByGame, createGameSelectionComponents } = require('../utility/commonFunctions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');

/**
 * Creates a trigger refresh button
 * @param {string} userId - User ID for button custom ID
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder} The trigger refresh button
 */
function createTriggerRefreshButton(userId, lang) {
    return new ButtonBuilder()
        .setCustomId(`trigger_refresh_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.manualRefresh)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1033'));
}

/**
 * Handles the trigger refresh button click
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleTriggerRefreshButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2]; // trigger_refresh_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess && !hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        if (isMultiGameModeEnabled()) {
            const { components } = createGameSelectionComponents({
                interaction,
                lang,
                customIdPrefix: 'select_trigger_refresh_game',
                title: lang.alliance.refreshAlliance.content.title.base,
                description: lang.alliance.refreshAlliance.content.selectGameDescription
            });

            return await interaction.update({
                components,
                flags: MessageFlags.IsComponentsV2
            });
        }

        const availableAlliances = getAlliancesForUserByGame(adminData, getDefaultGameType(), PERMISSIONS.ALLIANCE_MANAGEMENT);

        // Filter alliances that have players
        const { alliances: alliancesWithPlayers } = getAlliancesWithPlayers(availableAlliances);

        if (alliancesWithPlayers.length === 0) {
            return await interaction.reply({
                content: lang.alliance.refreshAlliance.errors.noAlliances,
                ephemeral: true
            });
        }

        // Show alliance selection with pagination (page 0)
        await showTriggerRefreshAllianceSelection(interaction, 0, getDefaultGameType());

    } catch (error) {
        await handleError(interaction, lang, error, 'handleTriggerRefreshButton');
    }
}

/**
 * Shows alliance selection with pagination for trigger refresh
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {number} page - Current page number
 */
async function showTriggerRefreshAllianceSelection(interaction, page = 0, gameType = getDefaultGameType()) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    const resolvedGameType = normalizeGameType(gameType);

    // Get available alliances based on permissions
    const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
    const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT);

    if (!hasFullAccess && !hasAccess) {
        return await interaction.reply({
            content: lang.common.noPermission,
            ephemeral: true
        });
    }

    const availableAlliances = getAlliancesForUserByGame(adminData, resolvedGameType, PERMISSIONS.ALLIANCE_MANAGEMENT);

    // Filter alliances that have players
    const { alliances: alliancesWithPlayers, counts: playerCounts } = getAlliancesWithPlayers(availableAlliances);

    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliancesWithPlayers.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = alliancesWithPlayers.slice(startIndex, endIndex);

    // Create select menu options for current page
    const options = currentPageAlliances.map(alliance => {
        const playerCount = playerCounts.get(alliance.id) || 0;
        return {
            label: alliance.name,
            description: lang.alliance.refreshAlliance.selectMenu.selectAlliance.description
                .replace('{priority}', alliance.priority || 'N/A')
                .replace('{playerCount}', playerCount),
            value: `alliance_${alliance.id}`,
            emoji: getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1001')
        };
    });

    // Create select menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_trigger_refresh_${interaction.user.id}_${page}_${resolvedGameType}`)
        .setPlaceholder(lang.alliance.refreshAlliance.selectMenu.selectAlliance.placeholder)
        .setMinValues(1)
        .setMaxValues(Math.min(currentPageAlliances.length, 10)) // Max 10 selections
        .addOptions(options);

    const actionRow = [];
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const paginationRow = createUniversalPaginationButtons({
        feature: 'trigger_refresh',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [resolvedGameType]
    });

    actionRow.push(selectRow);

    if (paginationRow) {
        actionRow.push(paginationRow);
    }

    // Create Components v2 layout
    const container = [
        new ContainerBuilder()
            .setAccentColor(0x3498db) // Blue color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.refreshAlliance.content.title.base}\n` +
                    `${lang.alliance.refreshAlliance.content.description}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
                ...actionRow
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles alliance selection for trigger refresh
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleTriggerRefreshSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID and verify it matches
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // select_trigger_refresh_userId_page_gameType
        const gameType = customIdParts[5] || getDefaultGameType();
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Parse selected alliance IDs
        const selectedAllianceIds = interaction.values
            .filter(value => value.startsWith('alliance_'))
            .map(value => parseInt(value.split('_')[1], 10))
            .filter(id => !isNaN(id));

        if (selectedAllianceIds.length === 0) {
            return await interaction.reply({
                content: lang.alliance.refreshAlliance.errors.noValidAlliances,
                ephemeral: true
            });
        }

        const results = [];
        let successCount = 0;
        let cancelledAutoRefreshes = 0;
        let errorCount = 0;

        // Stop auto-refresh scheduling and cancel existing processes for selected alliances
        for (const allianceId of selectedAllianceIds) {
            try {
                const existingProcesses = processQueries.getProcessesByAction('auto_refresh')
                    .filter(p => Number(p.target) === allianceId && ['queued', 'active'].includes(p.status));

                if (existingProcesses.length > 0) {
                    // Complete existing auto-refresh processes
                    for (const process of existingProcesses) {
                        try {
                            await updateProcessStatus(process.id, PROCESS_STATUS.COMPLETED);
                            cancelledAutoRefreshes++;
                        } catch (cancelError) {
                            await handleError(interaction, lang, cancelError, `cancelAutoRefresh`, false);
                        }
                    }

                    // Stop auto-refresh scheduling
                    await autoRefreshManager.stopAutoRefresh(allianceId);
                    results.push(lang.alliance.refreshAlliance.content.autoRefreshStopped
                        .replace('{allianceId}', allianceId)
                        .replace('{cancelledCount}', cancelledAutoRefreshes.toString())
                    );
                }
            } catch (error) {
                await handleError(interaction, lang, error, `handleTriggerRefreshSelection_stopAutoRefresh`, false);
            }
        }

        // Create manual refresh processes
        for (const allianceId of selectedAllianceIds) {
            try {
                const alliance = allianceQueries.getAllianceByIdAny(allianceId);
                if (!alliance) {
                    results.push(lang.alliance.refreshAlliance.errors.allianceNotFound.replace('{allianceId}', allianceId));
                    errorCount++;
                    continue;
                }

                // Get players for this alliance
                const players = playerQueries.getPlayersByAlliance(allianceId, alliance.game_type);
                if (players.length === 0) {
                    results.push(lang.alliance.refreshAlliance.errors.allianceHasNoPlayers.replace('{allianceId}', allianceId));
                    continue;
                }

                // Create player IDs string
                const playerIds = players.map(player => player.fid).join(',');

                // Create refresh process with higher priority than auto-refresh
                const processResult = await createProcess({
                    admin_id: interaction.user.id,
                    alliance_id: allianceId,
                    player_ids: playerIds,
                    action: 'refresh', // This uses REFRESH priority (300000) vs AUTO_REFRESH (400000)
                    game_type: alliance.game_type
                });

                // Queue the process for execution
                await queueManager.manageQueue(processResult);

                results.push(lang.alliance.refreshAlliance.content.allianceSuccess
                    .replace('{allianceName}', alliance.name)
                    .replace('{playerCount}', players.length));
                successCount++;

            } catch (error) {
                await handleError(interaction, lang, error, `handleTriggerRefreshSelection_createProcess`, false);
                results.push(lang.alliance.refreshAlliance.errors.allianceError
                    .replace('{allianceId}', allianceId)
                    .replace('{errorMessage}', error.message));
                errorCount++;
            }
        }

        // Create result container using Components v2
        const container = [
            new ContainerBuilder()
                .setAccentColor(successCount > 0 ? 0x00ff00 : 0xff0000)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.alliance.refreshAlliance.content.title.results)
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(results.join('\n'))
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, `handleTriggerRefreshSelection`);
    }
}

/**
 * Handles trigger refresh pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleTriggerRefreshPagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);
        const gameType = contextData[0] || getDefaultGameType();

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Show new page
        await showTriggerRefreshAllianceSelection(interaction, newPage, gameType);

    } catch (error) {
        await handleError(interaction, lang, error, 'handleTriggerRefreshPagination');
    }
}

/**
 * Gets alliances with players and their counts efficiently
 * @param {Array} availableAlliances - Array of available alliances
 * @returns {Object} { alliances: filtered alliances with players, counts: Map of allianceId -> playerCount }
 */
function getAlliancesWithPlayers(availableAlliances) {
    const playerCounts = new Map();
    for (const alliance of availableAlliances) {
        const count = playerQueries.getPlayersByAlliance(alliance.id, alliance.game_type).length;
        playerCounts.set(alliance.id, count);
    }

    const alliancesWithPlayers = availableAlliances.filter(alliance => (playerCounts.get(alliance.id) || 0) > 0);
    return { alliances: alliancesWithPlayers, counts: playerCounts };
}

async function handleTriggerRefreshGameSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[4]; // select_trigger_refresh_game_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.ALLIANCE_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const gameType = normalizeGameType(interaction.values[0], null);
        if (!gameType) {
            return await interaction.reply({
                content: lang.alliance.refreshAlliance.errors.invalidGameType,
                ephemeral: true
            });
        }

        const availableAlliances = getAlliancesForUserByGame(adminData, gameType, PERMISSIONS.ALLIANCE_MANAGEMENT);
        const { alliances: alliancesWithPlayers } = getAlliancesWithPlayers(availableAlliances);

        if (alliancesWithPlayers.length === 0) {
            return await interaction.reply({
                content: lang.alliance.refreshAlliance.errors.noAlliancesForGame,
                ephemeral: true
            });
        }

        await showTriggerRefreshAllianceSelection(interaction, 0, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleTriggerRefreshGameSelection');
    }
}

module.exports = {
    createTriggerRefreshButton,
    handleTriggerRefreshButton,
    handleTriggerRefreshPagination,
    handleTriggerRefreshSelection,
    handleTriggerRefreshGameSelection
};
