const { EmbedBuilder } = require('discord.js');
const { playerQueries, allianceQueries } = require('../utility/database');
const { fetchPlayerData } = require('../utility/apiClient');
const { getFurnaceReadable, getSettlementLevelLabel } = require('./furnaceReadable');
const { getGlobalEmojiMap, replaceEmojiPlaceholders } = require('../utility/emojis');
const { checkFeatureAccess } = require('../utility/checkAccess');
const { getGameProfile, normalizeGameType } = require('../utility/gameProfiles');
const { getDefaultGameType, isGameEnabled, isMultiGameModeEnabled } = require('../utility/gameRuntime');
const { getUserInfo, getAlliancesForUser } = require('../utility/commonFunctions');

/**
 * Computes Levenshtein distance between two strings (case-insensitive)
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    const matrix = [];

    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            const cost = a[j - 1] === b[i - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Handles autocomplete for the inspect command.
 * Fuzzy-matches player FID or nickname from the database.
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
async function handleInspectAutocomplete(interaction) {
    const focusedValue = interaction.options.getFocused().trim();
    if (!focusedValue) {
        return interaction.respond([]);
    }

    const selectedGameType = normalizeGameType(interaction.options.getString('game'), null);
    const defaultGameType = getDefaultGameType();
    const allPlayers = playerQueries.getAllPlayers().filter((player) => {
        if (selectedGameType) {
            return player.game_type === selectedGameType;
        }

        if (!isMultiGameModeEnabled()) {
            return player.game_type === defaultGameType;
        }

        return true;
    });
    const query = focusedValue.toLowerCase();

    // Score each player: exact/prefix matches get priority, then fuzzy
    const scored = allPlayers.map(p => {
        const fid = String(p.fid);
        const nick = (p.nickname || '').toLowerCase();

        // Exact match on FID
        if (fid === query) return { player: p, score: 0 };

        // FID starts with query
        if (fid.startsWith(query)) return { player: p, score: 1 };

        // Nickname exact match
        if (nick === query) return { player: p, score: 0 };

        // Nickname starts with query
        if (nick.startsWith(query)) return { player: p, score: 2 };

        // Nickname contains query
        if (nick.includes(query)) return { player: p, score: 3 };

        // Fuzzy match — allow 1–2 character tolerance based on length
        const maxDist = query.length <= 3 ? 1 : 2;
        const dist = levenshtein(query, nick);
        if (dist <= maxDist) return { player: p, score: 4 + dist };

        // Also fuzzy match against substrings of the nickname
        if (nick.length > query.length) {
            for (let i = 0; i <= nick.length - query.length; i++) {
                const sub = nick.substring(i, i + query.length);
                const subDist = levenshtein(query, sub);
                if (subDist <= 1) return { player: p, score: 5 + subDist };
            }
        }

        return null;
    }).filter(Boolean);

    // Sort by score, then alphabetically
    scored.sort((a, b) => a.score - b.score || (a.player.nickname || '').localeCompare(b.player.nickname || ''));

    // Discord allows max 25 autocomplete results
    const includeGameLabel = isMultiGameModeEnabled() && !selectedGameType;
    const results = scored.slice(0, 25).map(({ player }) => {
        const gameLabel = includeGameLabel ? ` [${getGameProfile(player.game_type).shortLabel}]` : '';
        const name = `${player.nickname || 'Unknown'}${gameLabel} (${player.fid}) - ${getFurnaceReadable(player.furnace_level, null, player.game_type)}`;
        return {
            name: name.substring(0, 100),
            value: String(player.fid)
        };
    });

    await interaction.respond(results);
}

/**
 * Builds an embed displaying player information from API data
 * @param {Object} apiData - Player data from the API
 * @param {number} fid - Player FID
 * @param {string|null} allianceName - Alliance name if player exists in DB
 * @returns {EmbedBuilder}
 */
function buildPlayerInfoEmbed(apiData, fid, allianceName = null, gameType = 'wos') {
    const emojiMap = getGlobalEmojiMap();
    const profile = getGameProfile(gameType);
    const title = replaceEmojiPlaceholders('{emoji.1026} Player Info', emojiMap);
    const furnaceLevel = apiData.stove_lv ?? apiData.furnace_lv ?? 0;
    const levelLabel = getSettlementLevelLabel(gameType);

    const lines = [
        `- ${apiData.nickname || 'Unknown'}`,
        `  - ID: ${fid}`,
        `  - Game: ${profile.displayName}`,
        `  - ${levelLabel}: ${getFurnaceReadable(furnaceLevel, null, gameType)}`
    ];

    if (allianceName) {
        lines.push(`  - Alliance: ${allianceName}`);
    }

    lines.push(`  - State: ${apiData.kid ?? 'Unknown'}`);

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(lines.join('\n'))
        .setColor(0x3498DB)
        .setTimestamp();

    if (apiData.avatar_image) {
        embed.setThumbnail(apiData.avatar_image);
    }

    return embed;
}

/**
 * Handles the /inspect command execution — always fetches live data from the API
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleInspectCommand(interaction) {
    if (!checkFeatureAccess('inspect', interaction)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const playerInput = interaction.options.getString('player');
    const requestedGameType = normalizeGameType(interaction.options.getString('game'), null);

    const playerId = parseInt(playerInput);
    if (isNaN(playerId)) {
        return interaction.reply({
            content: 'Please provide a valid Player ID.',
            ephemeral: true
        });
    }

    if (requestedGameType && !isGameEnabled(requestedGameType)) {
        return interaction.reply({
            content: `The ${getGameProfile(requestedGameType).displayName} profile is not enabled in this bot run.`,
            ephemeral: true
        });
    }

    const matchingPlayers = playerQueries.getPlayersByFidAny(playerId);
    let resolvedGameType = requestedGameType;
    if (!resolvedGameType) {
        if (matchingPlayers.length === 1) {
            resolvedGameType = matchingPlayers[0].game_type;
        } else if (!isMultiGameModeEnabled()) {
            resolvedGameType = getDefaultGameType();
        } else if (matchingPlayers.length > 1) {
            return interaction.reply({
                content: 'This player ID exists in more than one game. Please run `/inspect` again and choose the `game` option.',
                ephemeral: true
            });
        } else {
            return interaction.reply({
                content: 'Please choose a game with `/inspect` when running in both mode.',
                ephemeral: true
            });
        }
    }

    // Check DB for alliance info
    const dbPlayer = matchingPlayers.find((player) => player.game_type === resolvedGameType) || null;
    const { adminData } = getUserInfo(interaction.user.id);
    let allianceName = null;
    if (dbPlayer?.alliance_id) {
        const alliance = allianceQueries.getAllianceById(dbPlayer.alliance_id, dbPlayer.game_type);
        if (alliance) {
            const accessibleAllianceIds = new Set(
                getAlliancesForUser(adminData).map((entry) => entry.id)
            );

            if (accessibleAllianceIds.has(alliance.id)) {
                allianceName = alliance.name;
            }
        }
    }

    // Reply with "fetching" embed first to prevent interaction timeout
    const emojiMap = getGlobalEmojiMap();
    const fetchingEmbed = new EmbedBuilder()
        .setTitle(replaceEmojiPlaceholders('{emoji.1026} Player Info', emojiMap))
        .setDescription('Fetching player information...')
        .setColor(0xFFA500)
        .setTimestamp();

    await interaction.reply({ embeds: [fetchingEmbed], ephemeral: true });

    try {
        const apiData = await fetchPlayerData(playerId, {
            returnErrorObject: true,
            gameType: resolvedGameType
        });

        if (!apiData || apiData.error || apiData.playerNotExist) {
            const errorEmbed = new EmbedBuilder()
                .setTitle(replaceEmojiPlaceholders('{emoji.1026} Player Info', emojiMap))
                .setDescription(`Player with ID \`${playerId}\` was not found.`)
                .setColor(0xFF0000)
                .setTimestamp();

            return interaction.editReply({ embeds: [errorEmbed] });
        }

        const embed = buildPlayerInfoEmbed(apiData, playerId, allianceName, resolvedGameType);
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        const errorEmbed = new EmbedBuilder()
            .setTitle(replaceEmojiPlaceholders('{emoji.1026} Player Info', emojiMap))
            .setDescription('Failed to fetch player data. Please try again later.')
            .setColor(0xFF0000)
            .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

module.exports = {
    handleInspectAutocomplete,
    handleInspectCommand
};
