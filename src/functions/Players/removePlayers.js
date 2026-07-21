const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    LabelBuilder
} = require('discord.js');
const { randomBytes } = require('node:crypto');
const { allianceQueries, playerQueries, adminLogQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getUserInfo, assertUserMatches, handleError, hasPermission, updateComponentsV2AfterSeparator, createAllianceSelectionComponents, createGameSelectionComponents, getAlliancesForUserByGame } = require('../utility/commonFunctions');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');
const { getEmojiMapForUser, getComponentEmoji } = require('../utility/emojis');

function buildPlayerCountMap(alliances) {
    const playerCountMap = {};
    for (const alliance of alliances) {
        playerCountMap[alliance.id] = playerQueries.getPlayersByAllianceId(alliance.id, alliance.game_type).length;
    }
    return playerCountMap;
}

function createRemovePlayersSessionToken() {
    return randomBytes(6).toString('base64url');
}

function setRemovePlayersSession(client, userId, sessionData) {
    client.tempRemoveData = client.tempRemoveData || {};
    const token = createRemovePlayersSessionToken();
    client.tempRemoveData[userId] = {
        ...sessionData,
        token,
        createdAt: Date.now()
    };
    return client.tempRemoveData[userId];
}

function getRemovePlayersSession(client, userId, token) {
    const session = client.tempRemoveData?.[userId];
    if (!session) return null;
    if (token && session.token !== token) return null;
    return session;
}

/**
 * Creates the remove players button for the player management panel
 * @param {string} userId - User ID who can interact with the button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} Remove players button
 */
function createRemovePlayersButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`remove_players_${userId}`)
        .setLabel(lang.players.mainPage.buttons.removePlayers)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1046'));
}

/**
 * Handles the remove players button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersButton(interaction) {
    // Get user's language preference
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // remove_players_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check if user is an admin with proper permissions
        // Check player management permissions
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
                customIdPrefix: 'select_remove_players_game',
                title: lang.players.removePlayer.content.title.base,
                description: lang.players.removePlayer.content.selectGameDescription
            });

            return await interaction.update({
                components,
                flags: MessageFlags.IsComponentsV2
            });
        }

        const allAlliances = getAlliancesForUserByGame(adminData, getDefaultGameType(), PERMISSIONS.PLAYER_MANAGEMENT);

        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Get player counts for all alliances in a single query
        const playerCountMap = buildPlayerCountMap(allAlliances);

        // Filter out alliances with 0 members
        const alliancesWithMembers = allAlliances.filter(alliance => {
            return (playerCountMap[alliance.id] || 0) > 0;
        });

        if (alliancesWithMembers.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.noAvailableAlliances,
                ephemeral: true
            });
        }

        // Create alliance selection embed and dropdown
        const { components } = createAllianceSelectionContainer(
            interaction,
            alliancesWithMembers,
            lang,
            playerCountMap,
            0,
            getDefaultGameType()
        );

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersButton');
    }
}

/**
 * Creates alliance selection embed using shared utility with player count info
 */
function createAllianceSelectionContainer(interaction, alliances, lang, playerCountMap, page = 0, gameType = null) {
    const resolvedGameType = normalizeGameType(gameType, null);

    return createAllianceSelectionComponents({
        interaction,
        alliances,
        lang,
        page,
        customIdPrefix: 'remove_players_alliance_select',
        feature: 'remove_players',
        subtype: 'alliance',
        placeholder: lang.players.removePlayer.selectMenu.allianceSelect.placeholder,
        title: lang.players.removePlayer.content.title.base,
        description: lang.players.removePlayer.content.description.base,
        accentColor: 16711937, // Red
        showAll: false,
        contextData: resolvedGameType ? [resolvedGameType] : [],
        optionMapper: (alliance) => ({
            label: alliance.name,
            value: alliance.id.toString(),
            description: lang.players.removePlayer.selectMenu.allianceSelect.description
                .replace('{alliancePriority}', alliance.priority)
                .replace('{playerCount}', playerCountMap[alliance.id] || 0),
            emoji: getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1001')
        })
    });
}

/**
 * Creates the player selection embed and dropdown with pagination
 * @param {import('discord.js').ButtonInteraction} interaction - The button interaction
 * @param {Array} players - Array of player objects 
 * @param {Object} lang - Language object
 * @param {Object} alliance - Alliance object
 * @param {number} page - Current page number (default 0)
 * @param {string} additionalContent - Additional content to show
 * @param {number} [totalRemovedCount=0] - Cumulative count of removed players in this session
 * @returns {Object} Embed and components
 */
function createPlayerSelectionEmbed(interaction, players, lang, alliance, page = 0, additionalContent = '', totalRemovedCount = 0) {
    const itemsPerPage = 24;
    const totalPages = Math.ceil(players.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPagePlayers = players.slice(startIndex, endIndex);
    const components = [];

    // Create "Remove by ID" button
    const removeByIdButton = new ButtonBuilder()
        .setCustomId(`remove_players_add_ids_${interaction.user.id}_${alliance.id}`)
        .setLabel(lang.players.removePlayer.buttons.inputPlayerId)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1021'));

    // Add pagination buttons if more than 1 page (always show, disabled when needed)
    const paginationRow = createUniversalPaginationButtons({
        feature: 'remove_players',
        subtype: 'player',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [alliance.id, totalRemovedCount]
    });

    if (paginationRow) {
        // Add the "Remove by ID" button to the same row as pagination
        paginationRow.components.push(removeByIdButton);
        components.push(paginationRow);
    } else {
        // If no pagination, add the button in its own row
        components.push(new ActionRowBuilder().addComponents(removeByIdButton));
    }

    // Third row: Select menu (if there are players)
    if (currentPagePlayers.length > 0) {
        const options = currentPagePlayers.map(player => ({
            label: `ID ${player.fid}`,
            value: player.fid.toString(),
            description: (lang.players.removePlayer.selectMenu.playerSelect.description)
                .replace('{id}', player.fid)
                .replace('{state}', player.state || "Unknown"),
            emoji: getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1026')
        }));

        const playerSelect = new StringSelectMenuBuilder()
            .setCustomId(`remove_players_player_select_${interaction.user.id}_${alliance.id}_${page}_${totalRemovedCount}`)
            .setPlaceholder(lang.players.removePlayer.selectMenu.playerSelect.placeholder)
            .setMinValues(1)
            .setMaxValues(Math.min(options.length, 25))
            .addOptions(options);

        components.push(new ActionRowBuilder().addComponents(playerSelect));
    }

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(16711937) // Red color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.removePlayer.content.title.selectPlayers}\n` +
                    `${lang.players.removePlayer.content.description.selectPlayers.replace('{allianceName}', alliance.name)}\n` +
                    (additionalContent ? `${additionalContent}` : '') +
                    `${lang.pagination.text.pageInfo.replace('{current}', page + 1).replace('{total}', totalPages)}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addActionRowComponents(components)
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Creates the confirmation embed for player removal
 * @param {Array} players - Array of player objects to remove
 * @param {Object} alliance - Alliance object
 * @param {import('discord.js').Interaction} interaction - Interaction object
 * @param {Object} lang - Language object
 * @returns {Object} Embed and components
 */
function createRemovalConfirmationEmbed(players, alliance, interaction, lang) {
    const playerList = players.map(player => lang.players.removePlayer.content.playersToRemoveField.value
        .replace('{id}', player.fid)
        .replace('{state}', player.state || "Unknown")
    ).join('\n');

    // Truncate if too long for embed
    const truncatedPlayerList = playerList.length > 1000 ?
        playerList.substring(0, 997) + '...' : playerList;

    const sessionToken = interaction.client.tempRemoveData?.[interaction.user.id]?.token || createRemovePlayersSessionToken();

    const actionRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`remove_players_confirm_${interaction.user.id}_${sessionToken}`)
                .setLabel(lang.players.removePlayer.buttons.accept)
                .setStyle(ButtonStyle.Danger)
                .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1004')),
            new ButtonBuilder()
                .setCustomId(`remove_players_cancel_${interaction.user.id}_${sessionToken}`)
                .setLabel(lang.players.removePlayer.buttons.cancel)
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1051'))
        );

    const newSection = [
        new ContainerBuilder()
            .setAccentColor(16711937) // Red color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.removePlayer.content.title.confirmRemoval}\n` +
                    `${lang.players.removePlayer.content.description.confirmRemoval.replace('{count}', players.length).replace('{allianceName}', alliance.name)}\n` +
                    `${lang.players.removePlayer.content.playersToRemoveField.name}\n${truncatedPlayerList}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
            )
            .addActionRowComponents(actionRow)
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, newSection) };
}

/**
 * Handles alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersAlliancePagination(interaction) {
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
                    ? lang.players.removePlayer.errors.noAssignedAlliancesForGame
                    : lang.players.removePlayer.errors.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Get player counts for all alliances in a single query
        const playerCountMap = buildPlayerCountMap(allAlliances);

        const alliancesWithMembers = allAlliances.filter(alliance => {
            return (playerCountMap[alliance.id] || 0) > 0;
        });
        if (alliancesWithMembers.length === 0) {
            return await interaction.reply({
                content: isMultiGameModeEnabled()
                    ? lang.players.removePlayer.errors.noAvailableAlliancesForGame
                    : lang.players.removePlayer.errors.noAvailableAlliances,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(interaction, alliancesWithMembers, lang, playerCountMap, newPage, gameType);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersAlliancePagination');
    }
}

/**
 * Handles game selection before alliance selection in both mode
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleRemovePlayersGameSelection(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[4]; // select_remove_players_game_userId

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
                content: lang.players.removePlayer.errors.invalidGameType,
                ephemeral: true
            });
        }

        const allAlliances = getAlliancesForUserByGame(adminData, selectedGameType, PERMISSIONS.PLAYER_MANAGEMENT);
        if (allAlliances.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.noAssignedAlliancesForGame,
                ephemeral: true
            });
        }

        const playerCountMap = buildPlayerCountMap(allAlliances);
        const alliancesWithMembers = allAlliances.filter(alliance => (playerCountMap[alliance.id] || 0) > 0);
        if (alliancesWithMembers.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.noAvailableAlliancesForGame,
                ephemeral: true
            });
        }

        const { components } = createAllianceSelectionContainer(
            interaction,
            alliancesWithMembers,
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
        await handleError(interaction, lang, error, 'handleRemovePlayersGameSelection');
    }
}

/**
 * Handles player selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersPlayerPagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 2);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // contextData[0] = allianceId, contextData[1] = totalRemovedCount
        const alliance = allianceQueries.getAllianceByIdAny(contextData[0]);
        const players = playerQueries.getPlayersByAllianceId(contextData[0], alliance.game_type);
        const totalRemovedCount = parseInt(contextData[1]) || 0;

        // Reconstruct success content if there are removed players
        let additionalContent = '';
        if (totalRemovedCount > 0) {
            additionalContent = `${lang.players.removePlayer.content.playersRemovedField.name}\n${lang.players.removePlayer.content.playersRemovedField.value
                .replace('{removedCount}', totalRemovedCount)
                .replace('{allianceName}', alliance.name)}\n`;
        }

        const { components } = createPlayerSelectionEmbed(interaction, players, lang, alliance, newPage, additionalContent, totalRemovedCount);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersPlayerPagination');
    }
}

/**
 * Handles alliance selection
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleRemovePlayersAllianceSelection(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // remove_players_alliance_select_userId_page_gameType?
        const selectedGameType = normalizeGameType(customIdParts[6], null);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true,
            });
        }

        if (selectedGameType && alliance.game_type !== selectedGameType) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.invalidGameType,
                ephemeral: true
            });
        }

        // Get players from alliance
        const players = playerQueries.getPlayersByAllianceId(allianceId, alliance.game_type);

        if (players.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.noPlayersInAlliance,
                ephemeral: true
            });
        }

        const { components } = createPlayerSelectionEmbed(interaction, players, lang, alliance, 0, '', 0);
        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersAllianceSelection');
    }
}

/**
 * Handles player selection from dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleRemovePlayersPlayerSelection(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // remove_players_player_select_userId_allianceId_page_totalRemoved
        const allianceId = parseInt(customIdParts[5]);
        const currentTotalRemoved = parseInt(customIdParts[7]) || 0; // Get cumulative count

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        const selectedPlayerIds = interaction.values.map(id => parseInt(id));

        // Get player objects
        const selectedPlayers = selectedPlayerIds.map(playerId => {
            return playerQueries.getPlayerByFid(playerId, alliance.game_type);
        }).filter(Boolean);

        // Store selected players temporarily so confirmation uses a short tokenized custom ID.
        setRemovePlayersSession(interaction.client, interaction.user.id, {
            players: selectedPlayers,
            allianceId,
            currentTotal: currentTotalRemoved
        });

        // Show confirmation embed
        const { components } = createRemovalConfirmationEmbed(selectedPlayers, alliance, interaction, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersPlayerSelection');
    }
}

/**
 * Handles confirmation of player removal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersConfirm(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // remove_players_confirm_userId_sessionToken
        const sessionToken = customIdParts[4];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const session = getRemovePlayersSession(interaction.client, interaction.user.id, sessionToken);
        if (!session?.players?.length || !session.allianceId) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        const alliance = allianceQueries.getAllianceByIdAny(session.allianceId);
        const playerIds = session.players.map(player => player.fid);
        const playersToRemove = playerQueries.getPlayersByFids(playerIds, alliance.game_type);
        const currentTotal = session.currentTotal || 0;

        if (playersToRemove.length === 0) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Remove the players in batch
        let removedCount = 0;
        try {
            const fidsToDelete = playersToRemove.map(p => p.fid);
            playerQueries.deletePlayers(fidsToDelete, alliance.game_type);
            removedCount = playersToRemove.length;
        } catch (error) {
            await handleError(interaction, lang, error, 'handleRemovePlayersConfirm - batch delete failed', false);
            // Fall back to individual deletion if batch fails
            for (const player of playersToRemove) {
                try {
                    playerQueries.deletePlayer(player.fid, alliance.game_type);
                    removedCount++;
                } catch (individualError) {
                    await handleError(interaction, lang, individualError, `handleRemovePlayersConfirm - individual delete failed for player ${player.fid}`, false);
                }
            }
        }

        // Calculate new cumulative total
        const newTotalRemoved = currentTotal + removedCount;

        // Clear temp data
        if (interaction.client.tempRemoveData?.[interaction.user.id]) {
            delete interaction.client.tempRemoveData[interaction.user.id];
        }

        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.PLAYERS.REMOVED,
            JSON.stringify({
                count: removedCount,
                allianceName: alliance.name,
                allianceId: alliance.id
            })
        );

        // Show success message and return to player selection
        const remainingPlayers = playerQueries.getPlayersByAllianceId(session.allianceId, alliance.game_type);

        if (remainingPlayers.length === 0) {
            const newSection = [
                new ContainerBuilder()
                    .setAccentColor(65280) // green color
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `### ${lang.players.removePlayer.content.title.removalSuccess}\n` +
                            `${lang.players.removePlayer.content.description.allRemoved.replace('{allianceName}', alliance.name)}\n\n`
                        )
                    )
            ];

            await interaction.update({
                components: updateComponentsV2AfterSeparator(interaction, newSection),
                flags: MessageFlags.IsComponentsV2
            });

        } else {
            // Update the player selection with remaining players showing CUMULATIVE total
            const successContent = `${lang.players.removePlayer.content.playersRemovedField.name}\n${lang.players.removePlayer.content.playersRemovedField.value
                .replace('{removedCount}', newTotalRemoved)
                .replace('{allianceName}', alliance.name)}\n`;
            const { components } = createPlayerSelectionEmbed(interaction, remainingPlayers, lang, alliance, 0, successContent, newTotalRemoved);

            await interaction.update({
                components: components,
                flags: MessageFlags.IsComponentsV2
            });
        }


    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersConfirm');
    }
}

/**
 * Handles the add player IDs button for manual removal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersAddIds(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[4]; // remove_players_add_ids_userId_allianceId
        const allianceId = parseInt(customIdParts[5]);

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliance = allianceQueries.getAllianceByIdAny(allianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Create modal form
        const modal = new ModalBuilder()
            .setCustomId(`remove_players_ids_modal_${allianceId}_${interaction.user.id}`)
            .setTitle(lang.players.removePlayer.modals.title);

        const playerIdInput = new TextInputBuilder()
            .setCustomId('player_ids')
            .setPlaceholder(lang.players.removePlayer.modals.playerIdInput.placeholder)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000);

        const playerIdLabel = new LabelBuilder()
            .setLabel(lang.players.removePlayer.modals.playerIdInput.label)
            .setTextInputComponent(playerIdInput);

        modal.addLabelComponents(playerIdLabel);

        await interaction.showModal(modal);

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersAddIds');
    }
}

/**
 * Handles the remove players IDs modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handleRemovePlayersIdsModal(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const allianceId = parseInt(customIdParts[4]); // remove_players_ids_modal_allianceId_userId
        const expectedUserId = customIdParts[5];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliance = allianceQueries.getAllianceByIdAny(allianceId);

        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Get and sanitize player IDs
        const rawPlayerIds = interaction.fields.getTextInputValue('player_ids');
        const sanitizedPlayerIds = sanitizePlayerIds(rawPlayerIds);

        if (!sanitizedPlayerIds) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.invalidPlayerIds,
                ephemeral: true
            });
        }

        const playerIds = sanitizedPlayerIds.split(',').map(id => parseInt(id));

        // Fetch all players in batch
        const allPlayers = playerQueries.getPlayersByFids(playerIds, alliance.game_type);
        const foundPlayers = [];
        const notFoundPlayers = [];

        // Create a set of found player IDs for efficient lookup
        const foundPlayerIds = new Set(allPlayers.map(p => p.fid));

        // Check each requested player
        for (const playerId of playerIds) {
            const player = allPlayers.find(p => p.fid === playerId);

            if (!player) {
                notFoundPlayers.push(playerId);
            } else if (player.alliance_id !== allianceId) {
                // Player exists but not in this alliance
                notFoundPlayers.push(playerId);
            } else {
                foundPlayers.push(player);
            }
        }

        if (foundPlayers.length === 0) {
            return await interaction.reply({
                content: lang.players.removePlayer.errors.playersNotFound,
                ephemeral: true
            });
        }

        // Store selected players temporarily so confirmation uses a short tokenized custom ID.
        setRemovePlayersSession(interaction.client, interaction.user.id, {
            players: foundPlayers,
            allianceId,
            currentTotal: 0
        });

        // Show confirmation embed
        const { components } = createRemovalConfirmationEmbed(foundPlayers, alliance, interaction, lang);

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersIdsModal');
    }
}

/**
 * Sanitizes player IDs from user input
 * @param {string} input - Raw input string
 * @returns {string|null} Sanitized comma-separated IDs or null if invalid
 */
function sanitizePlayerIds(input) {
    if (!input || typeof input !== 'string') return null;

    // Split by commas, newlines, or any combination (supports spreadsheet paste)
    // then keep only digit-only tokens
    const cleaned = input
        .split(/[,\n\r]+/)
        .map(s => s.trim())
        .filter(s => /^\d+$/.test(s))
        .join(',');

    // Validate: must contain at least one digit
    if (!/\d/.test(cleaned)) return null;

    return cleaned;
}

/**
 * Handles cancellation of player removal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleRemovePlayersCancel(interaction) {
    const { lang } = getUserInfo(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // remove_players_cancel_userId_sessionToken
        const sessionToken = customIdParts[4];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const session = getRemovePlayersSession(interaction.client, interaction.user.id, sessionToken);

        // Clear temp data
        if (interaction.client.tempRemoveData?.[interaction.user.id]) {
            delete interaction.client.tempRemoveData[interaction.user.id];
        }

        if (!session?.allianceId) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        const alliance = allianceQueries.getAllianceByIdAny(session.allianceId);
        const players = playerQueries.getPlayersByAllianceId(session.allianceId, alliance.game_type);

        // Return to player selection
        const { components } = createPlayerSelectionEmbed(interaction, players, lang, alliance, 0, '');

        await interaction.update({
            components: components,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemovePlayersCancel');
    }
}

module.exports = {
    createRemovePlayersButton,
    handleRemovePlayersButton,
    handleRemovePlayersGameSelection,
    handleRemovePlayersAlliancePagination,
    handleRemovePlayersPlayerPagination,
    handleRemovePlayersAllianceSelection,
    handleRemovePlayersPlayerSelection,
    handleRemovePlayersConfirm,
    handleRemovePlayersCancel,
    handleRemovePlayersAddIds,
    handleRemovePlayersIdsModal
};
