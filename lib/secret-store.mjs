import { AppError } from './errors.mjs';
import { recordChange } from './vault.mjs';
import { VAULT_LIMITS, validVaultKey } from '../public/vault-spec.js';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validValue = value => typeof value === 'string' && value.length > 0 && value.length <= VAULT_LIMITS.value;

export function validateStoredSecretStore(state) {
  const store = state.secretStore;
  if (store === undefined) return;
  if (!plain(store) || !Number.isSafeInteger(store.version) || store.version < 1 || !plain(store.entries) || Object.keys(store.entries).length > VAULT_LIMITS.entries || Object.entries(store.entries).some(([key, value]) => !validVaultKey(key) || !validValue(value))) throw new AppError(503, '비밀 값 저장소를 읽을 수 없습니다. 원본을 보존하고 백업을 확인해 주세요.');
}

export class SecretStore {
  constructor(vault) { this.vault = vault; }
  read() {
    this.vault.assertUnlocked();
    validateStoredSecretStore(this.vault.state);
    const store = this.vault.state.secretStore;
    return { version: store?.version ?? 0, keys: Object.keys(store?.entries ?? {}).sort().map(key => ({ key, configured: true })) };
  }
  async save(input) {
    if (!plain(input) || Object.keys(input).some(key => !['version', 'key', 'value'].includes(key)) || !validVaultKey(input.key)) throw new AppError(400, '키는 영문 소문자로 시작하는 소문자·숫자·밑줄 64자 이내로 입력해 주세요.');
    if (input.value !== null && !validValue(input.value)) throw new AppError(400, '비밀 값은 1~4,000자의 문자열로 입력해 주세요.');
    await this.vault.mutate(state => {
      validateStoredSecretStore(state);
      const store = state.secretStore ?? { version: 0, entries: {} };
      if (input.version !== store.version) throw new AppError(409, '비밀 값 저장소가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.');
      const exists = Object.hasOwn(store.entries, input.key);
      if (input.value === null && !exists) throw new AppError(404, '삭제할 비밀 값의 키를 찾을 수 없습니다.');
      if (input.value !== null && !exists && Object.keys(store.entries).length >= VAULT_LIMITS.entries) throw new AppError(400, '비밀 값은 최대 50개까지 등록할 수 있습니다.');
      const operation = input.value === null ? 'deleted' : exists ? 'updated' : 'created';
      if (input.value === null) delete store.entries[input.key];
      else store.entries[input.key] = input.value;
      state.secretStore = { version: store.version + 1, entries: store.entries };
      recordChange(state, 'vault-value-' + operation, null, { key: input.key, operation });
    }, { scope: {} });
    return this.read();
  }
  resolve(names) {
    this.vault.assertUnlocked();
    validateStoredSecretStore(this.vault.state);
    return Object.fromEntries(names.map(key => {
      const value = this.vault.state.secretStore?.entries?.[key];
      if (!validVaultKey(key) || !validValue(value)) throw new AppError(400, `비밀 값을 설정해 주세요: vault.${key}`);
      return [key, value];
    }));
  }
}
