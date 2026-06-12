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
    UserSelectMenuBuilder,
    ThumbnailBuilder
} = require('discord.js');
const { adminQueries, adminLogQueries, userQueries, db } = require('../../utility/database');
const { LOG_CODES } = require('../../utility/AdminLogs');
const { PERMISSIONS } = require('./permissions');
const { getUserInfo, assertUserMatches, handleError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getEmojiMapForUser, getComponentEmoji } = require('../../utility/emojis');
const { adminUsernameCache } = require('../../utility/adminUsernameCache');

function createTransferOwnerButton(userId, lang = {}, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(`transfer_owner_${userId}`)
        .setLabel(lang.settings.adminManagement.mainPage.buttons.transferOwner)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1050'))
        .setDisabled(disabled);
}

async function handleTransferOwnerButton(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[2];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData?.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const userSelect = new UserSelectMenuBuilder()
            .setCustomId(`select_user_transfer_owner_${interaction.user.id}`)
            .setPlaceholder(lang.settings.adminManagement.transferOwner.selectMenu.selectUser.placeholder)
            .setMinValues(1)
            .setMaxValues(1);

        const actionRow = new ActionRowBuilder().addComponents(userSelect);

        const components = [
            new ContainerBuilder()
                .setAccentColor(0xe67e22)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.settings.adminManagement.transferOwner.content.title.base}\n` +
                        `${lang.settings.adminManagement.transferOwner.content.description.base}`
                    )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(actionRow)
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, components);

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleTransferOwnerButton');
    }
}

async function handleTransferOwnerUserSelection(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[4];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData?.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const selectedUserId = interaction.values[0];

        if (selectedUserId === interaction.user.id) {
            return await interaction.reply({
                content: lang.settings.adminManagement.transferOwner.errors.ownerAlreadySelected,
                ephemeral: true
            });
        }

        const selectedUser = await interaction.client.users.fetch(selectedUserId);

        if (selectedUser.bot) {
            return await interaction.reply({
                content: lang.settings.adminManagement.transferOwner.errors.userIsBot,
                ephemeral: true
            });
        }

        const confirmationRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_transfer_owner_${interaction.user.id}_${selectedUserId}`)
                    .setLabel(lang.settings.adminManagement.transferOwner.buttons.confirm)
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji(getComponentEmoji(getEmojiMapForUser(selectedUserId), '1004')),
                new ButtonBuilder()
                    .setCustomId(`cancel_transfer_owner_${interaction.user.id}`)
                    .setLabel(lang.settings.adminManagement.transferOwner.buttons.cancel)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji(getComponentEmoji(getEmojiMapForUser(selectedUserId), '1051'))
            );

        const components = [
            new ContainerBuilder()
                .setAccentColor(0xe74c3c)
                .addSectionComponents(
                    new SectionBuilder()
                        .setThumbnailAccessory(
                            new ThumbnailBuilder()
                                .setURL(selectedUser.displayAvatarURL())
                        )
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `${lang.settings.adminManagement.transferOwner.content.title.confirm}\n` +
                                `${lang.settings.adminManagement.transferOwner.content.description.confirm.replace('{userDiscordMention}', `<@${selectedUser.id}>`)}`
                            )
                        )
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                )
                .addActionRowComponents(confirmationRow)
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, components);

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleTransferOwnerUserSelection');
    }
}

const transferOwnerTransaction = db.transaction((currentOwnerId, newOwnerId) => {
    const targetAdmin = adminQueries.getAdmin(newOwnerId);

    if (!targetAdmin) {
        adminQueries.addAdmin(newOwnerId, currentOwnerId, 0, '[]', 0);
    }

    userQueries.upsertUser(newOwnerId);
    adminQueries.updateAdminPermissions(PERMISSIONS.FULL_ACCESS, currentOwnerId);
    adminQueries.updateOwnerStatus(0, currentOwnerId);
    adminQueries.updateOwnerStatus(1, newOwnerId);
});

async function handleConfirmTransferOwner(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        const customIdParts = interaction.customId.split('_');
        const expectedUserId = customIdParts[3];
        const newOwnerId = customIdParts[4];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData?.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        if (newOwnerId === interaction.user.id) {
            return await interaction.reply({
                content: lang.settings.adminManagement.transferOwner.errors.ownerAlreadySelected,
                ephemeral: true
            });
        }

        const newOwner = await interaction.client.users.fetch(newOwnerId);

        if (newOwner.bot) {
            return await interaction.reply({
                content: lang.settings.adminManagement.transferOwner.errors.userIsBot,
                ephemeral: true
            });
        }

        transferOwnerTransaction(interaction.user.id, newOwnerId);
        await adminUsernameCache.add(newOwnerId);

        adminLogQueries.addLog(
            interaction.user.id,
            LOG_CODES.SETTINGS.OWNER_TRANSFERRED,
            JSON.stringify({
                previousOwner: interaction.user.tag,
                previousOwnerId: interaction.user.id,
                newOwner: newOwner.tag,
                newOwnerId: newOwner.id
            })
        );

        const components = [
            new ContainerBuilder()
                .setAccentColor(0x57F287)
                .addSectionComponents(
                    new SectionBuilder()
                        .setThumbnailAccessory(
                            new ThumbnailBuilder()
                                .setURL(newOwner.displayAvatarURL())
                        )
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `${lang.settings.adminManagement.transferOwner.content.title.success}\n` +
                                `${lang.settings.adminManagement.transferOwner.content.description.success.replace('{userDiscordTag}', newOwner.tag)}`
                            )
                        )
                )
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, components);

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleConfirmTransferOwner');
    }
}

async function handleCancelTransferOwner(interaction) {
    const { adminData, lang } = getUserInfo(interaction.user.id);

    try {
        const expectedUserId = interaction.customId.split('_')[3];

        if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

        if (!adminData?.is_owner) {
            return await interaction.reply({
                content: lang.common.noPermission,
                ephemeral: true
            });
        }

        const components = [
            new ContainerBuilder()
                .setAccentColor(0xf39c12)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${lang.settings.adminManagement.transferOwner.content.title.cancel}\n` +
                        `${lang.settings.adminManagement.transferOwner.content.description.cancel}`
                    )
                )
        ];

        const newSection = updateComponentsV2AfterSeparator(interaction, components);

        await interaction.update({
            components: newSection,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        await handleError(interaction, lang, error, 'handleCancelTransferOwner');
    }
}

module.exports = {
    createTransferOwnerButton,
    handleTransferOwnerButton,
    handleTransferOwnerUserSelection,
    handleConfirmTransferOwner,
    handleCancelTransferOwner
};
