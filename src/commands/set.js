const { SlashCommandBuilder, SlashCommandSubcommandBuilder } = require('discord.js');
const { playerQueries, systemLogQueries, nicknameChangeQueries } = require('../functions/utility/database');
const { PERMISSIONS } = require('../functions/Settings/admin/permissions');
const { getUserInfo, handleError, hasPermission, getAlliancesForUserByGame } = require('../functions/utility/commonFunctions');
const { getDefaultGameType, isMultiGameModeEnabled } = require('../functions/utility/gameRuntime');
const { normalizeGameType } = require('../functions/utility/gameProfiles');
const { MAX_NICKNAME_LENGTH, formatPlayerWithId } = require('../functions/Players/playerDisplay');

function buildPlayerSubcommand() {
    const sub = new SlashCommandSubcommandBuilder()
        .setName('player')
        .setDescription('Set a player nickname or state override.')
        .addStringOption((option) => option
            .setName('player')
            .setDescription('Player to update (search by ID or nickname).')
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(100))
        .addStringOption((option) => option
            .setName('option')
            .setDescription('What to set for this player.')
            .setRequired(true)
            .addChoices(
                { name: 'Nickname', value: 'nickname' },
                { name: 'State', value: 'state' }
            ))
        .addStringOption((option) => option
            .setName('value')
            .setDescription(`New nickname (max ${MAX_NICKNAME_LENGTH} chars) or state number (clear/none removes the override).`)
            .setRequired(true)
            .setMaxLength(50));

    if (isMultiGameModeEnabled()) {
        sub.addStringOption((option) => option
            .setName('game')
            .setDescription('Game type.')
            .setRequired(true)
            .addChoices(
                { name: 'Whiteout Survival', value: 'wos' },
                { name: 'Kingshot', value: 'ks' }
            ));
    }

    return sub;
}

async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'player') {
        return interaction.respond([]);
    }

    const { adminData } = getUserInfo(interaction.user.id);
    const gameType = normalizeGameType(
        interaction.options.getString('game') || getDefaultGameType()
    );
    const accessible = getAlliancesForUserByGame(adminData, gameType, PERMISSIONS.PLAYER_MANAGEMENT);
    if (accessible.length === 0) {
        return interaction.respond([]);
    }

    const players = playerQueries.searchPlayersByQuery(
        focused.value.trim(),
        accessible.map((alliance) => alliance.id),
        gameType
    );

    return interaction.respond(
        players.map((player) => ({
            name: formatPlayerWithId(player),
            value: String(player.fid)
        }))
    );
}

async function execute(interaction) {
    const { lang, adminData } = getUserInfo(interaction.user.id);
    const errors = lang?.players?.setPlayer?.errors || {};

    try {
        if (interaction.options.getSubcommand() !== 'player') {
            return;
        }

        const hasAccess = hasPermission(adminData, PERMISSIONS.FULL_ACCESS, PERMISSIONS.PLAYER_MANAGEMENT);
        if (!hasAccess) {
            return interaction.reply({ content: lang.common.noPermission, ephemeral: true });
        }

        const gameType = normalizeGameType(
            interaction.options.getString('game') || getDefaultGameType()
        );
        const fid = Number(interaction.options.getString('player'));
        const option = interaction.options.getString('option');
        const rawValue = interaction.options.getString('value').trim();

        const player = playerQueries.getPlayer(fid, gameType);
        if (!player) {
            return interaction.reply({ content: errors.playerNotFound, ephemeral: true });
        }

        // Only admins assigned to the player's alliance (or full-access) may edit it.
        const accessible = getAlliancesForUserByGame(adminData, gameType, PERMISSIONS.PLAYER_MANAGEMENT);
        const accessibleIds = new Set(accessible.map((alliance) => String(alliance.id)));
        if (!accessibleIds.has(String(player.alliance_id))) {
            return interaction.reply({ content: errors.noAccessToPlayer, ephemeral: true });
        }

        let replyContent;
        if (option === 'nickname') {
            const nickname = rawValue;
            if (nickname.length > MAX_NICKNAME_LENGTH) {
                return interaction.reply({
                    content: errors.nicknameTooLong.replace('{max}', MAX_NICKNAME_LENGTH),
                    ephemeral: true
                });
            }

            playerQueries.updatePlayerNickname(fid, nickname, gameType);
            nicknameChangeQueries.addNicknameChange(fid, player.nickname || '', nickname, gameType);
            systemLogQueries.addLog(
                'player_nickname',
                `Player nickname updated to: ${nickname}`,
                JSON.stringify({
                    fid,
                    game_type: gameType,
                    old_nickname: player.nickname || '',
                    new_nickname: nickname,
                    updated_by: interaction.user.id,
                    updated_by_tag: interaction.user.tag
                })
            );

            replyContent = lang.players.setPlayer.content.nicknameSet
                .replace('{player}', formatPlayerWithId(player))
                .replace('{nickname}', nickname);
        } else if (option === 'state') {
            const isClear = /^(clear|none)$/i.test(rawValue);
            const state = isClear ? null : Number(rawValue);

            if (!isClear && (!Number.isSafeInteger(state) || state <= 0)) {
                return interaction.reply({ content: errors.invalidState, ephemeral: true });
            }

            playerQueries.updatePlayerStateOverride(fid, state, gameType);
            systemLogQueries.addLog(
                'player_state_override',
                state == null ? 'Player state override cleared' : `Player state override set to: ${state}`,
                JSON.stringify({
                    fid,
                    game_type: gameType,
                    state_override: state,
                    updated_by: interaction.user.id,
                    updated_by_tag: interaction.user.tag
                })
            );

            const updatedPlayer = { ...player, state_override: state };
            const content = lang.players.setPlayer.content;
            replyContent = state == null
                ? content.stateCleared.replace('{player}', formatPlayerWithId(updatedPlayer))
                : content.stateSet
                    .replace('{player}', formatPlayerWithId(updatedPlayer))
                    .replace('{state}', state);
        } else {
            return interaction.reply({ content: errors.invalidGameType, ephemeral: true });
        }

        return interaction.reply({ content: replyContent, ephemeral: true });
    } catch (error) {
        await handleError(interaction, lang, error, 'setPlayerCommand');
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set')
        .setDescription('Manage player settings.')
        .addSubcommand(buildPlayerSubcommand()),
    autocomplete,
    execute
};
