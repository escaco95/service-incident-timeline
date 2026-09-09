import { AppError } from './errors.mjs';

const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' ? value.trim() : '';
const fail = message => { throw new AppError(400, message); };

export function validateServices(input, previous = []) {
  if (!Array.isArray(input) || input.length > 200) fail('서비스 제안 목록은 최대 200개입니다.');
  const seen = new Set();
  const services = input.map((entry, order) => {
    if (!plain(entry) || !identifier(entry.id) || seen.has(entry.id)) fail('서비스 ID는 영문 소문자로 시작하는 고유한 1~64자 값이어야 합니다.');
    seen.add(entry.id);
    const name = label(entry.name);
    if (!name || name.length > 80 || typeof entry.active !== 'boolean') fail('서비스 이름(1~80자)과 사용 여부를 확인해 주세요.');
    return { id: entry.id, name, active: entry.active, order };
  });
  if (previous.some(entry => !seen.has(entry.id))) fail('기존 서비스 ID는 삭제하거나 변경할 수 없습니다. 사용하지 않는 서비스는 비활성화해 주세요.');
  return services;
}

export function normalizeSelections(input, catalog, original = []) {
  if (!Array.isArray(input) || input.length > 50) fail('한 이벤트에 최대 50개의 서비스를 선택할 수 있습니다.');
  const seen = new Set(), selections = [];
  for (const entry of input) {
    if (!plain(entry) || !['catalog', 'custom'].includes(entry.kind)) fail('서비스 선택 형식을 확인해 주세요.');
    if (entry.kind === 'catalog') {
      const service = catalog.find(item => item.id === entry.id);
      const old = original.find(item => item.kind === 'catalog' && item.id === entry.id);
      if (!service || (!service.active && !old)) fail('새로 선택할 수 없는 서비스입니다. 제안 목록을 확인해 주세요.');
      const key = `catalog:${entry.id}`;
      if (seen.has(key)) fail('같은 서비스 ID를 중복 선택할 수 없습니다.');
      seen.add(key);
      selections.push({ kind: 'catalog', id: entry.id, label: old?.label ?? service.name });
    } else {
      const name = label(entry.label);
      if (!name) continue;
      if (name.length > 80) fail('직접 입력한 서비스명은 80자까지 입력할 수 있습니다.');
      const key = `custom:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selections.push({ kind: 'custom', label: name });
    }
  }
  return selections;
}

export function prepareEvent(fields, input, catalog, original) {
  if (!Object.hasOwn(input, 'services') && original && fields.service !== original.service && (original.services.length > 1 || original.services.some(entry => entry.kind === 'catalog'))) throw new AppError(409, '서비스 선택 형식이 변경되었습니다. 화면을 새로고침한 뒤 편집해 주세요.');
  const services = Object.hasOwn(input, 'services') ? normalizeSelections(input.services, catalog.services, original?.services)
    : original && fields.service === original.service ? structuredClone(original.services)
    : fields.service ? [{ kind: 'custom', label: fields.service }] : [];
  return { ...fields, services, service: services.map(entry => entry.label).join(', ') };
}

export function validateCatalogState(state) {
  if (!plain(state.catalog) || !Number.isSafeInteger(state.catalog.version) || state.catalog.version < 1) fail('서비스 목록 버전이 올바르지 않습니다.');
  validateServices(state.catalog.services);
  for (const event of state.events) {
    for (const entry of event.services ?? []) if (!label(entry.label) || entry.label.length > 80) fail('저장된 서비스 표시명이 올바르지 않습니다.');
    normalizeSelections(event.services, state.catalog.services, event.services);
  }
}
