const { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { db, allianceQueries, playerQueries } = require('../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { getUserInfo, assertUserMatches, handleError, hasPermission, updateComponentsV2AfterSeparator, createGameSelectionComponents } = require('../utility/commonFunctions');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');
const { getEmojiMapForUser, getComponentEmoji, replaceEmojiPlaceholders } = require('./../utility/emojis');

/**
 * Creates an edit priority button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The edit priority button
 */
function createEditPriorityButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`edit_priority_${userId}`)
        .setLabel(lang.alliance.mainPage.buttons.editPriority)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1028'));
}

function getPriorityAlliances(gameType = getDefaultGameType()) {
    return allianceQueries.getAllAlliances(normalizeGameType(gameType));
}

/**
 * Handles edit priority button interaction and shows alliance selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEditPriorityButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[2];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        if (isMultiGameModeEnabled()) {
            const { components } = createGameSelectionComponents({
                interaction,
                lang,
                customIdPrefix: 'select_edit_priority_game',
                title: lang.alliance.editPriority.content.title.base,
                description: lang.alliance.editPriority.content.selectGameDescription
            });

            return await interaction.update({
                components,
                flags: MessageFlags.IsComponentsV2
            });
        }

        const gameType = getDefaultGameType();
        const alliances = getPriorityAlliances(gameType);
        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        await showPrioritySelectPage(interaction, alliances, 0, lang, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditPriorityButton');
    }
}

async function handleEditPriorityGameSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[4];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const gameType = normalizeGameType(interaction.values[0], null);
        if (!gameType) {
            return await interaction.reply({
                content: lang.alliance.editPriority.errors.invalidGameType,
                ephemeral: true
            });
        }

        const alliances = getPriorityAlliances(gameType);
        if (!alliances || alliances.length === 0) {
            return await interaction.reply({
                content: lang.alliance.editPriority.errors.noAlliancesForGame || lang.alliance.editPriority.errors.noAlliances,
                ephemeral: true
            });
        }

        await showPrioritySelectPage(interaction, alliances, 0, lang, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditPriorityGameSelection');
    }
}

/**
 * Handles pagination for priority edit selection
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEditPriorityPagination(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const { userId: expectedUserId, newPage, contextData } = parsePaginationCustomId(interaction.customId, 1);
        const gameType = normalizeGameType(contextData[0] || getDefaultGameType());

        if (interaction.user.id !== expectedUserId) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        const alliances = getPriorityAlliances(gameType);
        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.noAlliancesForGame || lang.alliance.editPriority.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        await showPrioritySelectPage(interaction, alliances, newPage, lang, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleEditPriorityPagination');
    }
}

/**
 * Shows a specific page of alliances for priority editing
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Array} alliances - Array of all alliances
 * @param {number} page - Current page (0-based)
 * @param {Object} lang - Language object
 * @param {string} gameType - Active game type
 */
async function showPrioritySelectPage(interaction, alliances, page, lang, gameType = getDefaultGameType()) {
    const resolvedGameType = normalizeGameType(gameType);
    const itemsPerPage = 24;
    const totalPages = Math.ceil(alliances.length / itemsPerPage);

    page = Math.max(0, Math.min(page, totalPages - 1));

    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const currentAlliances = alliances.slice(start, end);
    const totalAlliances = alliances.length;

    if (totalAlliances < 2) {
        return interaction.reply({
            content: lang.alliance.editPriority.errors.notEnoughAlliances,
            ephemeral: true
        });
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_alliance_priority_${interaction.user.id}_${page}_${resolvedGameType}`)
        .setPlaceholder(lang.alliance.editPriority.selectMenu.selectAlliance.placeholder);

    const allianceIds = currentAlliances.map(a => a.id);
    const playerCountResults = allianceIds.length > 0
        ? playerQueries.getPlayerCountsByAllianceIds(allianceIds, resolvedGameType)
        : [];
    const playerCountMap = new Map(playerCountResults.map(r => [r.alliance_id, r.player_count]));

    for (const alliance of currentAlliances) {
        const playerCount = playerCountMap.get(alliance.id) || 0;
        const option = new StringSelectMenuOptionBuilder()
            .setLabel(`${alliance.name}`)
            .setValue(alliance.id.toString())
            .setDescription(lang.alliance.editPriority.selectMenu.selectAlliance.description
                .replace('{priority}', alliance.priority)
                .replace('{playerCount}', playerCount));
        selectMenu.addOptions(option);
    }

    const component = [];
    const selectRow = new ActionRowBuilder().addComponents(selectMenu);

    const paginationRow = createUniversalPaginationButtons({
        feature: 'edit_priority',
        userId: interaction.user.id,
        currentPage: page,
        totalPages,
        lang,
        contextData: [resolvedGameType]
    });

    component.push(selectRow);
    if (paginationRow) {
        component.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.editPriority.content.title.base}\n` +
                    `${lang.alliance.editPriority.content.description.base}\n` +
                    `${lang.pagination.text.pageInfo
                        .replace('{current}', page + 1)
                        .replace('{total}', totalPages)}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(component)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handles alliance selection for priority editing
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handlePriorityAllianceSelection(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const selectedAllianceId = parseInt(interaction.values[0], 10);
        const gameType = normalizeGameType(interaction.customId.split('_')[5] || getDefaultGameType());
        const alliance = allianceQueries.getAllianceById(selectedAllianceId, gameType);

        if (!alliance) {
            await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
            return;
        }

        await showPriorityEditInterface(interaction, alliance, lang, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handlePriorityAllianceSelection');
    }
}

/**
 * Shows the priority editing interface for a specific alliance
 * @param {import('discord.js').StringSelectMenuInteraction|import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction} interaction
 * @param {Object} alliance - Alliance data
 * @param {Object} lang - Language object
 * @param {string} gameType - Active game type
 */
async function showPriorityEditInterface(interaction, alliance, lang, gameType = alliance?.game_type || getDefaultGameType()) {
    const resolvedGameType = normalizeGameType(gameType);
    const allAlliances = getPriorityAlliances(resolvedGameType);
    const totalAlliances = allAlliances.length;
    const currentIndex = allAlliances.findIndex(a => a.id === alliance.id);
    const contextAlliances = [];

    for (let i = Math.max(0, currentIndex - 3); i <= Math.min(allAlliances.length - 1, currentIndex + 3); i++) {
        contextAlliances.push(allAlliances[i]);
    }

    const contextList = contextAlliances.map(a => {
        const indicator = a.id === alliance.id ? replaceEmojiPlaceholders('{emoji.1016} ', getEmojiMapForUser(interaction.user.id)) : '   ';
        return `\u200E${indicator}**${a.priority}.** ${a.name}`;
    }).join('\n');

    const actionRow = new ActionRowBuilder();

    const highestButton = new ButtonBuilder()
        .setCustomId(`priority_highest_${alliance.id}_${resolvedGameType}`)
        .setLabel(lang.alliance.editPriority.buttons.highest)
        .setStyle(ButtonStyle.Success)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1048'));

    const customButton = new ButtonBuilder()
        .setCustomId(`priority_custom_${alliance.id}_${resolvedGameType}`)
        .setLabel(lang.alliance.editPriority.buttons.custom)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1043'));

    const lowestButton = new ButtonBuilder()
        .setCustomId(`priority_lowest_${alliance.id}_${resolvedGameType}`)
        .setLabel(lang.alliance.editPriority.buttons.lowest)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1007'));

    const backButton = new ButtonBuilder()
        .setCustomId(`back_to_priority_select_${interaction.user.id}_${resolvedGameType}`)
        .setLabel(lang.alliance.editPriority.buttons.backToSelect)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1019'));

    actionRow.addComponents(highestButton, customButton, lowestButton, backButton);

    const container = [
        new ContainerBuilder()
            .setAccentColor(2417109)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.alliance.editPriority.content.title.edit.replace('{allianceName}', alliance.name)}\n` +
                    `${lang.alliance.editPriority.content.description.edit}\n` +
                    `${lang.alliance.editPriority.content.currentPriorityField.name}\n` +
                    `${lang.alliance.editPriority.content.currentPriorityField.value
                        .replace('{priority}', alliance.priority)
                        .replace('{totalAlliances}', totalAlliances)}\n` +
                    `${lang.alliance.editPriority.content.priorityContextField.name}\n` +
                    `${contextList || lang.alliance.editPriority.content.priorityContextField.value}`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addActionRowComponents(actionRow)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

async function handlePriorityHighest(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const allianceId = parseInt(interaction.customId.split('_')[2], 10);
        const gameType = normalizeGameType(interaction.customId.split('_')[3] || getDefaultGameType());
        await updateAlliancePriority(interaction, allianceId, 1, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handlePriorityHighest');
    }
}

async function handlePriorityLowest(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const allianceId = parseInt(interaction.customId.split('_')[2], 10);
        const gameType = normalizeGameType(interaction.customId.split('_')[3] || getDefaultGameType());
        const maxPriority = getPriorityAlliances(gameType).length;
        await updateAlliancePriority(interaction, allianceId, maxPriority, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handlePriorityLowest');
    }
}

async function handlePriorityCustom(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const allianceId = interaction.customId.split('_')[2];
        const gameType = normalizeGameType(interaction.customId.split('_')[3] || getDefaultGameType());
        const maxPriority = getPriorityAlliances(gameType).length;

        const modal = new ModalBuilder()
            .setCustomId(`priority_custom_modal_${allianceId}_${gameType}`)
            .setTitle(lang.alliance.editPriority.modal.title);

        const priorityInput = new TextInputBuilder()
            .setCustomId('priority_value')
            .setPlaceholder(lang.alliance.editPriority.modal.priorityLabel.placeholder.replace('{maxPriority}', maxPriority))
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(3)
            .setRequired(true);

        const priorityLabel = new LabelBuilder()
            .setLabel(lang.alliance.editPriority.modal.priorityLabel.label)
            .setDescription(lang.alliance.editPriority.modal.priorityLabel.description)
            .setTextInputComponent(priorityInput);

        modal.addLabelComponents(priorityLabel);

        await interaction.showModal(modal);
    } catch (error) {
        await handleError(interaction, lang, error, 'handlePriorityCustom');
    }
}

async function handlePriorityCustomModal(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const allianceId = parseInt(interaction.customId.split('_')[3], 10);
        const gameType = normalizeGameType(interaction.customId.split('_')[4] || getDefaultGameType());
        const priorityValue = interaction.fields.getTextInputValue('priority_value');

        const priority = parseInt(priorityValue, 10);
        if (isNaN(priority) || priority < 1) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.invalidPriority,
                ephemeral: true
            });
            return;
        }

        const maxPriority = getPriorityAlliances(gameType).length;
        const finalPriority = Math.min(priority, maxPriority);

        await updateAlliancePriority(interaction, allianceId, finalPriority, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handlePriorityCustomModal');
    }
}

/**
 * Updates alliance priority and resolves conflicts
 * @param {import('discord.js').Interaction} interaction
 * @param {number} allianceId - Alliance ID to update
 * @param {number} newPriority - New priority value
 * @param {string} gameType - Active game type
 */
async function updateAlliancePriority(interaction, allianceId, newPriority, gameType = getDefaultGameType()) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const resolvedGameType = normalizeGameType(gameType);
        const alliance = allianceQueries.getAllianceById(allianceId, resolvedGameType);
        if (!alliance) {
            await interaction.reply({
                content: lang.common.error,
                ephemeral: true
            });
            return;
        }

        const oldPriority = alliance.priority;

        if (oldPriority === newPriority) {
            await showPriorityEditInterface(interaction, alliance, lang, resolvedGameType);
            return;
        }

        const allAlliances = getPriorityAlliances(resolvedGameType);
        const alliancesWithoutTarget = allAlliances.filter(a => a.id !== allianceId);
        const newOrder = [];

        let inserted = false;
        for (let i = 0; i < alliancesWithoutTarget.length; i++) {
            if (!inserted && (i + 1) === newPriority) {
                newOrder.push({ id: allianceId, priority: newPriority });
                inserted = true;
            }
            newOrder.push({
                id: alliancesWithoutTarget[i].id,
                priority: inserted ? i + 2 : i + 1
            });
        }

        if (!inserted) {
            newOrder.push({ id: allianceId, priority: newPriority });
        }

        const reorderPriorities = db.transaction(() => {
            for (const a of allAlliances) {
                allianceQueries.updateAlliancePriority(a.id, -(a.id), resolvedGameType);
            }

            for (const item of newOrder) {
                allianceQueries.updateAlliancePriority(item.id, item.priority, resolvedGameType);
            }
        });
        reorderPriorities();

        const updatedAlliance = allianceQueries.getAllianceById(allianceId, resolvedGameType);
        await showPriorityEditInterface(interaction, updatedAlliance, lang, resolvedGameType);

        await interaction.followUp({
            content: lang.alliance.editPriority.content.priorityUpdated
                .replace('{allianceName}', alliance.name)
                .replace('{oldPriority}', oldPriority)
                .replace('{newPriority}', newPriority),
            ephemeral: true
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'updateAlliancePriority');
    }
}

async function handleBackToPrioritySelect(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[4];
        const gameType = normalizeGameType(interaction.customId.split('_')[5] || getDefaultGameType());

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const alliances = getPriorityAlliances(gameType);
        if (!alliances || alliances.length === 0) {
            await interaction.reply({
                content: lang.alliance.editPriority.errors.noAlliancesForGame || lang.alliance.editPriority.errors.noAlliances,
                ephemeral: true
            });
            return;
        }

        await showPrioritySelectPage(interaction, alliances, 0, lang, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleBackToPrioritySelect');
    }
}

module.exports = {
    createEditPriorityButton,
    handleEditPriorityButton,
    handleEditPriorityGameSelection,
    handleEditPriorityPagination,
    handlePriorityAllianceSelection,
    handleBackToPrioritySelect,
    handlePriorityHighest,
    handlePriorityLowest,
    handlePriorityCustom,
    handlePriorityCustomModal
};
