const { randomBytes } = require('node:crypto');

const SELECTION_TTL_MS = 15 * 60 * 1000;
const selections = new Map();

function removeExpiredSelections(now) {
    for (const [selectionId, selection] of selections) {
        if (selection.expiresAt <= now) selections.delete(selectionId);
    }
}

function createManualRedeemSelection(userId, allianceIds, gameType, now = Date.now()) {
    removeExpiredSelections(now);

    const selectionId = randomBytes(6).toString('hex');
    selections.set(selectionId, {
        userId: String(userId),
        allianceIds: allianceIds.map(String),
        gameType,
        expiresAt: now + SELECTION_TTL_MS
    });

    return selectionId;
}

function getManualRedeemSelection(selectionId, userId, now = Date.now()) {
    const selection = selections.get(selectionId);
    if (!selection || selection.expiresAt <= now) {
        selections.delete(selectionId);
        return null;
    }

    return selection.userId === String(userId) ? selection : null;
}

function deleteManualRedeemSelection(selectionId) {
    selections.delete(selectionId);
}

function buildManualRedeemCodeSelectId(userId, selectionId, page) {
    return `manual_redeem_code_select_${userId}_${selectionId}_${page}`;
}

module.exports = {
    buildManualRedeemCodeSelectId,
    createManualRedeemSelection,
    deleteManualRedeemSelection,
    getManualRedeemSelection
};
