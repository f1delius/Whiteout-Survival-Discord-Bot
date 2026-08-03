/**
 * Shared player display helpers.
 * Nickname is the primary label wherever a player is shown; the game ID is secondary.
 */

const MAX_NICKNAME_LENGTH = 16;

function getNickname(player) {
    return (player?.nickname || '').trim() || null;
}

/**
 * Primary label: nickname when set, otherwise "ID {fid}".
 */
function formatPlayerName(player) {
    return getNickname(player) || `ID ${player?.fid}`;
}

/**
 * Inline display with the ID kept secondary: "Nickname (ID 123)" or "ID 123".
 */
function formatPlayerWithId(player) {
    const nickname = getNickname(player);
    return nickname ? `${nickname} (ID ${player.fid})` : `ID ${player.fid}`;
}

/**
 * Select-menu option shape: label is the nickname (or "ID {fid}"); when a
 * nickname exists the ID moves to the description (nickname primary, ID secondary).
 * @param {Object} player - Player row
 * @param {string} [extraDescription] - Additional context (e.g. state text)
 */
function formatPlayerSelectOption(player, extraDescription = '') {
    const nickname = getNickname(player);
    const idPart = nickname ? `ID ${player.fid}` : '';
    return {
        label: formatPlayerName(player),
        description: [idPart, extraDescription].filter(Boolean).join(' • ') || undefined
    };
}

/**
 * Effective state used for redemption: admin override first, then alliance state,
 * then the stored snapshot.
 */
function getEffectivePlayerState(player, allianceState = null) {
    const override = player?.state_override;
    if (override != null && Number.isSafeInteger(Number(override)) && Number(override) > 0) {
        return Number(override);
    }
    if (allianceState != null && Number.isSafeInteger(Number(allianceState)) && Number(allianceState) > 0) {
        return Number(allianceState);
    }
    if (player?.state != null && Number.isSafeInteger(Number(player.state)) && Number(player.state) > 0) {
        return Number(player.state);
    }
    return null;
}

/**
 * Multi-line player entry used by the View Players list.
 * Title is the nickname (or "ID {fid}"); the ID becomes a sub-row only when a
 * nickname exists. An override state is marked so it is distinguishable from
 * the alliance state.
 * @param {Object} player - Player row from the database
 * @param {number|null} allianceState - Alliance state for effective-state display
 * @param {Object} lang - Language object (players.viewPlayers.content.playerField)
 */
function formatPlayerLine(player, allianceState = null, lang = {}) {
    const tpl = lang?.players?.viewPlayers?.content?.playerField || {};
    const nickname = getNickname(player);
    const effectiveState = getEffectivePlayerState(player, allianceState);
    const stateText = effectiveState != null ? String(effectiveState) : 'Unknown';
    const overrideSuffix = player?.state_override != null
        ? (tpl.overrideMarker || ' (override)')
        : '';

    if (nickname) {
        const template = tpl.withNickname || '- **{nickname}**\n  - Game ID: {fid}\n  - Assigned State: {state}';
        return template
            .replace('{nickname}', nickname)
            .replace('{fid}', player.fid)
            .replace('{state}', stateText + overrideSuffix);
    }

    const template = tpl.withoutNickname || '- **ID {fid}**\n  - Assigned State: {state}';
    return template
        .replace('{fid}', player.fid)
        .replace('{state}', stateText + overrideSuffix);
}

module.exports = {
    MAX_NICKNAME_LENGTH,
    formatPlayerName,
    formatPlayerWithId,
    formatPlayerSelectOption,
    getEffectivePlayerState,
    formatPlayerLine
};
