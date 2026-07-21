function formatAllianceStateDescription(alliance, lang, details = '') {
    const state = Number(alliance?.state);
    const stateLabel = lang?.alliance?.createAlliance?.modal?.stateField?.label || 'State';
    const stateValue = Number.isSafeInteger(state) && state > 0 ? state : '—';

    return [`${stateLabel}: ${stateValue}`, details]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 100);
}

module.exports = { formatAllianceStateDescription };
