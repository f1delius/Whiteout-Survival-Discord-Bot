const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { encodeData } = require('../src/functions/utility/apiClient');
const { buildAutoSortPlan, getMajority } = require('../src/functions/Alliance/autoSortPlan');
const { formatAllianceStateDescription } = require('../src/functions/Alliance/allianceStateDescription');

function loadRedeemFunctions() {
    const modulePath = require.resolve('../src/functions/GiftCode/redeemFunction');
    const originalLoad = Module._load;

    Module._load = function loadMock(request, parent, isMain) {
        if (parent?.filename === modulePath) {
            const mocks = {
                'discord.js': {},
                '../utility/commonFunctions': { handleError: async () => {} },
                '../Processes/createProcesses': {},
                '../Processes/queueManager': { queueManager: null },
                '../Processes/executeProcesses': { processExecutor: null },
                '../utility/database': {
                    systemLogQueries: { addLog() {} },
                    allianceQueries: { getAllianceById: () => ({ state: null }) }
                },
                './setTestId': {},
                '../utility/apiConfig': { API_CONFIG: { RATE_LIMIT_DELAY: 60000, MAX_RETRY_CYCLES: 10 }, getApiConfig: () => ({}) },
                '../utility/gameRuntime': { getDefaultGameType: () => 'wos' },
                '../utility/apiClient': { nativePost: async () => ({}) }
            };
            if (Object.hasOwn(mocks, request)) return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[modulePath];
    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
}

function loadMigrationFunctions(users, calls) {
    const modulePath = require.resolve('../src/functions/Settings/migration');
    const originalLoad = Module._load;

    class FakeDatabase {
        prepare() {
            return { all: () => users };
        }

        close() {
            calls.closed = true;
        }
    }

    Module._load = function loadMock(request, parent, isMain) {
        if (parent?.filename === modulePath) {
            const mocks = {
                'discord.js': {},
                'better-sqlite3': FakeDatabase,
                '../utility/commonFunctions': {},
                '../utility/emojis': {},
                '../utility/database': {
                    playerQueries: { addPlayer: (...args) => calls.players.push(args) },
                    allianceQueries: { setAllianceState: (...args) => calls.states.push(args) }
                },
                '../Players/furnaceReadable': {},
                '../utility/gameRuntime': { getDefaultGameType: () => 'wos' },
                '../utility/gameProfiles': {}
            };
            if (Object.hasOwn(mocks, request)) return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[modulePath];
    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
}

test('WOS one-request payload matches the captured signature', () => {
    const body = encodeData({
        fid: '63595120',
        cdk: 'gogoWOS',
        kid: '437',
        time: '1784632285'
    }, 'wos');

    assert.equal(
        body,
        'sign=e3ed93d45459161272dc24b02fee1e7f&cdk=gogoWOS&fid=63595120&kid=437&time=1784632285'
    );
    assert.equal(body.includes('captcha_code'), false);
});

test('Kingshot uses the same one-request payload with its own secret', () => {
    const body = encodeData({
        fid: '12345678',
        cdk: 'TESTCODE',
        kid: '123',
        time: '1784650000'
    }, 'ks');

    assert.equal(
        body,
        'sign=4af67d309124c2abd1b3308ba0a6a40a&cdk=TESTCODE&fid=12345678&kid=123&time=1784650000'
    );
    assert.equal(body.includes('captcha_code'), false);
});

test('USER INFO ERROR reports wrong-state FIDs separately', () => {
    const { analyzeAPIResponse, computeRedeemStats } = loadRedeemFunctions();
    const outcome = analyzeAPIResponse({
        code: 1,
        data: [],
        msg: 'USER INFO ERROR.',
        err_code: 40020
    }, 'redeem');

    assert.equal(outcome.status, 'USER INFO ERROR');
    assert.equal(outcome.wrongState, true);
    assert.equal(outcome.giftCodeActive, true);
    assert.equal(outcome.success, false);

    const stats = computeRedeemStats(
        { allItems: [{ id: 12345678, status: 'redeem' }, { id: 87654321, status: 'redeem' }] },
        [
            { ...outcome, playerId: 12345678, operation: 'redeem' },
            { success: false, status: 'NETWORK_ERROR', playerId: 87654321, operation: 'redeem' }
        ],
        { pending: [] }
    );

    assert.deepEqual(stats.wrongStateIds, ['12345678']);
    assert.equal(stats.failed, 1);
});

test('gift code validation only removes codes after a definitive inactive response', () => {
    const { classifyGiftCodeValidationResult } = loadRedeemFunctions();

    assert.equal(classifyGiftCodeValidationResult({ success: true, giftCodeActive: true }), 'active');
    assert.equal(classifyGiftCodeValidationResult({ success: false, giftCodeActive: true, rateLimited: true }), 'retry');
    assert.equal(classifyGiftCodeValidationResult({ success: false, giftCodeActive: true, wrongState: true }), 'retry');
    assert.equal(classifyGiftCodeValidationResult({ success: false, giftCodeActive: false, status: 'NETWORK_ERROR' }), 'retry');
    assert.equal(classifyGiftCodeValidationResult({ success: true, giftCodeActive: false, status: 'TIME ERROR' }), 'invalid');
    assert.equal(classifyGiftCodeValidationResult(null), 'retry');
});

test('redeem creation silently skips an alliance without a valid state', async () => {
    const { createRedeemProcess } = loadRedeemFunctions();
    const result = await createRedeemProcess([
        { id: '12345678', giftCode: 'TESTCODE', status: 'redeem' }
    ], {
        allianceContext: { id: 7, name: 'No State' },
        gameType: 'wos'
    });

    assert.deepEqual(result, {
        success: true,
        skipped: true,
        processId: null,
        message: 'Alliance skipped because it has no valid state'
    });
});

test('alliance option descriptions include the assigned state', () => {
    const lang = { alliance: { createAlliance: { modal: { stateField: { label: 'State' } } } } };

    assert.equal(
        formatAllianceStateDescription({ state: 437 }, lang, 'Players: 25'),
        'State: 437 | Players: 25'
    );
    assert.equal(formatAllianceStateDescription({ state: null }, lang), 'State: —');
});

test('auto-sort moves minorities and creates numeric alliances for states with no majority', () => {
    const alliances = [
        { id: 1, priority: 1, state: 100 },
        { id: 2, priority: 2, state: 200 },
        { id: 3, priority: 3, state: 300 }
    ];
    const players = [
        { fid: 1, alliance_id: 1, state: 100 },
        { fid: 2, alliance_id: 1, state: 100 },
        { fid: 3, alliance_id: 1, state: 200 },
        { fid: 4, alliance_id: 2, state: 200 },
        { fid: 5, alliance_id: 2, state: 200 },
        { fid: 6, alliance_id: 2, state: 100 },
        { fid: 7, alliance_id: 3, state: 300 },
        { fid: 8, alliance_id: 3, state: 400 },
        { fid: 9, alliance_id: 3, state: 0 }
    ];

    const plan = buildAutoSortPlan(alliances, players);

    assert.deepEqual(plan.majorities.map(item => [item.alliance.id, item.state]), [[1, 100], [2, 200]]);
    assert.deepEqual(plan.newAllianceStates, [300, 400]);
    assert.equal(plan.moves.length, 4);
    assert.equal(plan.moves.find(move => move.player.fid === 3).targetAllianceId, 2);
    assert.equal(plan.moves.find(move => move.player.fid === 6).targetAllianceId, 1);
    assert.equal(plan.skipped.length, 1);
});

test('migration majority requires more than half of the imported player states', () => {
    assert.deepEqual(
        getMajority({ state: null }, [{ state: 437 }, { state: 437 }, { state: 12 }]),
        { state: 437, count: 2, total: 3 }
    );
    assert.equal(getMajority({ state: null }, [{ state: 437 }, { state: 12 }]), null);
});

test('Python player migration imports kid as state and assigns only strict alliance majorities', async () => {
    const calls = { players: [], states: [], closed: false };
    const users = [
        { fid: '1', kid: '437', alliance: '10' },
        { fid: '2', kid: '437', alliance: '10' },
        { fid: '3', kid: '12', alliance: '10' },
        { fid: '4', kid: '20', alliance: '20' },
        { fid: '5', kid: '21', alliance: '20' },
        { fid: 'bad', kid: '437', alliance: '10' },
        { fid: '6', kid: '437', alliance: '99' }
    ];
    const { migratePlayers } = loadMigrationFunctions(users, calls);

    const count = await migratePlayers('users.sqlite', new Map([[10, 100], [20, 200]]), 'owner', 'ks');

    assert.equal(count, 5);
    assert.deepEqual(calls.players[0], [1, 437, 100, 'owner', 'ks']);
    assert.deepEqual(calls.states, [[100, 437, 'ks']]);
    assert.equal(calls.closed, true);
});
