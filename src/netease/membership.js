const PACKAGES = [['redplus', 2], ['associator', 1], ['musicPackage', 3]];

export function parseMembership(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || !PACKAGES.some(([key]) => Object.hasOwn(data, key))) return null;
    const packages = [];
    for (const [key, type] of PACKAGES) {
        const value = data[key];
        if (value == null) continue;
        const raw = value.expireTime;
        if (typeof value !== 'object' || Array.isArray(value)
            || !['number', 'string'].includes(typeof raw) || String(raw).trim() === '') return null;
        const expiresAt = Number(raw);
        if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) return null;
        packages.push({ type, expiresAt });
    }
    const serverNow = Number(data.now);
    return { packages, serverNow: Number.isSafeInteger(serverNow) && serverNow > 0 ? serverNow : null };
}

export function getMembershipStatus(membership, now = Date.now()) {
    if (!membership) return { type: null, expiresAt: null };
    const active = membership.packages.find(item => item.expiresAt > now);
    return active || { type: 0, expiresAt: null };
}
