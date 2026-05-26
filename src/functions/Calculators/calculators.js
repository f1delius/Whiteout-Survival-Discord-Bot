const {
    ButtonBuilder, ButtonStyle, ActionRowBuilder,
    ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
    SeparatorSpacingSize, MessageFlags
} = require('discord.js');
const { handleError, assertUserMatches, getUserInfo } = require('../utility/commonFunctions');
const { checkFeatureAccess } = require('../utility/checkAccess');
const { getComponentEmoji, getEmojiMapForUser } = require('../utility/emojis');
const { createBackToPanelButton } = require('../Panel/backToPanel');
const buildings = require('./Buildings/buildings');

/**
 * Creates database migration button
 * @param {string} userId
 * @param {Object} lang
 * @returns {ButtonBuilder}
 */
function createCalculatorsButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`calc_main_panel_${userId}`)
        .setLabel(lang.panel.mainPage.buttons.calculators)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1041'));
}

/**
 * Builds the main calculators home panel.
 * @param {string} userId
 * @returns {ContainerBuilder}
 */
function buildCalculatorsPanel(userId) {
    const { lang } = getUserInfo(userId);
    const emojiMap = getEmojiMapForUser(userId);

    const buildingsBtn = new ButtonBuilder()
        .setCustomId(`calc_main_buildings_${userId}`)
        .setLabel(lang.calculators.mainPage.buttons.buildings)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1040'));

    const waBtn = new ButtonBuilder()
        .setCustomId(`calc_main_wa_${userId}`)
        .setLabel(lang.calculators.mainPage.buttons.warAcademy)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(emojiMap, '1012'));

    const backBtn = createBackToPanelButton(userId, lang);

    return new ContainerBuilder()
        .setAccentColor(0x9b59b6)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
               `${lang.calculators.mainPage.content.title}\n` +

               `${lang.calculators.mainPage.content.BuildingsField.name}\n` +
               `${lang.calculators.mainPage.content.BuildingsField.value}\n` +

               `${lang.calculators.mainPage.content.WarAcademyField.name}\n` +
               `${lang.calculators.mainPage.content.WarAcademyField.value}`
            )
        )
        .addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(buildingsBtn, waBtn, backBtn)
        );
}

/**
 * Handles the Calculators button on the user panel.
 * Shows the calculators home panel with available calculator categories.
 * CustomId: calc_main_panel_{userId}
 */
async function handleCalcMainPanel(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // parts: ['calc', 'main', 'panel', userId]
        const userId = parts[parts.length - 1];
        if (!(await assertUserMatches(interaction, userId))) return;

        if (!checkFeatureAccess('calculators', interaction)) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const panel = buildCalculatorsPanel(userId);

        await interaction.update({
            components: [panel],
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, lang, err, 'handleCalcMainPanel');
    }
}

/**
 * Handles navigation back within the Buildings calculator.
 * CustomId:
 * - calc_building_back_main_x_{userId}
 * - calc_building_back_game_{gameType}_{userId}
 * - calc_building_back_type_{gameType}_{userId}
 */
async function handleBuildingBackButton(interaction) {
    const { lang } = getUserInfo(interaction.user.id);
    try {
        const parts = interaction.customId.split('_');
        // parts: ['calc', 'building', 'back', target, gameType|x, userId]
        const userId = parts[parts.length - 1];
        if (!(await assertUserMatches(interaction, userId))) return;

        if (!checkFeatureAccess('calculators', interaction)) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const target = parts[3];
        let components;

        if (target === 'type') {
            const gameType = parts[4];
            components = [buildings.buildTypeSelectionContainer(userId, lang, gameType)];
        } else if (target === 'game') {
            components = [buildings.buildGameSelectionContainer(userId, lang)];
        } else {
            components = [buildCalculatorsPanel(userId)];
        }

        await interaction.update({
            components,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (err) {
        await handleError(interaction, lang, err, 'handleBuildingBackButton');
    }
}

module.exports = {
    buildCalculatorsPanel,
    createCalculatorsButton,
    handleCalcMainPanel,
    handleBuildingBackButton
};
