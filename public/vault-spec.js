export const VAULT_LIMITS = Object.freeze({ entries: 50, key: 64, value: 4000 });
export const validVaultKey = key => typeof key === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key);
