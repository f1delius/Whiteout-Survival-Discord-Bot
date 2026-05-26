const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    LabelBuilder
} = require('discord.js');
const { allianceQueries, playerQueries, furnaceChangeQueries, nicknameChangeQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { getFurnaceReadable, getSettlementName } = require('./furnaceReadable');
const { getUserInfo, assertUserMatches, handleError, hasPermission, getAlliancesForUser, getAlliancesForUserByGame, createGameSelectionComponents, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');
const { getEmojiMapForUser, getComponentEmoji } = require('../utility/emojis');

const CHANGES_PER_PAGE = 10;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Gets change records for all players in an alliance
 * @param {number} allianceId - Alliance ID
 * @param {'furnace'|'nickname'} type - Change type
 * @returns {Array} Sorted array of change records (newest first)
 */
function getChangesByAlliance(allianceId, type) {
    const alliance = allianceQueries.getAllianceByIdAny(allianceId);
    if (!alliance) return [];

    const players = playerQueries.getPlayersByAllianceId(allianceId, alliance.game_type);
    const fids = new Set(players.map(p => p.fid));
    const playerMap = new Map(players.map(p => [p.fid, p]));

    const allChanges = type === 'furnace'
        ? furnaceChangeQueries.getAllChanges(alliance.game_type)
        : nicknameChangeQueries.getAllChanges(alliance.game_type);

    return allChanges
        .filter(c => fids.has(c.fid))
        .map(c => ({ ...c, player: playerMap.get(c.fid) }));
}

/**
 * Formats a change record into display text
 * @param {Object} change - Change record with player data
 * @param {'furnace'|'nickname'} type - Change type
 * @param {Object} lang - Language object
 * @returns {string} Formatted text line
 */
function formatChange(change, type, lang, gameType = 'wos') {
    const nickname = change.player?.nickname || `Player ${change.fid}`;
    const date = change.change_date || 'Unknown';

    if (type === 'furnace') {
        const oldLv = getFurnaceReadable(change.old_furnace_lv, lang, gameType);
        const newLv = getFurnaceReadable(change.new_furnace_lv, lang, gameType);
        return lang.players.history.content.furnaceChange
            .replace('{nickname}', nickname)
            .replace('{fid}', change.fid)
            .replace('{oldLevel}', oldLv)
            .replace('{newLevel}', newLv)
            .replace('{date}', date);
    }

    return lang.players.history.content.nicknameChange
        .replace('{nickname}', nickname)
        .replace('{fid}', change.fid)
        .replace('{oldNickname}', change.old_nickname || '—')
        .replace('{newNickname}', change.new_nickname || '—')
        .replace('{date}', date);
}

// ─── Button Factory ────────────────────────────────────────────────────────────

/**
 * Creates the History button for the player management panel
 * @param {string} userId - User ID
 * @param {Object} lang - Language object
 * @returns {ButtonBuilder}
 */
function createHistoryButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`history_${userId}`)
        .setLabel(lang.players.mainPage.buttons.history)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1044'));
}

function createHistoryTypeContainer(interaction, lang, gameType = null) {
    const emojiMap = getEmojiMapForUser(interaction.user.id);
    const resolvedGameType = normalizeGameType(gameType, getDefaultGameType());
    const settlementLabel = getSettlementName(resolvedGameType, lang);

    const typeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`history_type_furnace_${resolvedGameType}_${interaction.user.id}`)
            .setLabel(settlementLabel)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1012')),
        new ButtonBuilder()
            .setCustomId(`history_type_nickname_${resolvedGameType}_${interaction.user.id}`)
            .setLabel(lang.players.history.buttons.nickname)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(getComponentEmoji(emojiMap, '1042'))
    );

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.players.history.content.title}\n${lang.players.history.content.typeDescription}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(typeRow)
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, container) };
}

// ─── Handler: Main History button → type selection ─────────────────────────────

/**
 * Shows Furnace / Nickname type selection buttons
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleHistoryButton(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[1]; // history_{userId}
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        if (isMultiGameModeEnabled()) {
            const { components } = createGameSelectionComponents({
                interaction,
                lang,
                customIdPrefix: 'select_history_game_root',
                title: lang.players.history.content.title,
                description: lang.players.history.content.selectGameDescription
            });

            return await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
        }

        const { components } = createHistoryTypeContainer(interaction, lang, getDefaultGameType());
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryButton');
    }
}

// ─── Handler: Type selected → alliance selection with "By ID" section ──────────

/**
 * Builds the alliance selection container with a SectionBuilder "By ID" accessory
 * @param {import('discord.js').Interaction} interaction
 * @param {Array} alliances - Available alliances
 * @param {string} type - 'furnace' or 'nickname'
 * @param {Object} lang - Language object
 * @param {number} [page=0] - Current page
 * @returns {{ components: Array }}
 */
function createHistoryAllianceContainer(interaction, alliances, type, lang, page = 0, gameType = null) {
    const itemsPerPage = 24;
    const totalPages = Math.max(1, Math.ceil(alliances.length / itemsPerPage));
    const startIndex = page * itemsPerPage;
    const currentPageAlliances = alliances.slice(startIndex, startIndex + itemsPerPage);
    const resolvedGameType = normalizeGameType(gameType, null);

    const emojiMap = getEmojiMapForUser(interaction.user.id);

    // "By ID" button as section accessory
    const byIdButton = new ButtonBuilder()
        .setCustomId(`history_byid_${type}_${resolvedGameType || 'auto'}_${interaction.user.id}`)
        .setLabel(lang.players.history.buttons.search)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1043'));

    // Alliance dropdown options
    const selectOptions = currentPageAlliances.map(alliance => ({
        label: alliance.name,
        value: alliance.id.toString(),
        description: lang.players.history.selectMenu.allianceSelect.description
            .replace('{alliancePriority}', alliance.priority),
        emoji: getComponentEmoji(emojiMap, '1001')
    }));

    const allianceSelect = new StringSelectMenuBuilder()
        .setCustomId(`history_alliance_${type}_${interaction.user.id}_${page}${resolvedGameType ? `_${resolvedGameType}` : ''}`)
        .setPlaceholder(lang.players.history.selectMenu.allianceSelect.placeholder)
        .addOptions(selectOptions);

    const actionRows = [new ActionRowBuilder().addComponents(allianceSelect)];

    // Pagination for alliance list
    const paginationRow = createUniversalPaginationButtons({
        feature: `history_${type}`,
        subtype: 'alliance',
        userId: interaction.user.id,
        currentPage: page,
        totalPages,
        lang,
        contextData: resolvedGameType ? [resolvedGameType] : []
    });

    if (paginationRow) {
        actionRows.push(paginationRow);
    }

    const pageInfo = lang.pagination.text.pageInfo
        .replace('{current}', page + 1)
        .replace('{total}', totalPages);

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addSectionComponents(
                new SectionBuilder()
                    .setButtonAccessory(byIdButton)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `${lang.players.history.content.allianceTitle}\n${lang.players.history.content.allianceDescription}\n${pageInfo}`
                        )
                    )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(actionRows)
    ];

    return { components: updateComponentsV2AfterSeparator(interaction, container) };
}

/**
 * Shows alliance selection dropdown after type is chosen, with "By ID" section button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleHistoryTypeButton(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        // history_type_{furnace|nickname}_{gameType}_{userId}
        const parts = interaction.customId.split('_');
        const type = parts[2]; // furnace or nickname
        const selectedGameType = normalizeGameType(parts[3], getDefaultGameType());
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliances = getAlliancesForUserByGame(adminData, selectedGameType, PERMISSIONS.PLAYER_MANAGEMENT);
        if (alliances.length === 0) {
            return await interaction.reply({
                content: isMultiGameModeEnabled()
                    ? lang.players.history.errors.noAlliancesForGame
                    : lang.players.history.errors.noAlliances,
                ephemeral: true
            });
        }

        const { components } = createHistoryAllianceContainer(interaction, alliances, type, lang, 0, selectedGameType);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryTypeButton');
    }
}

// ─── Handler: Alliance pagination ──────────────────────────────────────────────

/**
 * Handles pagination on the alliance selection screen
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleHistoryAlliancePagination(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        const { userId: expectedUserId, newPage, feature, contextData } = parsePaginationCustomId(
            interaction.customId,
            isMultiGameModeEnabled() ? 1 : 0
        );
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // feature is "history_furnace" or "history_nickname"
        const type = feature.split('_')[1];
        const gameType = normalizeGameType(contextData[0] || getDefaultGameType());
        const alliances = getAlliancesForUserByGame(adminData, gameType, PERMISSIONS.PLAYER_MANAGEMENT);
        if (alliances.length === 0) {
            return await interaction.reply({
                content: isMultiGameModeEnabled()
                    ? lang.players.history.errors.noAlliancesForGame
                    : lang.players.history.errors.noAlliances,
                ephemeral: true
            });
        }

        const { components } = createHistoryAllianceContainer(interaction, alliances, type, lang, newPage, gameType);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryAlliancePagination');
    }
}

/**
 * Handles game selection before alliance selection in both mode
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleHistoryGameSelection(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_'); // select_history_game_root_userId
        const source = parts[3];
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const selectedGameType = normalizeGameType(interaction.values[0], null);
        if (!selectedGameType) {
            return await interaction.reply({
                content: lang.players.history.errors.invalidGameType,
                ephemeral: true
            });
        }

        if (source !== 'root') {
            return await interaction.reply({
                content: lang.players.history.errors.invalidGameType,
                ephemeral: true
            });
        }

        const { components } = createHistoryTypeContainer(interaction, lang, selectedGameType);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryGameSelection');
    }
}

// ─── Handler: Alliance selected → show changes ────────────────────────────────

/**
 * Handles alliance selection from dropdown — shows changes list (page 0)
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleHistoryAllianceSelection(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // customId: history_alliance_{type}_{userId}_{page}_{gameType?}
        const parts = interaction.customId.split('_');
        const type = parts[2]; // furnace or nickname
        const expectedUserId = parts[3];
        const selectedGameType = normalizeGameType(parts[5], null);
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const allianceId = parseInt(interaction.values[0]);
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        if (!alliance) {
            return await interaction.reply({ content: lang.common.error, ephemeral: true });
        }

        if (selectedGameType && alliance.game_type !== selectedGameType) {
            return await interaction.reply({
                content: lang.players.history.errors.invalidGameType,
                ephemeral: true
            });
        }

        const changes = getChangesByAlliance(allianceId, type);
        const { components } = buildChangesContainer(interaction, changes, type, alliance, lang, 0);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryAllianceSelection');
    }
}

// ─── Handler: Changes list pagination ──────────────────────────────────────────

/**
 * Handles pagination on the changes list
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleHistoryChangesPagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // contextData: [allianceId]
        const { userId: expectedUserId, newPage, contextData, feature } = parsePaginationCustomId(interaction.customId, 1);
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // feature is "history_furnace" or "history_nickname"
        const type = feature.split('_')[1];
        const allianceId = parseInt(contextData[0]);
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        const changes = getChangesByAlliance(allianceId, type);

        const { components } = buildChangesContainer(interaction, changes, type, alliance, lang, newPage);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryChangesPagination');
    }
}

// ─── Handler: "By ID" button from alliance screen → modal ─────────────────────

/**
 * Opens the search-by-player-ID modal from the alliance selection screen
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleHistoryByIdButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // history_byid_{type}_{gameType}_{userId}
        const parts = interaction.customId.split('_');
        const type = parts[2];
        const gameType = parts[3];
        const expectedUserId = parts[4];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const modal = new ModalBuilder()
            .setCustomId(`history_search_modal_${type}_0_${gameType}_${interaction.user.id}`)
            .setTitle(lang.players.history.modal.title);

        const idInput = new TextInputBuilder()
            .setCustomId('player_id_input')
            .setPlaceholder(lang.players.history.modal.placeholder)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        const idLabel = new LabelBuilder()
            .setLabel(lang.players.history.modal.label)
            .setTextInputComponent(idInput);

        modal.addLabelComponents(idLabel);
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryByIdButton');
    }
}

// ─── Handler: Search button from changes view → modal ─────────────────────────

/**
 * Opens the search-by-player-ID modal
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleHistorySearchButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // history_search_{type}_{allianceId}_{gameType}_{userId}
        const parts = interaction.customId.split('_');
        const expectedUserId = parts[5];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const type = parts[2];
        const allianceId = parts[3];
        const gameType = parts[4];

        const modal = new ModalBuilder()
            .setCustomId(`history_search_modal_${type}_${allianceId}_${gameType}_${interaction.user.id}`)
            .setTitle(lang.players.history.modal.title);

        const idInput = new TextInputBuilder()
            .setCustomId('player_id_input')
            .setPlaceholder(lang.players.history.modal.placeholder)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        const idLabel = new LabelBuilder()
            .setLabel(lang.players.history.modal.label)
            .setTextInputComponent(idInput);

        modal.addLabelComponents(idLabel);
        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistorySearchButton');
    }
}

// ─── Handler: Modal submit → show filtered results ─────────────────────────────

/**
 * Handles the search modal submission — validates and shows player-specific history
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleHistorySearchModal(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    try {
        // history_search_modal_{type}_{allianceId}_{gameType}_{userId}
        const parts = interaction.customId.split('_');
        const type = parts[3];
        const allianceId = parseInt(parts[4]);
        const selectedGameType = normalizeGameType(parts[5], null);
        const expectedUserId = parts[6];
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const inputId = interaction.fields.getTextInputValue('player_id_input').trim();
        const fid = parseInt(inputId);
        if (isNaN(fid)) {
            return await interaction.reply({
                content: lang.players.history.errors.invalidId,
                ephemeral: true
            });
        }

        // Check if player exists in the database
        const alliance = allianceId > 0 ? allianceQueries.getAllianceByIdAny(allianceId) : null;
        const player = alliance
            ? playerQueries.getPlayer(fid, alliance.game_type)
            : (selectedGameType
                ? playerQueries.getPlayersByFidAny(fid).find(p => p.game_type === selectedGameType)
                : playerQueries.getPlayersByFidAny(fid)[0]);
        if (!player) {
            return await interaction.reply({
                content: lang.players.history.errors.playerNotFound,
                ephemeral: true
            });
        }

        // Check if the player's alliance is accessible to this admin
        const accessibleAlliances = selectedGameType
            ? getAlliancesForUserByGame(adminData, selectedGameType, PERMISSIONS.PLAYER_MANAGEMENT)
            : getAlliancesForUser(adminData);
        const accessibleIds = new Set(accessibleAlliances.map(a => a.id));
        if (!accessibleIds.has(player.alliance_id)) {
            return await interaction.reply({
                content: lang.players.history.errors.noAccessToPlayer,
                ephemeral: true
            });
        }

        // Get the player's changes of the selected type
        const changes = type === 'furnace'
            ? furnaceChangeQueries.getChangesByPlayer(fid, player.game_type).map(c => ({ ...c, player }))
            : nicknameChangeQueries.getChangesByPlayer(fid, player.game_type).map(c => ({ ...c, player }));

        // Use the player's own alliance for display context
        const displayAlliance = allianceQueries.getAllianceById(player.alliance_id, player.game_type) || { id: player.alliance_id, name: 'Unknown', game_type: player.game_type };
        const { components } = buildChangesContainer(interaction, changes, type, displayAlliance, lang, 0, fid);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistorySearchModal');
    }
}

// ─── Handler: Player-specific history pagination ───────────────────────────────

/**
 * Handles pagination when viewing a specific player's history
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleHistoryPlayerPagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        // contextData: [allianceId, fid]
        const { userId: expectedUserId, newPage, contextData, feature } = parsePaginationCustomId(interaction.customId, 2);
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const type = feature.split('_')[1]; // history_furnace or history_nickname
        const allianceId = parseInt(contextData[0]);
        const fid = parseInt(contextData[1]);
        const alliance = allianceQueries.getAllianceByIdAny(allianceId);
        const player = alliance
            ? playerQueries.getPlayer(fid, alliance.game_type)
            : playerQueries.getPlayersByFidAny(fid)[0];

        const changes = type === 'furnace'
            ? furnaceChangeQueries.getChangesByPlayer(fid, player?.game_type || alliance?.game_type || 'wos').map(c => ({ ...c, player }))
            : nicknameChangeQueries.getChangesByPlayer(fid, player?.game_type || alliance?.game_type || 'wos').map(c => ({ ...c, player }));

        const { components } = buildChangesContainer(interaction, changes, type, alliance, lang, newPage, fid);
        await interaction.update({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleHistoryPlayerPagination');
    }
}

// ─── UI Builder ────────────────────────────────────────────────────────────────

/**
 * Builds the changes list container with pagination and search button
 * @param {import('discord.js').Interaction} interaction
 * @param {Array} changes - Array of change records (with player data attached)
 * @param {'furnace'|'nickname'} type - Change type
 * @param {Object} alliance - Alliance object
 * @param {Object} lang - Language object
 * @param {number} page - Current page (0-indexed)
 * @param {number|null} [filteredFid=null] - If set, we're viewing a specific player
 * @returns {{ components: Array }}
 */
function buildChangesContainer(interaction, changes, type, alliance, lang, page = 0, filteredFid = null) {
    const totalPages = Math.max(1, Math.ceil(changes.length / CHANGES_PER_PAGE));
    const safePage = Math.min(page, totalPages - 1);
    const startIndex = safePage * CHANGES_PER_PAGE;
    const pageChanges = changes.slice(startIndex, startIndex + CHANGES_PER_PAGE);

    // Build title
    const gameType = alliance?.game_type || changes[0]?.player?.game_type || getDefaultGameType();
    const typeLabel = type === 'furnace'
        ? getSettlementName(gameType, lang)
        : lang.players.history.buttons.nickname;

    let titleText;
    if (filteredFid) {
        const player = pageChanges[0]?.player;
        const playerName = player?.nickname || `Player ${filteredFid}`;
        titleText = lang.players.history.content.playerTitle
            .replace('{type}', typeLabel)
            .replace('{playerName}', playerName)
            .replace('{fid}', filteredFid);
    } else {
        titleText = lang.players.history.content.changesTitle
            .replace('{type}', typeLabel)
            .replace('{allianceName}', alliance.name);
    }

    // Build change lines
    let displayText;
    if (changes.length === 0) {
        displayText = `${titleText}\n${lang.players.history.errors.noChanges}`;
    } else {
        const lines = pageChanges.map(c => formatChange(c, type, lang, gameType));
        const pageInfo = lang.pagination.text.pageInfo
            .replace('{current}', safePage + 1)
            .replace('{total}', totalPages);
        displayText = [titleText, ...lines, '', pageInfo].join('\n');
    }

    // Pagination
    const isPlayerView = filteredFid !== null;
    const paginationRow = createUniversalPaginationButtons({
        feature: `history_${type}`,
        subtype: isPlayerView ? 'player' : 'changes',
        userId: interaction.user.id,
        currentPage: safePage,
        totalPages,
        lang,
        contextData: isPlayerView ? [alliance.id, filteredFid] : [alliance.id]
    });

    // Search button
    const emojiMap = getEmojiMapForUser(interaction.user.id);
    const searchButton = new ButtonBuilder()
        .setCustomId(`history_search_${type}_${alliance.id}_${gameType}_${interaction.user.id}`)
        .setLabel(lang.players.history.buttons.search)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1043'));

    const actionRow = new ActionRowBuilder().addComponents(searchButton);

    // Build container  
    const container = new ContainerBuilder()
        .setAccentColor(2417109)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(displayText))
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        );

    if (paginationRow) {
        // Merge search button into pagination row
        paginationRow.addComponents(searchButton);
        container.addActionRowComponents(paginationRow);
    } else {
        container.addActionRowComponents(actionRow);
    }

    return { components: updateComponentsV2AfterSeparator(interaction, [container]) };
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    createHistoryButton,
    handleHistoryButton,
    handleHistoryTypeButton,
    handleHistoryGameSelection,
    handleHistoryByIdButton,
    handleHistoryAlliancePagination,
    handleHistoryAllianceSelection,
    handleHistoryChangesPagination,
    handleHistorySearchButton,
    handleHistorySearchModal,
    handleHistoryPlayerPagination
};
