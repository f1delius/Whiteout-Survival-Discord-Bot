const { ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { testIdQueries, systemLogQueries } = require('../utility/database');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, handleError, getUserInfo, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');

function buildSetTestIdModal(userId, lang = {}) {
    const modal = new ModalBuilder()
        .setCustomId(`test_id_modal_${userId}`)
        .setTitle(lang.giftCode.giftSetTestId.modal.title);

    const selectedGameType = getDefaultGameType();
    const currentTestId = getTestIdRecordForValidation(selectedGameType);

    if (isMultiGameModeEnabled()) {
        const gameTypeSelect = new StringSelectMenuBuilder()
            .setCustomId('test_id_game_type')
            .setPlaceholder(lang.common.gameSelection.placeholder)
            .setRequired(true)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(lang.common.gameSelection.options.wos)
                    .setValue('wos'),
                new StringSelectMenuOptionBuilder()
                    .setLabel(lang.common.gameSelection.options.ks)
                    .setValue('ks')
            );

        const gameTypeLabel = new LabelBuilder()
            .setLabel(lang.common.gameSelection.label)
            .setDescription(lang.giftCode.giftSetTestId.modal.gameTypeField.description)
            .setStringSelectMenuComponent(gameTypeSelect);

        modal.addLabelComponents(gameTypeLabel);
    }

    const testIdInput = new TextInputBuilder()
        .setCustomId('test_id_value')
        .setPlaceholder(lang.giftCode.giftSetTestId.modal.testIdInput.placeholder)
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(20)
        .setRequired(true);

    if (!isMultiGameModeEnabled()) {
        testIdInput.setValue(String(currentTestId?.fid || ''));
    }

    const testIdLabel = new LabelBuilder()
        .setLabel(lang.giftCode.giftSetTestId.modal.testIdInput.label)
        .setTextInputComponent(testIdInput);

    modal.addLabelComponents(testIdLabel);

    const stateInput = new TextInputBuilder()
        .setCustomId('test_id_state')
        .setPlaceholder(lang.giftCode.giftSetTestId.modal.stateInput.placeholder)
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(10)
        .setRequired(true);

    if (!isMultiGameModeEnabled() && currentTestId?.state) {
        stateInput.setValue(String(currentTestId.state));
    }

    const stateLabel = new LabelBuilder()
        .setLabel(lang.giftCode.giftSetTestId.modal.stateInput.label)
        .setTextInputComponent(stateInput);

    modal.addLabelComponents(stateLabel);

    return modal;
}

/**
 * Creates a set test ID button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The set test ID button
 */
function createSetTestIdButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`set_test_id_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.setTestId)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1045'));
}

/**
 * Handles set test ID button interaction - directly opens modal
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleSetTestIdButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // set_test_id_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        // Check if user has full access permission
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const modal = buildSetTestIdModal(interaction.user.id, lang);

        await interaction.showModal(modal);


    } catch (error) {
        await handleError(interaction, lang, error, 'handleSetTestIdButton');
    }
}


/**
 * Handles the test ID modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction 
 */
async function handleTestIdModal(interaction) {
    // Get admin language preference
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // test_id_modal_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasFullAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS);
        // Check if user has full access permission
        if (!hasFullAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedGameType = isMultiGameModeEnabled()
            ? interaction.fields.getStringSelectValues('test_id_game_type')?.[0]
            : getDefaultGameType();
        const gameType = normalizeGameType(selectedGameType, null);

        if (!gameType) {
            return await interaction.reply({
                content: lang.giftCode.giftSetTestId.errors.invalidGameType,
                ephemeral: true
            });
        }

        // Get the test ID value
        const testIdValue = interaction.fields.getTextInputValue('test_id_value').trim();

        const fid = Number(testIdValue);
        if (!Number.isSafeInteger(fid) || fid <= 0) {
            return await interaction.reply({
                content: lang.giftCode.giftSetTestId.errors.invalidTestId,
                ephemeral: true
            });
        }

        const state = Number(interaction.fields.getTextInputValue('test_id_state').trim());
        if (!Number.isSafeInteger(state) || state <= 0) {
            return await interaction.reply({
                content: lang.giftCode.giftSetTestId.errors.invalidState,
                ephemeral: true
            });
        }

        const container1 = [
            new ContainerBuilder()
                .setAccentColor(0x3498db) // blue
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.giftSetTestId.content.processingMessage}`
                    )
                )
        ];

        const content1 = updateComponentsV2AfterSeparator(interaction, container1);

        await interaction.deferUpdate({ flags: MessageFlags.IsComponentsV2 });

        await interaction.editReply({
            components: content1,
            flags: MessageFlags.IsComponentsV2
        });

        testIdQueries.updateUserTestId(fid, state, interaction.user.id, gameType);

        // Log the update
        systemLogQueries.addLog(
            'test_id_update',
            `Test ID updated to: ${fid}`,
            JSON.stringify({
                new_fid: fid,
                game_type: gameType,
                state,
                updated_by: interaction.user.id,
                updated_by_tag: interaction.user.tag
            })
        );

        const container2 = [
            new ContainerBuilder()
                .setAccentColor(0x2ecc71) // green
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.giftSetTestId.content.title}` +
                        `\n${lang.giftCode.giftSetTestId.content.description}` +
                        `\n${lang.giftCode.giftSetTestId.content.playerInfoField.name}` +
                        `\n${lang.giftCode.giftSetTestId.content.playerInfoField.value}`
                            .replace('{playerId}', fid)
                            .replace('{state}', state)
                    )
                )
        ];

        const content2 = updateComponentsV2AfterSeparator(interaction, container2);

        await interaction.editReply({
            components: content2,
            flags: MessageFlags.IsComponentsV2
        });


    } catch (error) {
        await handleError(interaction, lang, error, 'handleTestIdModal');
    }
}

/**
 * Gets the current test ID to use for validation
 * Tries user-set ID first, falls back to default
 * @returns {number} FID to use for testing
 */
function getTestIdRecordForValidation(gameType) {
    const userTestId = testIdQueries.getUserTestId(gameType);
    if (userTestId?.set_by) return userTestId;
    return testIdQueries.getDefaultTestId(gameType);
}

function getTestIdForValidation(gameType) {
    try {
        return getTestIdRecordForValidation(gameType)?.fid
            || (gameType === 'ks' ? 47576897 : 40393986);
    } catch (error) {
        handleError(null, null, error, 'getTestIdForValidation', false);
        // Return hard-coded default as last resort
        return gameType === 'ks' ? 47576897 : 40393986;
    }
}

function getTestPlayerForValidation(gameType) {
    try {
        const testId = getTestIdRecordForValidation(gameType);
        if (!testId?.fid) return null;

        const state = Number(testId.state);

        if (!Number.isSafeInteger(state) || state <= 0) return null;
        return { fid: testId.fid, state };
    } catch (error) {
        handleError(null, null, error, 'getTestPlayerForValidation', false);
        return null;
    }
}

module.exports = {
    createSetTestIdButton,
    handleSetTestIdButton,
    handleTestIdModal,
    getTestIdForValidation,
    getTestPlayerForValidation
};
