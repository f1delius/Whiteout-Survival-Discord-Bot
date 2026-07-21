const ROOT_PRIORITY = new Map([
    ['settings_', 0],
    ['player_', 1],
    ['notification_', 2],
    ['alliance_', 3],
    ['gift_', 4],
    ['plugins_', 5],
    ['emoji_', 6],
    ['calc_', 7],
]);

function findMatchingParen(source, startIndex) {
    let depth = 0;

    for (let i = startIndex; i < source.length; i += 1) {
        const char = source[i];
        const prevChar = i > 0 ? source[i - 1] : '';

        if (char === '(' && prevChar !== '\\') {
            depth += 1;
        } else if (char === ')' && prevChar !== '\\') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}

function unwrapOuterGroup(source) {
    let nextSource = source;

    while (nextSource.startsWith('(')) {
        const closeIndex = findMatchingParen(nextSource, 0);
        if (closeIndex !== nextSource.length - 1) {
            break;
        }

        if (nextSource.startsWith('(?:')) {
            nextSource = nextSource.slice(3, -1);
        } else {
            nextSource = nextSource.slice(1, -1);
        }
    }

    return nextSource;
}

function splitTopLevelAlternatives(source) {
    const parts = [];
    let depth = 0;
    let current = '';

    for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        const prevChar = i > 0 ? source[i - 1] : '';

        if (char === '(' && prevChar !== '\\') {
            depth += 1;
        } else if (char === ')' && prevChar !== '\\' && depth > 0) {
            depth -= 1;
        }

        if (char === '|' && prevChar !== '\\' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    parts.push(current);
    return parts;
}

function extractLiteralPrefix(alternative) {
    let literal = '';

    for (let i = 0; i < alternative.length; i += 1) {
        const char = alternative[i];

        if (char === '\\') {
            if (i + 1 >= alternative.length) break;
            literal += alternative[i + 1];
            i += 1;
            continue;
        }

        if (/^[A-Za-z0-9_-]$/.test(char)) {
            literal += char;
            continue;
        }

        break;
    }

    return literal;
}

function getPatternBucketKeys(pattern) {
    let source = pattern.source;
    if (source.startsWith('^')) {
        source = source.slice(1);
    }

    source = unwrapOuterGroup(source);

    const literals = splitTopLevelAlternatives(source)
        .map((alternative) => alternative.startsWith('^') ? alternative.slice(1) : alternative)
        .map(extractLiteralPrefix)
        .filter(Boolean);

    return [...new Set(literals)];
}

function getInteractionBucketKeys(customId) {
    const keys = [];

    for (let i = 0; i < customId.length; i += 1) {
        if (customId[i] === '_') {
            keys.push(customId.slice(0, i + 1));
        }
    }

    if (!keys.length) {
        keys.push(customId);
    }

    return keys.reverse();
}

function getRootPriority(bucketKey) {
    const firstUnderscore = bucketKey.indexOf('_');
    if (firstUnderscore === -1) {
        return Number.MAX_SAFE_INTEGER;
    }

    const rootKey = bucketKey.slice(0, firstUnderscore + 1);
    return ROOT_PRIORITY.get(rootKey) ?? Number.MAX_SAFE_INTEGER;
}

function createInteractionDispatcher(handlers) {
    const buckets = new Map();
    const fallbackHandlers = [];

    handlers.forEach((handler, index) => {
        const bucketKeys = getPatternBucketKeys(handler.pattern);
        const rankedHandler = {
            ...handler,
            index,
            priority: bucketKeys.length
                ? Math.min(...bucketKeys.map(getRootPriority))
                : Number.MAX_SAFE_INTEGER,
        };

        if (!bucketKeys.length) {
            fallbackHandlers.push(rankedHandler);
            return;
        }

        for (const bucketKey of bucketKeys) {
            if (!buckets.has(bucketKey)) {
                buckets.set(bucketKey, []);
            }

            buckets.get(bucketKey).push(rankedHandler);
        }
    });

    const sortBucket = (handlersForBucket) => {
        handlersForBucket.sort((left, right) => {
            const priorityDelta = left.priority - right.priority;
            if (priorityDelta !== 0) {
                return priorityDelta;
            }

            return left.index - right.index;
        });
    };

    for (const handlersForBucket of buckets.values()) {
        sortBucket(handlersForBucket);
    }

    fallbackHandlers.sort((left, right) => {
        const priorityDelta = left.priority - right.priority;
        if (priorityDelta !== 0) {
            return priorityDelta;
        }

        return left.index - right.index;
    });

    function getCandidates(customId) {
        const seenHandlers = new Set();
        const candidates = [];

        for (const bucketKey of getInteractionBucketKeys(customId)) {
            const handlersForBucket = buckets.get(bucketKey);
            if (!handlersForBucket) continue;

            for (const handler of handlersForBucket) {
                if (seenHandlers.has(handler)) continue;
                seenHandlers.add(handler);
                candidates.push(handler);
            }
        }

        for (const handler of fallbackHandlers) {
            if (seenHandlers.has(handler)) continue;
            candidates.push(handler);
        }

        return candidates;
    }

    return {
        getCandidates,
    };
}

module.exports = {
    createInteractionDispatcher,
};
