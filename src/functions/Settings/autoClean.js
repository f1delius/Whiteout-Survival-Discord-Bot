const {
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const { settingsQueries } = require('../utility/database');
const { getUserInfo, handleError, assertUserMatches } = require('../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');

/**
 * Creates an auto-delete toggle button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @param {boolean} isEnabled - Current state of auto-delete
 * @returns {ButtonBuilder} The auto-delete toggle button
 */
function createAutoDeleteButton(userId, lang, isEnabled) {
    return new ButtonBuilder()
        .setCustomId(`toggle_auto_delete_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.autoDelete)
        .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(isEnabled ? getComponentEmoji(getEmojiMapForUser(userId), '1004') : getComponentEmoji(getEmojiMapForUser(userId), '1051'));
}

/**
 * Creates an auto-remove-transferred-players toggle button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @param {boolean} isEnabled - Current state of auto-remove-transferred-players
 * @returns {ButtonBuilder} The toggle button
 */
function createAutoRemoveTransferredPlayersButton(userId, lang, isEnabled) {
    return new ButtonBuilder()
        .setCustomId(`toggle_auto_remove_transferred_${userId}`)
        .setLabel(lang.settings.mainPage.buttons.autoRemoveTransferred)
        .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(isEnabled ? getComponentEmoji(getEmojiMapForUser(userId), '1004') : getComponentEmoji(getEmojiMapForUser(userId), '1051'));
}

/**
 * Handles auto-delete toggle button interaction
 * @param {import('discord.js').ButtonInteraction} interaction 
 */
async function handleToggleAutoDelete(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        // Verify user
        const expectedUserId = interaction.customId.split('_')[3]; // toggle_auto_delete_userId
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        // Only owner can toggle auto-delete
        if (!adminData.is_owner) {
            await interaction.reply({
                content: lang.common.noPermission,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Toggle auto_delete setting
        const currentSettings = settingsQueries.getSettings.get();
        const newAutoDelete = currentSettings.auto_delete ? 0 : 1;
        settingsQueries.updateAutoDelete.run(newAutoDelete);

        // Refresh features category display (stay on same category page)
        const { createFeaturesCategory } = require('./settings');
        const featuresComponents = createFeaturesCategory(interaction.user.id, adminData, lang);
        await interaction.update({
            components: featuresComponents,
            flags: MessageFlags.IsComponentsV2
        });

    } catch (error) {
        await handleError(interaction, lang, error, 'handleToggleAutoDelete');
    }
}

/**
 * Handles auto-remove-transferred-players toggle button interaction
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleToggleAutoRemoveTransferredPlayers(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    try {
        const expectedUserId = interaction.customId.split('_')[4]; // toggle_auto_remove_transferred_userId
        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData.is_owner) {
            await interaction.reply({
                content: lang.common.noPermission,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const currentSettings = settingsQueries.getSettings.get();
        const newValue = currentSettings.auto_remove_transferred_players ? 0 : 1;
        settingsQueries.updateAutoRemoveTransferredPlayers.run(newValue);

        const { createFeaturesCategory } = require('./settings');
        const featuresComponents = createFeaturesCategory(interaction.user.id, adminData, lang);
        await interaction.update({
            components: featuresComponents,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleToggleAutoRemoveTransferredPlayers');
    }
}

module.exports = {
    createAutoDeleteButton,
    createAutoRemoveTransferredPlayersButton,
    handleToggleAutoDelete,
    handleToggleAutoRemoveTransferredPlayers
};
