const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { giftCodeQueries } = require('../utility/database');
const { createUniversalPaginationButtons, parsePaginationCustomId } = require('../Pagination/universalPagination');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { hasPermission, handleError, getUserInfo, assertUserMatches, updateComponentsV2AfterSeparator, createGameSelectionComponents } = require('../utility/commonFunctions');
const { getEmojiMapForUser, getComponentEmoji } = require('./../utility/emojis');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { normalizeGameType } = require('../utility/gameProfiles');


/**
 * Creates a remove gift code button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The remove gift code button
 */
function createRemoveGiftButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`remove_gift_${userId}`)
        .setLabel(lang.giftCode.mainPage.buttons.removeGiftCode)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1046'));
}

/**
 * Handle remove gift code button - Shows list of gift codes to select
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleRemoveGiftButton(interaction) {
    // Get language preference first (needed for all messages including errors)
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {

        // Extract user ID from custom ID for security check
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[2]; // remove_gift_userId

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

        if (isMultiGameModeEnabled()) {
            const { components } = createGameSelectionComponents({
                interaction,
                lang,
                customIdPrefix: 'select_remove_gift_game',
                title: lang.giftCode.removeGiftCode.content.title.base,
                description: lang.giftCode.removeGiftCode.content.selectGameDescription
            });

            return await interaction.update({
                components,
                flags: MessageFlags.IsComponentsV2
            });
        }

        const gameType = getDefaultGameType();

        // Get all gift codes from database
        const allGiftCodes = giftCodeQueries.getAllGiftCodes(gameType);

        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({ content: lang.giftCode.removeGiftCode.errors.noGiftCodes, ephemeral: true });
        }

        // Display first page
        await displayRemoveGiftPage(interaction, allGiftCodes, 0, lang, gameType);

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemoveGiftButton');
    }
}

async function handleRemoveGiftGameSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[4]; // select_remove_gift_game_userId

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const gameType = normalizeGameType(interaction.values[0], null);
        if (!gameType) {
            return await interaction.reply({
                content: lang.giftCode.removeGiftCode.errors.invalidGameType,
                ephemeral: true
            });
        }

        const allGiftCodes = giftCodeQueries.getAllGiftCodes(gameType);

        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.removeGiftCode.errors.noGiftCodesForGame,
                ephemeral: true
            });
        }

        await displayRemoveGiftPage(interaction, allGiftCodes, 0, lang, gameType);
    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemoveGiftGameSelection');
    }
}

/**
 * Display a page of gift codes with select menu and pagination
 * @param {Object} interaction - Discord interaction
 * @param {Array} allGiftCodes - All gift codes from database
 * @param {number} page - Current page number (0-indexed)
 * @param {Object} lang - Language object

 * @returns {Promise<void>}
 */
async function displayRemoveGiftPage(interaction, allGiftCodes, page, lang, gameType = null) {
    const CODES_PER_PAGE = 24; // Max 25 options per select menu, using 24 to be safe
    const totalPages = Math.max(1, Math.ceil(allGiftCodes.length / CODES_PER_PAGE));
    const startIndex = page * CODES_PER_PAGE;
    const endIndex = Math.min(startIndex + CODES_PER_PAGE, allGiftCodes.length);
    const pageCodes = allGiftCodes.slice(startIndex, endIndex);

    // Build select menu with current page's gift codes
    const emojiMap = getEmojiMapForUser(interaction.user.id);
    const options = pageCodes.map(code => ({
        label: code.gift_code,
        description: `${code.status === 'active' ? lang.giftCode.removeGiftCode.content.active : lang.giftCode.removeGiftCode.content.inactive} | ${code.source || 'Unknown'}`,
        value: code.gift_code,
        emoji: getComponentEmoji(emojiMap, '1013')
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`remove_gift_select_${interaction.user.id}_${page}${gameType ? `_${gameType}` : ''}`)
        .setPlaceholder(lang.giftCode.removeGiftCode.selectMenu.selectGiftCodes.placeholder)
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options);

    const components = [new ActionRowBuilder().addComponents(selectMenu)];

    // Add pagination buttons if needed
    const paginationRow = createUniversalPaginationButtons({
        feature: 'remove_gift',
        userId: interaction.user.id,
        currentPage: page,
        totalPages: totalPages,
        lang: lang,
        contextData: gameType ? [gameType] : []
    });

    if (paginationRow) {
        components.push(paginationRow);
    }

    const container = [
        new ContainerBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(lang.giftCode.removeGiftCode.content.title.base),
                new TextDisplayBuilder().setContent(lang.giftCode.removeGiftCode.content.description.base.replace('{codesCount}', allGiftCodes.length))
            )
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(lang.pagination.text.pageInfo
                    .replace('{current}', (page + 1).toString())
                    .replace('{total}', totalPages.toString())
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addActionRowComponents(components)
    ];

    const content = updateComponentsV2AfterSeparator(interaction, container);

    await interaction.update({
        components: content,
        flags: MessageFlags.IsComponentsV2
    });
}

/**
 * Handle pagination for remove gift code list
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleRemoveGiftPagination(interaction) {
    // Get language preference first 
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {

        // Parse pagination data from custom ID
        const { userId, newPage, contextData } = parsePaginationCustomId(interaction.customId, isMultiGameModeEnabled() ? 1 : 0);

        if (interaction.user.id !== userId) {
            return await interaction.reply({
                content: lang.common.notForYou,
                ephemeral: true
            });
        }

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Get all gift codes again
        const gameType = normalizeGameType(contextData[0] || getDefaultGameType());
        const allGiftCodes = giftCodeQueries.getAllGiftCodes(gameType);

        if (!allGiftCodes || allGiftCodes.length === 0) {
            return await interaction.reply({
                content: lang.giftCode.removeGiftCode.errors.noGiftCodes,
                ephemeral: true
            });
        }

        // Display the new page
        await displayRemoveGiftPage(interaction, allGiftCodes, newPage, lang, gameType);

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemoveGiftPagination');
    }
}

/**
 * Handle gift code selection from dropdown
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleRemoveGiftSelect(interaction) {
    // Get language preference first 
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        // Extract user ID from custom ID for security check
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3]; // remove_gift_select_userId_page
        const gameType = normalizeGameType(customIdParts[5] || getDefaultGameType());

        // Security check
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedCodes = interaction.values; // Array of selected gift codes

        // Encode selected codes to base64url to avoid oversized custom IDs
        const codesString = selectedCodes.join(',');
        const encodedCodes = Buffer.from(codesString, 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        // Build confirm/cancel buttons
        const confirmButton = new ButtonBuilder()
            .setCustomId(`remove_gift_confirm_${interaction.user.id}_${encodedCodes}_${gameType}`)
            .setLabel(lang.giftCode.removeGiftCode.buttons.confirm)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1004'))
            .setStyle(ButtonStyle.Danger);

        const cancelButton = new ButtonBuilder()
            .setCustomId(`remove_gift_cancel_${interaction.user.id}`)
            .setLabel(lang.giftCode.removeGiftCode.buttons.cancel)
            .setEmoji(getComponentEmoji(getEmojiMapForUser(interaction.user.id), '1051'))
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        const container = [
            new ContainerBuilder()
                .setAccentColor(16711937) // Red color
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.giftCode.removeGiftCode.content.title.confirm}\n` +
                        `${lang.giftCode.removeGiftCode.content.giftCodesToRemoveField.name}\n` +
                        lang.giftCode.removeGiftCode.content.giftCodesToRemoveField.value
                            .replace('{codes}', selectedCodes.map(code => `    - \`${code}\``).join('\n'))
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addActionRowComponents(row)
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemoveGiftSelect');
    }
}

/**
 * Handle confirm deletion button
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleRemoveGiftConfirm(interaction) {
    // Get language preference first
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        // Extract selected codes from custom ID (base64url-encoded list)
        // Format: remove_gift_confirm_userId_encodedCodes
        const customIdParts = interaction.customId.split('_');
        const userId = customIdParts[3];

        // Security check
        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);
        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        // Decode codes from custom ID
        const encodedCodes = customIdParts[4];
        const gameType = normalizeGameType(customIdParts[5] || getDefaultGameType());
        const padded = encodedCodes + '='.repeat((4 - (encodedCodes.length % 4)) % 4);
        const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const selectedCodes = decoded.split(',').filter(Boolean);

        // Delete gift codes
        let successCount = 0;
        let failedCodes = [];
        let successCodes = [];

        for (const code of selectedCodes) {
            try {
                giftCodeQueries.removeGiftCode(code, gameType);
                successCount++;
                successCodes.push(code);
            } catch (error) {
                await handleError(interaction, lang, error, 'handleRemoveGiftConfirm', false);
                failedCodes.push(code);
            }
        }

        const container = [
            new ContainerBuilder()
                .setAccentColor(failedCodes.length === 0 ? 65280 : 16753920) // Green or Orange
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${failedCodes.length === 0 ? lang.giftCode.removeGiftCode.content.title.success : lang.giftCode.removeGiftCode.content.title.partialSuccess}\n` +
                        `${lang.giftCode.removeGiftCode.content.removedCodesField.name}\n` +
                        lang.giftCode.removeGiftCode.content.removedCodesField.value
                            .replace('{codes}', successCodes.map(code => `  - \`${code}\``).join('\n'))
                    )
                )
        ];

        if (failedCodes.length > 0) {
            container[0].addSeparatorComponents(
                new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            ).addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${lang.giftCode.removeGiftCode.content.failedCodesField.name}\n` +
                    lang.giftCode.removeGiftCode.content.failedCodesField.value
                        .replace('{codes}', failedCodes.map(code => `  - \`${code}\``).join('\n')))
            );
        }

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemoveGiftConfirm');
    }
}

/**
 * Handle cancel deletion button
 * @param {Object} interaction - Discord interaction
 * @returns {Promise<void>}
 */
async function handleRemoveGiftCancel(interaction) {
    // Get language preference first
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {

        // Extract userId from custom ID for security check
        // Format: remove_gift_cancel_userId
        const customIdParts = interaction.customId.split('_');
        const userId = customIdParts[3];

        // Security check
        if (!(await assertUserMatches(interaction, userId, lang))) return;

        // Check permissions: must be owner, have FULL_ACCESS, or have GIFT_CODE_MANAGEMENT
        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.GIFT_CODE_MANAGEMENT);

        if (!hasAccess) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const container = [
            new ContainerBuilder()
                .setAccentColor(8421504) // Grey color
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(lang.giftCode.removeGiftCode.content.title.cancel),
                    new TextDisplayBuilder().setContent(lang.giftCode.removeGiftCode.content.description.cancel)
                )
        ];

        const content = updateComponentsV2AfterSeparator(interaction, container);

        await interaction.update({
            components: content,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleRemoveGiftCancel');
    }
}

module.exports = {
    createRemoveGiftButton,
    handleRemoveGiftButton,
    handleRemoveGiftGameSelection,
    handleRemoveGiftSelect,
    handleRemoveGiftConfirm,
    handleRemoveGiftCancel,
    handleRemoveGiftPagination
};
