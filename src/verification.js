const STORAGE_KEY = 'bm_verified_refs_v1';

function getStorage() {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
    return null;
}

function readStore() {
    const storage = getStorage();
    if (!storage) return {};
    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeStore(data) {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function loadVerifiedRefs() {
    return readStore();
}

export function saveVerifiedRefs(data) {
    writeStore(data || {});
}

export function getVerificationKey(item) {
    if (!item) return '';
    if (item._instanceId) return String(item._instanceId);
    const ref = (item.ref || '').trim();
    const sentence = (item.sentence || '').trim();
    return `${ref}::${sentence}`;
}

export function isItemVerified(verifiedRefs, item) {
    const key = getVerificationKey(item);
    return !!(verifiedRefs && verifiedRefs[key]);
}

export function toggleVerification(verifiedRefs, item) {
    const next = { ...(verifiedRefs || {}) };
    const key = getVerificationKey(item);
    if (!key) return next;
    if (next[key]) {
        delete next[key];
    } else {
        next[key] = {
            key,
            ref: item.ref || '',
            sentence: item.sentence || '',
            verifiedAt: Date.now(),
            matchType: item.matchType || '',
            rowCount: item.rows?.length || 0,
            bookTitle: item.rows?.[0]?.bookTitle || '',
            heRef: item.rows?.[0]?.heRef || '',
        };
    }
    return next;
}

export function verifyItems(verifiedRefs, items) {
    const next = { ...(verifiedRefs || {}) };
    (items || []).forEach((item) => {
        const key = getVerificationKey(item);
        if (!key) return;
        next[key] = {
            key,
            ref: item.ref || '',
            sentence: item.sentence || '',
            verifiedAt: Date.now(),
            matchType: item.matchType || '',
            rowCount: item.rows?.length || 0,
            bookTitle: item.rows?.[0]?.bookTitle || '',
            heRef: item.rows?.[0]?.heRef || '',
        };
    });
    return next;
}

export function getVerifiedEntries(verifiedRefs) {
    return Object.values(verifiedRefs || {}).sort((a, b) => (b.verifiedAt || 0) - (a.verifiedAt || 0));
}
