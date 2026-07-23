const { ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { giftCodeQueries, allianceQueries, playerQueries } = require('../utility/database');
const { createRedeemProcess, classifyGiftCodeValidationResult } = require('./redeemFunction');
const { parseGameScopedGiftCode } = require('./gameScopedGiftCode');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, handleError, getUserInfo, assertUserMatches, updateComponentsV2AfterSeparator } = require('../utility/commonFunctions');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');

function buildAddGiftModal(userId, lang = {}) {
    const modal = new ModalBuilder()
        .setCustomId(`add_gift_modal_${userId}`)
        .setTitle(lang.giftCode.addGiftCode.modal.title);

    if (isMultiGameModeEnabled()) {
        const gameTypeSelect = new StringSelectMenuBuilder()
            .setCustomId('gift_code_game_type')
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
            .setDescription(lang.giftCode.addGiftCode.modal.gameTypeField.description)
            .setStringSelectMenuComponent(gameTypeSelect);

        modal.addLabelComponents(gameTypeLabel);
    }

    const giftCodeInput = new TextInputBuilder()
        .setCustomId('gift_code_value')
        .setPlaceholder(lang.giftCode.addGiftCode.modal.giftCodeInput.placeholder)
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(50)
        .setRequired(true);

    const giftCodeLabel = new LabelBuilder()
        .setLabel(lang.giftCode.addGiftCode.modal.giftCodeInput.label)
        .setTextInputComponent(giftCodeInput);

    modal.addLabelComponents(giftCodeLabel);

    return modal;
}


/**
 * Creates an add gift code button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The add gift code button
 */
function createAddGiftButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`add_gift_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.addGiftCode)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1000'));
}

/**
 * Handles add gift button interaction - opens modal for gift code input
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAddGiftButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[2]; // add_gift_userId

        // Check if the interaction user matches the expected user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const modal = buildAddGiftModal(interaction.user.id, lang);

        await interaction.showModal(modal);


    } catch (error) {
        await handleError(interaction, lang, error, 'handleAddGiftButton');
    }
}

/**
 * Handles the gift code modal submission
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleGiftCodeModal(interaction) {
    // Get admin language preference
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Extract user ID from custom ID
        const expectedUserId = interaction.customId.split('_')[3]; // add_gift_modal_userId

        // Verify user
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get the gift code from the modal
        const selectedGameType = isMultiGameModeEnabled()
            ? interaction.fields.getStringSelectValues('gift_code_game_type')?.[0]
            : getDefaultGameType();
        const gameType = normalizeGameType(selectedGameType, null);
        if (!gameType) {
            return await interaction.reply({
                content: lang.giftCode.addGiftCode.errors.invalidGameType,
                ephemeral: true
            });
        }

        const rawGiftCodeInput = interaction.fields.getTextInputValue('gift_code_value').trim();
        const parsedGiftCode = parseGameScopedGiftCode(rawGiftCodeInput, {
            strictBothMode: false,
            fallbackGameType: gameType
        });

        if (!rawGiftCodeInput) {
            return await interaction.reply({
                content: lang.giftCode.addGiftCode.errors.invalidGiftCode,
                ephemeral: true
            });
        }

        if (parsedGiftCode.error) {
            return await interaction.reply({
                content: parsedGiftCode.error,
                ephemeral: true
            });
        }

        const inputGameType = normalizeGameType(parsedGiftCode.gameType, null);
        if (inputGameType && inputGameType !== gameType) {
            return await interaction.reply({
                content: lang.giftCode.addGiftCode.errors.gameTypeMismatch,
                ephemeral: true
            });
        }

        const giftCode = parsedGiftCode.giftCode;

        // Check if gift code already exists
        const existingCode = await giftCodeQueries.getGiftCode(giftCode, gameType);
        if (existingCode) {
            return await interaction.reply({
                content: lang.giftCode.addGiftCode.errors.giftCodeExists,
                ephemeral: true
            });
        }

        await interaction.deferUpdate({ flags: MessageFlags.IsComponentsV2 });

        const container = [
            new ContainerBuilder()
                .setAccentColor(0xFFA500) // orange
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.title),
                    new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.description.replace('{giftCode}', `\`${giftCode}\``))
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        // Show processing message
        await interaction.editReply({ components: content, flags: MessageFlags.IsComponentsV2 });

        // Call the redeem function with validation status
        const validationOutcome = await createRedeemProcess([
            {
                id: null,
                giftCode,
                status: 'validation'
            }
        ], {
            adminId: interaction.user.id,
            gameType
        });

        if (validationOutcome?.success) {
            // Add gift code to database
            try {
                // Get VIP status from validation result
                const isVipCode = validationOutcome.results?.[0]?.is_vip || false;

                // addGiftCode(giftCode, status, addedBy, source, apiPushed, isVip)
                await giftCodeQueries.addGiftCode(giftCode, 'active', interaction.user.id, 'manual', false, isVipCode, gameType);

                // Set last_validated timestamp to prevent re-validation by validateExistingCodes
                giftCodeQueries.updateLastValidated(giftCode, gameType);

                // Start auto-redeem for alliances
                setImmediate(() => {
                    startAutoRedeemForAlliances(giftCode, interaction.user.id, lang, gameType).catch(async error => {
                        await handleError(interaction, lang, error, 'startAutoRedeemForAlliances', false);
                    });
                });

                const container = [
                    new ContainerBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.giftCodeAdded),
                            new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.giftCodeInfo.replace('{giftCode}', `\`${giftCode}\``))
                        )
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(lang.giftCode.addGiftCode.content.footer)
                        )
                ];

                const content = updateComponentsV2AfterSeparator(interaction, container);

                await interaction.editReply({
                    components: content,
                    flags: MessageFlags.IsComponentsV2
                });

            } catch (dbError) {
                await handleError(interaction, lang, dbError, 'handleGiftCodeModal_dbError');
            }
        } else {
            const validationResult = validationOutcome?.results?.[0];
            const disposition = classifyGiftCodeValidationResult(validationResult);
            const errorMessage = disposition === 'invalid'
                ? lang.giftCode.addGiftCode.errors.invalidGiftCode
                : lang.giftCode.addGiftCode.errors.validationUnavailable;
            const errorContainer = [
                new ContainerBuilder()
                    .setAccentColor(0xe74c3c)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(errorMessage)
                    )
            ];

            await interaction.editReply({
                components: updateComponentsV2AfterSeparator(interaction, errorContainer),
                flags: MessageFlags.IsComponentsV2
            });
        }
    } catch (error) {
        await handleError(interaction, lang, error, 'handleGiftCodeModal');
    }
}

/**
 * Starts auto-redeem process for all alliances with auto-redeem enabled
 * @param {string} giftCode - The gift code to redeem
 * @param {string} adminId - Admin who initiated the process
 * @param {Object} lang - Language object
 */
async function startAutoRedeemForAlliances(giftCode, adminId, lang, gameType) {
    try {
        // Get all alliances with auto-redeem enabled, ordered by priority
        const alliances = await allianceQueries.getAlliancesWithAutoRedeem(gameType);

        if (alliances.length === 0) {
            return;
        }


        // Process each alliance
        for (const alliance of alliances) {
            try {
                // Get all players for this alliance
                const players = await playerQueries.getPlayersByAlliance(alliance.id, gameType);

                if (players.length === 0) {
                    // console.log(`ℹ️ Alliance "${alliance.name}" has no players, skipping`);
                    continue;
                }

                // Create redeem data for all players
                const redeemData = players.map(player => ({
                    id: player.fid,
                    giftCode: giftCode,
                    status: 'redeem'
                }));


                const redeemOptions = {
                    adminId,
                    gameType,
                    allianceContext: {
                        id: alliance.id,
                        name: alliance.name,
                        channelId: alliance.channel_id || null,
                        gameType
                    }
                };

                // Call redeem function for this alliance
                const result = await createRedeemProcess(redeemData, redeemOptions);

                if (result && result.success) {
                } else {
                    await handleError(null, null, new Error(`Failed to start auto-redeem for alliance "${alliance.name}": ${result?.message || 'Unknown error'}`), 'startAutoRedeemForAlliances_redeemError', false);
                }

            } catch (allianceError) {
                await handleError(null, lang, allianceError, 'startAutoRedeemForAlliances_allianceError', false);
            }
        }

    } catch (error) {
        await handleError(null, lang, error, 'startAutoRedeemForAlliances', false);
    }
}

module.exports = {
    createAddGiftButton,
    handleGiftCodeModal,
    handleAddGiftButton,
};
