const { ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, MessageFlags, SeparatorSpacingSize, LabelBuilder } = require('discord.js');
const { adminQueries, allianceQueries, adminLogQueries, playerQueries } = require('../utility/database');
const { LOG_CODES } = require('../utility/AdminLogs');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { restartAutoRefresh } = require('./refreshAlliance');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getUserInfo, assertUserMatches, handleError, hasPermission, updateComponentsV2AfterSeparator, parseRefreshInterval, formatRefreshInterval, getAlliancesForUserByGame, createGameSelectionComponents } = require('../utility/commonFunctions');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');

/**
 * Creates an edit alliance button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The edit alliance button
 */
function createEditAllianceButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`edit_alliance_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.editAlliance)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1008'));
}

/**
 * Handles edit alliance button interaction and shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleEditAllianceButton(interaction) {
    // Get user's language preference
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // edit_alliance_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have ALLIANCE_MANAGEMENT
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasFullAccess && !hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        if (isMultiGameModeEnabled()) {
            const { components } = createGameSelectionComponents({
                interaction,
                lang,
                customIdPrefix: 'select_edit_alliance_game',
                title: lang.alliance.editAlliance.content.title.base,
                description: lang.alliance.editAlliance.content.selectGameDescription
            });

            return await interaction.update({
                components,
                flags: MessageFlags.IsComponentsV2
            });
        }

        const alliances = getAlliancesForUserByGame(adminData, getDefaultGameType(), PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!alliances || alliances.length === 0) {
            return await interaction.reply({
                content: hasFullAccess
                    ? lang.alliance.editAlliance.errors.noAlliances
                    : lang.alliance.editAlliance.errors.noAssignedAlliances,
                ephemeral: true
            });
        }

        // Show alliance selection with pagination (page 0)
        await showAllianceSelection(interaction, 0, lang, alliances, getDefaultGameType());

    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditAllianceButton');
    }
}

/**
 * Shows alliance selection with pagination
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction 
 * @param {number} page - Current page number
 * @param {Object} lang - Language object
 * @param {Array} alliances - Array of alliances to display (filtered based on permissions)
 */
async function showAllianceSelection(interaction, page = 0, lang = {}, alliances = null, gameType = getDefaultGameType()) {
    const resolvedGameType = normalizeGameType(gameType);
    // If alliances not provided, get them based on user permissions
    if (!alliances) {
        const adminData = adminQueries.getAdmin(interaction.user.id);
        alliances = getAlliancesForUserByGame(adminData, resolvedGameType, PERMISSIONS.ALLIANCE_MANAGEMENT);
    }
    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);
    const startIndex = page * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentPageAlliances = alliances.slice(startIndex, endIndex);

    // Fetch all player counts in a single query (fixes N+1 query pattern)
    const allianceIds = currentPageAlliances.map(a => a.id);
    const playerCountResults = allianceIds.length > 0
        ? playerQueries.getPlayerCountsByAllianceIds(allianceIds, resolvedGameType)
        : [];

    // Convert to Map for O(1) lookup
    const playerCounts = new Map();
    playerCountResults.forEach(row => {
        playerCounts.set(row.alliance_id, row.player_count);
    });

    // Create dropdown menu with alliances
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_alliance_edit_${interaction.user.id}_${page}_${resolvedGameType}`)
        .setPlaceholder(lang.alliance.editAlliance.selectMenu.selectAlliance.placeholder)
        .setMinValues(1)
        .setMaxValues(1);

    // Add alliance options
    currentPageAlliances.forEach(alliance => {
        // Get player count from pre-fetched map (O(1) lookup)
        const playerCount = playerCounts.get(alliance.id) || 0;

        selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(alliance.name)
                .setValue(alliance.id.toString())
                .setDescription(lang.alliance.editAlliance.selectMenu.selectAlliance.description
                    .replace('{playerCount}', playerCount.toString())
                    .replace('{alliancePriority}', Math.floor(alliance.priority).toString())
                )
                .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1001'))
        );
    });

    // Create action rows
    const components = [];
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const paginationRow = createUniversalPaginationButtons({
        feature: 'edit_alliance',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: [resolvedGameType]
    });

    components.push(selectRow);

    // Add pagination buttons if more than 1 page (always show, disabled when needed)
    if (paginationRow) {
        components.push(paginationRow);
    }

    // Create container using Components v2
    const container = [
        new ContainerBuilder()
            .setAccentColor(0x3498db) // Blue color
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.editAlliance.content.title.base}\n` +
                    `${lang.alliance.editAlliance.content.description}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', (page + 1).toString())
                        .replace('{total}', totalPages.toString())
                    }`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(
                ...components
            )
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    // Update the message
    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles alliance selection pagination
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleEditAlliancePagination(interaction) {
    // Get user's language preference
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID and page from custom ID
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);
        const gameType = contextData[0] || getDefaultGameType();

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Show new page
        await showAllianceSelection(interaction, newPage, lang, null, gameType);

    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditAlliancePagination');
    }
}

/**
 * Handles game selection before alliance selection in both mode
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleEditAllianceGameSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[4]; // select_edit_alliance_game_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasFullAccess && !hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedGameType = normalizeGameType(interaction.values[0], null);
        if (!selectedGameType) {
            return await interaction.reply({
                content: lang.alliance.editAlliance.errors.invalidGameType,
                ephemeral: true
            });
        }

        const alliances = getAlliancesForUserByGame(adminData, selectedGameType, PERMISSIONS.ALLIANCE_MANAGEMENT);
        if (!alliances || alliances.length === 0) {
            return await interaction.reply({
                content: hasFullAccess
                    ? lang.alliance.editAlliance.errors.noAlliancesForGame
                    : lang.alliance.editAlliance.errors.noAssignedAlliancesForGame,
                ephemeral: true
            });
        }

        await showAllianceSelection(interaction, 0, lang, alliances, selectedGameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditAllianceGameSelection');
    }
}

/**
 * Handles alliance selection from dropdown
 * @param {import('discord.js').StringSelectMenuInteraction} interaction 
 */
async function handleEditAllianceSelection(interaction) {
    // Get user's language preference
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // select_alliance_edit_userId_page_gameType
        const selectedGameType = customIdParts[5] || getDefaultGameType();
        const resolvedGameType = normalizeGameType(selectedGameType);

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get selected alliance ID
        const allianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);

        if (!alliance || alliance.game_type !== resolvedGameType) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Check if admin has permission to edit this specific alliance
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT);

        if (!hasFullAccess) {
            // Check if admin has alliance management permission
            if (!hasAccess) {
                return await interaction.reply({
                    content: lang.common.noPermission,
                    ephemeral: true
                });
            }
            // Check if admin is assigned to this alliance
            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            if (!assignedAllianceIds.includes(allianceId)) {
                return await interaction.reply({
                    content: lang.alliance.editAlliance.errors.noAssignedAlliances,
                    ephemeral: true
                });
            }
        }

        const baseTitle = lang.alliance.editAlliance.modal.title;
        const maxNameLength = 45 - (baseTitle.length + 3); // 3 for ' : '
        const safeAllianceName = alliance.name.length > maxNameLength
            ? alliance.name.slice(0, maxNameLength - 1) + '…'
            : alliance.name;

        // Create modal form with pre-filled data
        const modal = new ModalBuilder()
            .setCustomId(`edit_alliance_modal_${allianceId}_${interaction.user.id}`)
            .setTitle(`${baseTitle} : ${safeAllianceName}`);

        // Alliance name input (pre-filled)
        const allianceNameInput = new TextInputBuilder()
            .setCustomId('alliance_name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.alliance.editAlliance.modal.allianceName.placeholder)
            .setValue(alliance.name)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(50);

        // Wrap it in a label
        const allianceNameLabel = new LabelBuilder()
            .setLabel(lang.alliance.editAlliance.modal.allianceName.label)
            .setTextInputComponent(allianceNameInput);

        // Refresh rate input (pre-filled)
        const intervalStr = String(alliance.interval);
        const displayValue = intervalStr.startsWith('@')
            ? intervalStr
            : String(Math.floor(Number(alliance.interval)));

        const refreshRateInput = new TextInputBuilder()
            .setCustomId('refresh_rate')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(lang.alliance.editAlliance.modal.refreshRate.placeholder)
            .setValue(displayValue)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(6);

        const refreshRateLabel = new LabelBuilder()
            .setLabel(lang.alliance.editAlliance.modal.refreshRate.label)
            .setDescription(lang.alliance.createAlliance.modal.refreshRateField.description)
            .setTextInputComponent(refreshRateInput);

        // Add the label components to the modal
        modal.addLabelComponents(allianceNameLabel, refreshRateLabel);

        // Show the modal
        await interaction.showModal(modal);

    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditAllianceSelection');
    }
}

/**
 * Handles edit alliance modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handleEditAllianceModal(interaction) {
    // Get user's language preference
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // Extract alliance ID and user ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const allianceId = parseInt(customIdParts[3]); // edit_alliance_modal_allianceId_userId
        const expectedUserId = customIdParts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Get current alliance data
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        if (!alliance) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }

        // Get form values
        const newAllianceName = interaction.fields.getTextInputValue('alliance_name').trim();
        const refreshRateInput = interaction.fields.getTextInputValue('refresh_rate').trim();

        // Validate refresh rate (supports both minutes and @HH:MM format)
        const parseResult = parseRefreshInterval(refreshRateInput, lang);
        if (!parseResult.isValid) {
            return await interaction.reply({
                content: parseResult.error || lang.alliance.editAlliance.errors.invalidRefreshRate,
                ephemeral: true
            });
        }
        const newRefreshRate = parseResult.value;

        try {
            // Update alliance basic info (keeping existing channel and other data)
            allianceQueries.updateAlliance(
                alliance.priority,      // Keep same priority
                newAllianceName,        // New name
                alliance.guide_id,      // Keep same guide_id
                alliance.channel_id,    // Keep same channel_id (will be updated separately)
                newRefreshRate,         // New refresh rate
                alliance.auto_redeem,   // Keep same auto_redeem
                allianceId,             // WHERE id = allianceId
                alliance.game_type
            );

            // Log the alliance update
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.ALLIANCE.UPDATED_NAME,
                JSON.stringify({
                    oldName: alliance.name,
                    newName: newAllianceName,
                    allianceId: allianceId
                })
            );

            const refreshRateText = formatRefreshInterval(newRefreshRate, lang);


            // Create success section using Components v2
            const container = [
                new ContainerBuilder()
                    .setAccentColor(0x34ebba) // Green color
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${lang.alliance.editAlliance.content.title.updated}\n` +
                            `${lang.alliance.editAlliance.content.description}\n` +
                            `${lang.alliance.editAlliance.content.allianceInfoField.name}\n` +
                            `${lang.alliance.editAlliance.content.allianceInfoField.value
                                .replace('{name}', newAllianceName)
                                .replace('{refreshRate}', refreshRateText)
                                .replace('{channel}', `<#${alliance.channel_id}>`)
                                .replace('{priority}', alliance.priority)}\n`
                        )
                    )
            ];

            // Add warning if refresh rate is less than 30 minutes (only for minute-based intervals)
            if (typeof newRefreshRate === 'number' && newRefreshRate > 0 && newRefreshRate < 30) {
                container[0].addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.alliance.editAlliance.content.warningField.name}\n` +
                        `${lang.alliance.editAlliance.content.warningField.value}`
                    ),
                );
            }

            container[0].addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.editAlliance.content.footer}`
                ),
            );

            // Create channel select menu
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId(`alliance_channel_edit_${allianceId}_${interaction.user.id}`)
                .setPlaceholder(lang.alliance.editAlliance.selectMenu.selectChannel.placeholder)
                .setChannelTypes([ChannelType.GuildText])
                .setMinValues(1)
                .setMaxValues(1);

            const channelRow = new ActionRowBuilder().addComponents(channelSelect);
            container[0].addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            ).addActionRowComponents(
                channelRow
            );

            const content = updateComponentsV2AfterSeparator(interaction, container);

            // Reply with success and channel selection
            await interaction.update({
                components: content,
                flags: MessageFlags.IsComponentsV2,
            });

            // Restart auto-refresh if refresh rate changed
            if (alliance.interval !== newRefreshRate) {
                try {
                    await restartAutoRefresh(allianceId);
                } catch (autoRefreshError) {
                    await handleError(interaction, lang, autoRefreshError, 'handleEditAllianceModal_restartAutoRefresh', false);
                }
            }
        } catch (dbError) {
            await handleError(interaction, lang, dbError, 'handleEditAllianceModal_databaseUpdate');
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditAllianceModal');
    }
}

/**
 * Handles alliance channel selection for editing
 * @param {import('discord.js').ChannelSelectMenuInteraction} interaction 
 */
async function handleEditAllianceChannelSelection(interaction) {
    // Get user's language preference
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract alliance ID and user ID from custom ID
        const customIdParts = interaction.customId.split('_');
        const allianceId = parseInt(customIdParts[3]); // alliance_channel_edit_allianceId_userId
        const expectedUserId = customIdParts[4];

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // check if admin has permission to edit this specific alliance
        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        const hasAccess = hasPermission(adminData, PERMISSIONS.ALLIANCE_MANAGEMENT);
        if (!hasFullAccess) {
            // Check if admin has alliance management permission
            if (!hasAccess) {
                return await interaction.reply({
                    content: lang.common.noPermission,
                    ephemeral: true
                });
            }
            // Check if admin is assigned to this alliance
            const assignedAllianceIds = JSON.parse(adminData.alliances || '[]');
            if (!assignedAllianceIds.includes(allianceId)) {
                return await interaction.reply({
                    content: lang.alliance.editAlliance.errors.noAssignedAlliances,
                    ephemeral: true
                });
            }
        }

        // Get selected channel
        const selectedChannel = interaction.channels.first();
        if (!selectedChannel) {
            return await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
        }
        const channelId = selectedChannel.id;

        // Get current alliance data
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        if (!alliance) {
            return await interaction.update({
                content: lang.common.error,
                embeds: [],
                components: []
            });
        }

        try {
            // Update alliance with new channel
            allianceQueries.updateAlliance(
                alliance.priority,
                alliance.name,
                alliance.guide_id,
                channelId,              // New channel ID
                alliance.interval,
                alliance.auto_redeem,
                allianceId,
                alliance.game_type
            );

            // Log the channel update
            adminLogQueries.addLog(
                interaction.user.id,
                LOG_CODES.ALLIANCE.UPDATED_CHANNEL,
                JSON.stringify({
                    allianceName: alliance.name,
                    channelName: selectedChannel.name,
                    channelId: channelId
                })
            );

            // Create refresh rate text
            const refreshRateText = formatRefreshInterval(alliance.interval, lang);

            // Create final success section using Components v2
            const container = [
                new ContainerBuilder()
                    .setAccentColor(0x57f287) // Green color
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${lang.alliance.editAlliance.content.title.updated}\n` +
                            `${lang.alliance.editAlliance.content.description}\n` +
                            `${lang.alliance.editAlliance.content.allianceInfoField.name}\n` +
                            `${lang.alliance.editAlliance.content.allianceInfoField.value
                                .replace('{name}', alliance.name)
                                .replace('{refreshRate}', refreshRateText)
                                .replace('{channel}', `<#${channelId}>`)
                                .replace('{priority}', alliance.priority)}`
                        )
                    )
            ];

            const content = updateComponentsV2AfterSeparator(interaction, container);

            // Update the message with final success
            await interaction.update({
                components: content,
                flags: MessageFlags.IsComponentsV2
            });

        } catch (dbError) {
            await handleError(interaction, lang, dbError, 'handleEditAllianceChannelSelection_databaseUpdate');
        }

    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditAllianceChannelSelection');
    }
}

module.exports = {
    createEditAllianceButton,
    handleEditAllianceButton,
    handleEditAlliancePagination,
    handleEditAllianceGameSelection,
    handleEditAllianceSelection,
    handleEditAllianceModal,
    handleEditAllianceChannelSelection
};
