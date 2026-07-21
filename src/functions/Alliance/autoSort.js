const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder
} = require('discord.js');
const { db, allianceQueries, playerQueries } = require('../utility/database');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { getUserInfo, assertUserMatches, handleError, hasPermission } = require('../utility/commonFunctions');
const { PERMISSIONS } = require('../Settings/admin/permissions');
const { buildAutoSortPlan: buildAutoSortPlanShared } = require('./autoSortPlan');

function createAutoSortButton(userId, lang = {}) {
    return new ButtonBuilder()
        .setCustomId(`auto_sort_${userId}`)
        .setLabel(lang.alliance?.mainPage?.buttons?.autoSort || 'Auto-Sort')
        .setStyle(ButtonStyle.Primary);
}

function loadPlan(gameType) {
    const alliances = allianceQueries.getAllAlliances(gameType);
    const players = playerQueries.getAllPlayers(gameType);
    return { alliances, plan: buildAutoSortPlanShared(alliances, players) };
}

function applyAutoSortPlan(gameType, plan, alliances, createdBy) {
    const transaction = db.transaction(() => {
        const newAllianceIds = new Map();
        let nextPriority = alliances.reduce((max, alliance) => Math.max(max, alliance.priority || 0), 0) + 1;

        for (const state of plan.newAllianceStates) {
            const result = allianceQueries.addAlliance(
                nextPriority++,
                String(state),
                null,
                null,
                0,
                1,
                createdBy,
                gameType,
                state
            );
            newAllianceIds.set(state, Number(result.lastInsertRowid));
        }

        for (const majority of plan.majorities) {
            allianceQueries.setAllianceState(majority.alliance.id, majority.state, gameType);
        }

        for (const move of plan.moves) {
            const targetAllianceId = move.targetAllianceId || newAllianceIds.get(move.state);
            playerQueries.updatePlayerAlliance(move.player.fid, targetAllianceId, move.state, gameType);
        }

        return newAllianceIds;
    });

    return transaction();
}

function render(interaction, content, buttons = []) {
    const container = new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    if (buttons.length) container.addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
    return interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
}

async function assertAccess(interaction, expectedUserId) {
    const { adminData, lang } = getUserInfo(interaction.user.id);
    if (!(await assertUserMatches(interaction, expectedUserId, lang))) return null;
    if (!hasPermission(adminData, PERMISSIONS.FULL_ACCESS)) {
        await interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        return null;
    }
    return { lang };
}

async function showPreview(interaction, gameType, lang) {
    const { alliances, plan } = loadPlan(gameType);
    if (alliances.length === 0) {
        return render(interaction, `### Auto-Sort (${gameType.toUpperCase()})\nNo alliances found.`);
    }

    const content = [
        `### Auto-Sort Preview (${gameType.toUpperCase()})`,
        'Uses each player\'s last stored or assigned state. New and moved players already inherit their alliance state; live transfer detection is no longer available.',
        `- Majority alliances found: **${plan.majorities.length}**`,
        `- Players to move: **${plan.moves.length}**`,
        `- New state alliances: **${plan.newAllianceStates.length ? plan.newAllianceStates.join(', ') : 'None'}**`,
        `- Players skipped (unknown state): **${plan.skipped.length}**`,
        '',
        'Existing empty alliances will not be deleted.'
    ].join('\n');

    return render(interaction, content, [
        new ButtonBuilder()
            .setCustomId(`auto_sort_confirm_${gameType}_${interaction.user.id}`)
            .setLabel('Confirm Auto-Sort')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`auto_sort_cancel_${interaction.user.id}`)
            .setLabel(lang.common?.buttons?.cancel || 'Cancel')
            .setStyle(ButtonStyle.Secondary)
    ]);
}

async function handleAutoSortButton(interaction) {
    const expectedUserId = interaction.customId.slice('auto_sort_'.length);
    const access = await assertAccess(interaction, expectedUserId);
    if (!access) return;

    try {
        if (!isMultiGameModeEnabled()) return showPreview(interaction, getDefaultGameType(), access.lang);

        return render(interaction, '### Auto-Sort\nChoose the game whose alliances you want to sort.', [
            new ButtonBuilder().setCustomId(`auto_sort_preview_wos_${interaction.user.id}`).setLabel('Whiteout Survival').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`auto_sort_preview_ks_${interaction.user.id}`).setLabel('Kingshot').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`auto_sort_cancel_${interaction.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        ]);
    } catch (error) {
        await handleError(interaction, access.lang, error, 'handleAutoSortButton');
    }
}

async function handleAutoSortPreview(interaction) {
    const [, , , gameType, expectedUserId] = interaction.customId.split('_');
    const access = await assertAccess(interaction, expectedUserId);
    if (!access) return;
    try {
        return await showPreview(interaction, gameType, access.lang);
    } catch (error) {
        await handleError(interaction, access.lang, error, 'handleAutoSortPreview');
    }
}

async function handleAutoSortConfirm(interaction) {
    const [, , , gameType, expectedUserId] = interaction.customId.split('_');
    const access = await assertAccess(interaction, expectedUserId);
    if (!access) return;

    try {
        const { alliances, plan } = loadPlan(gameType);
        applyAutoSortPlan(gameType, plan, alliances, interaction.user.id);

        return render(interaction, [
            `### Auto-Sort Complete (${gameType.toUpperCase()})`,
            `- Players moved: **${plan.moves.length}**`,
            `- Alliances created: **${plan.newAllianceStates.length}**`,
            `- Players skipped (unknown state): **${plan.skipped.length}**`
        ].join('\n'));
    } catch (error) {
        await handleError(interaction, access.lang, error, 'handleAutoSortConfirm');
    }
}

async function handleAutoSortCancel(interaction) {
    const expectedUserId = interaction.customId.slice('auto_sort_cancel_'.length);
    const access = await assertAccess(interaction, expectedUserId);
    if (!access) return;
    return render(interaction, 'Auto-Sort cancelled. No players were moved.');
}

module.exports = {
    buildAutoSortPlan: buildAutoSortPlanShared,
    createAutoSortButton,
    handleAutoSortButton,
    handleAutoSortPreview,
    handleAutoSortConfirm,
    handleAutoSortCancel
};
