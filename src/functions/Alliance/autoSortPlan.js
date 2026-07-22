function getMajority(alliance, players) {
    const valid = players.filter(player => Number.isSafeInteger(player.state) && player.state > 0);
    if (valid.length === 0) return null;

    const counts = new Map();
    for (const player of valid) counts.set(player.state, (counts.get(player.state) || 0) + 1);

    const [state, count] = [...counts.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        if (a[0] === alliance.state) return -1;
        if (b[0] === alliance.state) return 1;
        return a[0] - b[0];
    })[0];

    return count > valid.length / 2 ? { state, count, total: valid.length } : null;
}

function buildAutoSortPlan(alliances, players) {
    const allianceById = new Map(alliances.map(alliance => [alliance.id, alliance]));
    const playersByAlliance = new Map(alliances.map(alliance => [alliance.id, []]));
    const skipped = [];

    for (const player of players) {
        if (!allianceById.has(player.alliance_id) || !Number.isSafeInteger(player.state) || player.state <= 0) {
            skipped.push(player);
            continue;
        }
        playersByAlliance.get(player.alliance_id).push(player);
    }

    const majorities = [];
    for (const alliance of alliances) {
        const majority = getMajority(alliance, playersByAlliance.get(alliance.id));
        if (majority) majorities.push({ alliance, ...majority });
    }

    const targetByState = new Map();
    for (const majority of majorities) {
        const current = targetByState.get(majority.state);
        if (!current ||
            majority.count > current.count ||
            (majority.count === current.count && majority.alliance.priority < current.alliance.priority) ||
            (majority.count === current.count && majority.alliance.priority === current.alliance.priority && majority.alliance.id < current.alliance.id)) {
            targetByState.set(majority.state, majority);
        }
    }

    const majorityByAlliance = new Map(majorities.map(item => [item.alliance.id, item]));
    const moves = [];
    const newAllianceStates = new Set();

    for (const player of players) {
        if (!allianceById.has(player.alliance_id) || !Number.isSafeInteger(player.state) || player.state <= 0) continue;

        const currentMajority = majorityByAlliance.get(player.alliance_id);
        if (currentMajority?.state === player.state) continue;

        const target = targetByState.get(player.state);
        if (target) {
            moves.push({ player, targetAllianceId: target.alliance.id, state: player.state });
        } else {
            newAllianceStates.add(player.state);
            moves.push({ player, targetAllianceId: null, state: player.state });
        }
    }

    return {
        majorities,
        moves,
        newAllianceStates: [...newAllianceStates].sort((a, b) => a - b),
        skipped
    };
}

module.exports = { buildAutoSortPlan, getMajority };
