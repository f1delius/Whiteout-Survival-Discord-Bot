const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const { allianceQueries, playerQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getUserInfo, assertUserMatches, handleError, hasPermission, updateComponentsV2AfterSeparator, createAllianceSelectionComponents, createGameSelectionComponents, getAlliancesForUserByGame } = require('../utility/commonFunctions');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');
const { getEmojiMapForUser, getComponentEmoji } = require('../utility/emojis');

const PLAYERS_PER_PAGE = 10;

function buildPlayerCountMap(alliances) {
    const playerCountMap = {};
    for (const alliance of alliances) {
        playerCountMap[alliance.id] = playerQueries.getPlayersByAllianceId(alliance.id, alliance.game_type).length;
    }
    return playerCountMap;
}

/**
 * Creates the view players button for the player management panel
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} View players button
 */
function createViewPlayersButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`view_players_${userId}`)
        .setLabel(lang.players.mainPage.buttons.viewPlayers)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1049'));
}


/**
 * Creates the alliance selection container using the shared utility
 * @param {import('discord.js').Interaction} interaction
 * @param {Array} alliances - Alliances with players
 * @param {Object} lang - Language object
 * @param {number} page - Current page (default 0)
 * @returns {{ components: Array }}
 */
function createAllianceSelectionContainer(interaction, alliances, lang, playerCountMap, page = 0, gameType = null) {
    const resolvedGameType = normalizeGameType(gameType, null);

    return createAllianceSelectionComponents({
        interaction,
        alliances,
        lang,
        page,
        customIdPrefix: 'view_players_alliance_select',
        feature: 'view_players',
        subtype: 'alliance',
        placeholder: lang.players.viewPlayers.selectMenu.allianceSelect.placeholder,
        title: lang.players.viewPlayers.content.title.base,
        description: lang.players.viewPlayers.content.description.base,
        accentColor: 2417109, // Blue
        showAll: false,
        contextData: resolvedGameType ? [resolvedGameType] : [],
        optionMapper: (alliance) => ({
            label: alliance.name,
            value: alliance.id.toString(),
            description: lang.players.viewPlayers.selectMenu.allianceSelect.description
                .replace('{alliancePriority}', alliance.priority)
                .replace('{playerCount}', playerCountMap[alliance.id] || 0),
            emoji: getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1001')
        })
    });
}


/**
 * Builds the player-list container for the given page
 * @param {import('discord.js').Interaction} interaction
 * @param {Array} players - All players in the alliance (pre-filtered)
 * @param {Object} lang - Language object
 * @param {Object} alliance - Alliance object
 * @param {number} page - Current page (0-indexed)
 * @returns {{ components: Array }}
 */
function createPlayerListContainer(interaction, players, lang, alliance, page = 0) {
    // FID is now the only profile identity returned by the redemption service.
    const sortedPlayers = Array.isArray(players)
        ? [...players].sort((a, b) => Number(a.fid) - Number(b.fid))
        : [];

    const totalPages = Math.max(1, Math.ceil(sortedPlayers.length / PLAYERS_PER_PAGE));
    const startIndex = page * PLAYERS_PER_PAGE;
    const currentPagePlayers = sortedPlayers.slice(startIndex, startIndex + PLAYERS_PER_PAGE);
    // Build player list text
    const playerLines = currentPagePlayers.map(player =>
        lang.players.viewPlayers.content.playerField.value
            .replace('{fid}', player.fid)
            .replace('{state}', player.state || 'Unknown')
    );

    const titleText = lang.players.viewPlayers.content.title.playerList
        .replace('{allianceName}', alliance.name);
    const pageInfo = lang.pagination.text.pageInfo
        .replace('{current}', page + 1)
        .replace('{total}', totalPages);

    const displayText = [
        titleText,
        playerLines.join('\n'),
        '',
        pageInfo
    ].join('\n');

    // Pagination row (null when only 1 page)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'view_players',
        subtype: 'player',
        userId: interaction.user.id,
        currentPage: page,
        totalPages,
        lang,
        contextData: [alliance.id]
    });

    const container = new ContainerBuilder()
        .setAccentColor(2417109) // Blue
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(displayText)
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

    if (paginationRow) {
        container.addActionRowComponents(paginationRow);
    }

    const newSection = [container];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Handles the view players button — shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleViewPlayersButton(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2]; // view_players_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        if (isMultiGameModeEnabled()) {
            const { components } = createGameSelectionComponents({
                interaction,
                lang,
                customIdPrefix: 'select_view_players_game',
                title: lang.players.viewPlayers.content.title.base,
                description: lang.players.viewPlayers.content.selectGameDescription
            });

            return await interaction.update({
                components,
                flags: MessageFlags.IsComponentsV2
            });
        }

        const allAlliances = getAlliancesForUserByGame(adminData, getDefaultGameType(), PERMISSIONS.PLAYER_MANAGEMENT);
        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Filter to alliances that have at least one player
        const playerCountMap = buildPlayerCountMap(allAlliances);

        const alliancesWithPlayers = allAlliances.filter(a => (playerCountMap[a.id] || 0) > 0);
        if (alliancesWithPlayers.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noAvailableAlliances,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(
            interaction,
            alliancesWithPlayers,
            lang,
            playerCountMap,
            0,
            getDefaultGameType()
        );
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleViewPlayersButton');
    }
}

/**
 * Handles pagination on the alliance selection screen
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleViewPlayersAlliancePagination(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(
            interaction.customId,
            isMultiGameModeEnabled() ? 1 : 0
        );

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const gameType = normalizeGameType(contextData[0] || getDefaultGameType());
        const allAlliances = getAlliancesForUserByGame(adminData, gameType, PERMISSIONS.PLAYER_MANAGEMENT);
        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: isMultiGameModeEnabled()
                    ? lang.players.viewPlayers.errors.noAssignedAlliancesForGame
                    : lang.players.viewPlayers.errors.noAssignedAlliances,
                ephemeral: true
            });
        }
        const playerCountMap = buildPlayerCountMap(allAlliances);

        const alliancesWithPlayers = allAlliances.filter(a => (playerCountMap[a.id] || 0) > 0);
        if (alliancesWithPlayers.length === 0) {
            return await interaction.reply({
                content: isMultiGameModeEnabled()
                    ? lang.players.viewPlayers.errors.noAvailableAlliancesForGame
                    : lang.players.viewPlayers.errors.noAvailableAlliances,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(interaction, alliancesWithPlayers, lang, playerCountMap, newPage, gameType);
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleViewPlayersAlliancePagination');
    }
}

/**
 * Handles game selection before alliance selection in both mode
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleViewPlayersGameSelection(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[4]; // select_view_players_game_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedGameType = normalizeGameType(interaction.values[0], null);
        if (!selectedGameType) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.invalidGameType,
                ephemeral: true
            });
        }

        const allAlliances = getAlliancesForUserByGame(adminData, selectedGameType, PERMISSIONS.PLAYER_MANAGEMENT);
        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noAssignedAlliancesForGame,
                ephemeral: true
            });
        }

        const playerCountMap = buildPlayerCountMap(allAlliances);
        const alliancesWithPlayers = allAlliances.filter(a => (playerCountMap[a.id] || 0) > 0);
        if (alliancesWithPlayers.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noAvailableAlliancesForGame,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(
            interaction,
            alliancesWithPlayers,
            lang,
            playerCountMap,
            0,
            selectedGameType
        );
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleViewPlayersGameSelection');
    }
}

/**
 * Handles alliance selection from the dropdown — shows player list (page 0)
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleViewPlayersAllianceSelection(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // customId: view_players_alliance_select_{userId}_{page}_{gameType?}
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4];
        const selectedGameType = normalizeGameType(customIdParts[6], null);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        if (selectedGameType && alliance.game_type !== selectedGameType) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.invalidGameType,
                ephemeral: true
            });
        }

        const players = playerQueries.getPlayersByAllianceId(allianceId, alliance.game_type);
        if (players.length === 0) {
            return await interaction.reply({
                content: lang.players.viewPlayers.errors.noPlayersInAlliance,
                ephemeral: true
            });
        }

        const { components } = createPlayerListContainer(interaction, players, lang, alliance, 0);
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleViewPlayersAllianceSelection');
    }
}

/**
 * Handles pagination on the player list screen
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleViewPlayersPlayerPagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // contextData[0] = allianceId
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allianceId = parseInt(contextData[0]);
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        const players = playerQueries.getPlayersByAllianceId(allianceId, alliance.game_type);

        const { components } = createPlayerListContainer(interaction, players, lang, alliance, newPage);
        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleViewPlayersPlayerPagination');
    }
}

module.exports = {
    createViewPlayersButton,
    handleViewPlayersButton,
    handleViewPlayersGameSelection,
    handleViewPlayersAlliancePagination,
    handleViewPlayersAllianceSelection,
    handleViewPlayersPlayerPagination
};
