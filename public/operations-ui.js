const $ = selector => document.querySelector(selector);
const reasons = { 'execution-disabled': '기록 전용', 'policy-unconfigured': '정책 미설정', 'unknown-impact': '상태 영향 확인 필요', 'no-targets': '대상 없음', 'unmapped-service': '직접 입력 연결 필요', 'inactive-target': '대상 비활성', 'unconnected-target': '커넥터 연결 필요', 'authorization-required': '적용 범위 재확인 필요' };

export function createOperationsUI({ api, escape, generation, authenticated, events, openEvent, localInput, parseInput, formatTime, onChanged }) {
  let settings = null;
  let selected = [];
  let editing = null;
  let editorRequest = 0;
  let settingsRequest = 0;
  let previewRequest = 0;
  let editorReady = false;
  let saving = false;
  const eventForm = $('#event-form');
  const settingsForm = $('#operations-form');
  const error = (selector, message) => { $(selector).textContent = message; $(selector).hidden = !message; };
  const targetOptions = selectedId => `<option value="">연결 없음</option>${(settings?.services ?? []).map(service => `<option value="${escape(service.id)}" ${service.id === selectedId ? 'selected' : ''} ${!service.active || !service.connectorId ? 'disabled' : ''}>${escape(service.name)} · ${escape(service.id)}${service.active ? '' : ' (비활성)'}</option>`).join('')}`;

  function renderSelections() {
    $('#event-services').innerHTML = selected.map((entry, index) => `<div class="service-tag"><span>${escape(entry.label)}<small>${entry.kind === 'catalog' ? escape(entry.id) : '직접 입력'}</small></span>${entry.kind === 'custom' ? `<select data-service-target="${index}" aria-label="${escape(entry.label)} 실행 대상 연결">${targetOptions(entry.targetId)}</select>` : ''}<button type="button" class="icon-button" data-service-remove="${index}" aria-label="${escape(entry.label)} 선택 해제">×</button></div>`).join('');
    renderSuggestions();
  }
  function renderSuggestions() {
    const query = eventForm.elements.service.value.trim().toLocaleLowerCase();
    const suggestions = (settings?.services ?? []).filter(service => service.active && !selected.some(entry => entry.kind === 'catalog' && entry.id === service.id) && `${service.name} ${service.id}`.toLocaleLowerCase().includes(query));
    $('#service-suggestions').innerHTML = suggestions.slice(0, 12).map(service => `<button type="button" class="service-suggestion" data-service-pick="${escape(service.id)}">${escape(service.name)} <small>${escape(service.id)}</small></button>`).join('');
    $('#service-picker-status').textContent = !editorReady ? '서비스 목록을 불러오고 있습니다…' : settings.services.length ? '직접 입력 항목은 제안 목록에 자동으로 추가되지 않습니다.' : '등록된 제안이 없습니다. 서비스명을 직접 추가할 수 있습니다.';
  }
  function addCustom() {
    const name = eventForm.elements.service.value.trim();
    if (!name) return;
    if (!selected.some(entry => entry.kind === 'custom' && entry.label === name)) selected.push({ kind: 'custom', label: name, targetId: null });
    eventForm.elements.service.value = '';
    renderSelections();
  }
  eventForm.elements.service.addEventListener('input', renderSuggestions);
  eventForm.elements.service.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addCustom(); } });
  $('#service-custom-add').addEventListener('click', addCustom);
  $('#event-services').addEventListener('change', event => {
    if (event.target.dataset.serviceTarget !== undefined) selected[Number(event.target.dataset.serviceTarget)].targetId = event.target.value || null;
  });
  $('#event-dialog').addEventListener('click', event => {
    const remove = event.target.closest('[data-service-remove]');
    if (remove) { selected.splice(Number(remove.dataset.serviceRemove), 1); renderSelections(); }
    const pick = event.target.closest('[data-service-pick]');
    if (pick) {
      const service = settings.services.find(item => item.id === pick.dataset.servicePick);
      if (!selected.some(entry => entry.kind === 'catalog' && entry.id === service.id)) selected.push({ kind: 'catalog', id: service.id, label: service.name });
      eventForm.elements.service.value = '';
      renderSelections();
    }
  });

  async function openEditor(event) {
    const request = ++editorRequest, session = generation();
    editing = event;
    selected = structuredClone(event?.services ?? (event?.service ? [{ kind: 'custom', label: event.service, targetId: null }] : []));
    eventForm.elements.service.value = '';
    eventForm.elements.calculationEnabled.checked = event?.execution?.enabled ?? false;
    eventForm.elements.endMode.value = event?.execution?.endMode ?? 'scheduled';
    eventForm.elements.confirmAuthorization.checked = false;
    $('#confirmed-end-status').textContent = event?.execution?.confirmedEnd ? `확인된 종료: ${formatTime(event.execution.confirmedEnd)}` : '운영자 확인 방식은 예정 종료 시각이 지나도 상태 영향을 유지합니다.';
    editorReady = false;
    $('#event-save').disabled = true;
    renderSelections();
    try {
      const result = await api('/api/operations/settings');
      if (request !== editorRequest || session !== generation() || !$('#event-dialog').open) return;
      settings = result;
      editorReady = true;
      eventForm.elements.impact.innerHTML = '<option value="">선택하지 않음</option>' + settings.policy.states.map(state => `<option value="${escape(state.id)}">${escape(state.name)} (${escape(state.id)})</option>`).join('');
      if (event?.execution?.impact && !settings.policy.states.some(state => state.id === event.execution.impact)) eventForm.elements.impact.add(new Option(`삭제된 상태: ${event.execution.impact}`, event.execution.impact));
      eventForm.elements.impact.value = event?.execution?.impact ?? '';
      renderSelections();
      $('#event-save').disabled = false;
    } catch (failure) { if (request === editorRequest && session === generation()) { error('#event-error', failure.message); $('#service-picker-status').textContent = '서비스 목록을 불러오지 못했습니다. 편집 창을 다시 열어 주세요.'; } }
  }

  function eventFields() {
    if (!editorReady) throw new Error('서비스 목록을 불러온 뒤 저장해 주세요.');
    addCustom();
    const enabled = eventForm.elements.calculationEnabled.checked;
    if (enabled) {
      const missing = selected.filter(entry => { const target = settings.services.find(service => service.id === (entry.kind === 'catalog' ? entry.id : entry.targetId)); return !target?.active || !target.connectorId; });
      if (!selected.length || missing.length) throw new Error(`실행 대상 연결을 확인해 주세요: ${missing.map(entry => entry.label).join(', ') || '선택한 서비스 없음'}`);
      if (!eventForm.elements.impact.value) throw new Error('상태 영향을 선택해 주세요.');
    }
    const endMode = eventForm.elements.endMode.value;
    return { services: structuredClone(selected), execution: { enabled, impact: eventForm.elements.impact.value || null, endMode, confirmedEnd: endMode === 'confirmed' ? editing?.execution?.confirmedEnd ?? null : null, confirmAuthorization: eventForm.elements.confirmAuthorization.checked, confirmSettingsVersion: settings.version } };
  }

  function catalogRow(service, saved = false) {
    return `<div class="catalog-row" data-catalog-row><label class="field">고정 ID<input data-key="id" value="${escape(service.id)}" maxlength="64" required ${saved ? 'readonly' : ''}></label><label class="field">표시명<input data-key="name" value="${escape(service.name)}" maxlength="80" required></label><label class="field">커넥터 ID<input data-key="connectorId" value="${escape(service.connectorId ?? '')}" maxlength="64" placeholder="연결 없음"></label><label class="check-field"><input type="checkbox" data-key="active" ${service.active ? 'checked' : ''}>사용</label><div class="row-buttons"><button type="button" class="icon-button" data-move="up" aria-label="서비스 위로">↑</button><button type="button" class="icon-button" data-move="down" aria-label="서비스 아래로">↓</button>${saved ? '' : '<button type="button" class="icon-button" data-remove-row aria-label="새 서비스 제거">×</button>'}</div></div>`;
  }
  function policyRow(state) {
    return `<div class="policy-row" data-policy-row><label class="field">상태 ID<input data-key="id" value="${escape(state.id)}" maxlength="64" required></label><label class="field">표시명<input data-key="name" value="${escape(state.name)}" maxlength="80"></label><label class="field">우선순위<input data-key="priority" type="number" min="-100000" max="100000" value="${state.priority}" required></label><div class="row-buttons"><button type="button" class="icon-button" data-move="up" aria-label="상태 위로">↑</button><button type="button" class="icon-button" data-move="down" aria-label="상태 아래로">↓</button><button type="button" class="icon-button" data-remove-row aria-label="상태 제거">×</button></div></div>`;
  }
  function updateBaseline(value = settingsForm.elements.baseline.value) {
    const states = [...document.querySelectorAll('[data-policy-row]')].map(row => ({ id: row.querySelector('[data-key=id]').value.trim(), name: row.querySelector('[data-key=name]').value.trim() })).filter(state => state.id);
    settingsForm.elements.baseline.innerHTML = `<option value="">선택하지 않음</option>${states.map(state => `<option value="${escape(state.id)}">${escape(state.name || state.id)}</option>`).join('')}`;
    settingsForm.elements.baseline.value = value;
  }
  $('#catalog-add').addEventListener('click', () => $('#operations-services').insertAdjacentHTML('beforeend', catalogRow({ id: `service-${crypto.randomUUID()}`, name: '', active: true, connectorId: null })));
  $('#policy-state-add').addEventListener('click', () => $('#operations-policy-states').insertAdjacentHTML('beforeend', policyRow({ id: '', name: '', priority: 0 })));
  settingsForm.addEventListener('input', event => { if (event.target.closest('[data-policy-row]')) updateBaseline(); });
  settingsForm.addEventListener('click', event => {
    const action = event.target.closest('[data-move],[data-remove-row]');
    if (!action) return;
    const row = action.closest('[data-catalog-row],[data-policy-row]');
    if (action.hasAttribute('data-remove-row')) row.remove();
    else if (action.dataset.move === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
    else if (action.dataset.move === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
    updateBaseline();
  });
  async function loadSettings() {
    const request = ++settingsRequest, session = generation();
    error('#operations-error', '');
    $('#operations-fields').disabled = true;
    $('#operations-save').disabled = true;
    try {
      const result = await api('/api/operations/settings');
      if (request !== settingsRequest || session !== generation() || !$('#operations-dialog').open) return;
      settings = result;
      $('#operations-services').innerHTML = settings.services.map(service => catalogRow(service, true)).join('');
      $('#operations-policy-states').innerHTML = settings.policy.states.map(policyRow).join('');
      updateBaseline(settings.policy.baseline ?? '');
      settingsForm.elements.tieBreak.value = settings.policy.tieBreak;
      $('#operations-affected').innerHTML = settings.affectedEvents.length ? `<strong>적용 범위를 다시 확인할 이벤트 ${settings.affectedEvents.length}건</strong><ul>${settings.affectedEvents.map(event => `<li>${escape(event.title)} · ${event.reasons.map(reason => escape(reasons[reason] ?? reason)).join(', ')}</li>`).join('')}</ul>` : '';
      $('#operations-fields').disabled = false;
      $('#operations-save').disabled = false;
    } catch (failure) { if (request === settingsRequest && session === generation()) error('#operations-error', failure.message); }
  }
  $('#open-operations-settings').addEventListener('click', () => { $('#operations-dialog').showModal(); loadSettings(); });
  $('#operations-reload').addEventListener('click', loadSettings);
  $('#operations-dialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !settings || !authenticated()) return;
    const rows = selector => [...document.querySelectorAll(selector)].map(row => Object.fromEntries([...row.querySelectorAll('[data-key]')].map(input => [input.dataset.key, input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim()])));
    const services = rows('[data-catalog-row]').map(service => ({ ...service, connectorId: service.connectorId || null }));
    const policy = { baseline: settingsForm.elements.baseline.value || null, tieBreak: settingsForm.elements.tieBreak.value, states: rows('[data-policy-row]') };
    const session = generation();
    saving = true;
    $('#operations-fields').disabled = true;
    $('#operations-save').disabled = true;
    $('#operations-reload').disabled = true;
    settingsForm.querySelector('[data-close]').disabled = true;
    try {
      await api('/api/operations/settings', { method: 'PUT', body: JSON.stringify({ version: settings.version, services, policy }) });
      if (session !== generation()) return;
      await loadSettings();
      await onChanged();
    } catch (failure) { if (session === generation()) error('#operations-error', failure.message); }
    finally { saving = false; $('#operations-fields').disabled = !authenticated(); $('#operations-save').disabled = !authenticated(); $('#operations-reload').disabled = false; settingsForm.querySelector('[data-close]').disabled = false; }
  });

  const previewForm = $('#state-preview-form');
  for (const [name, count] of [['hour', 24], ['minute', 60]]) previewForm.elements[name].innerHTML = Array.from({ length: count }, (_, index) => `<option value="${String(index).padStart(2, '0')}">${String(index).padStart(2, '0')}</option>`).join('');
  async function preview(event) {
    event?.preventDefault();
    const request = ++previewRequest, session = generation();
    error('#state-preview-error', '');
    $('#state-preview-content').replaceChildren();
    const at = parseInput(`${previewForm.elements.date.value}T${previewForm.elements.hour.value}:${previewForm.elements.minute.value}`);
    if (!at) { error('#state-preview-error', '평가 시각을 확인해 주세요.'); return; }
    const until = new Date(Date.parse(at) + Number(previewForm.elements.hours.value) * 3600000).toISOString();
    try {
      const [result, configuration] = await Promise.all([api('/api/operations/preview', { method: 'POST', body: JSON.stringify({ at, until }) }), api('/api/operations/settings')]);
      if (request !== previewRequest || session !== generation() || !$('#state-preview-dialog').open) return;
      const stateName = id => configuration.policy.version === result.policyVersion ? configuration.policy.states.find(state => state.id === id)?.name ?? id ?? '정책 미설정' : id ?? '정책 미설정';
      const eventLink = reference => {
        const event = events().find(event => event.id === reference.eventId);
        return event ? `<button class="preview-event-link" type="button" data-preview-event="${escape(event.id)}" title="이벤트 상세 보기">${escape(event.title)}</button>` : `이벤트 ${escape(reference.eventId.slice(0, 8))}`;
      };
      $('#state-preview-content').innerHTML = `<p class="form-hint">${escape(formatTime(at))} 기준 · 정책 버전 ${result.policyVersion}</p><h3>계산 상태</h3>${result.states.length ? result.states.map(state => `<article class="state-card"><strong>${escape(state.name)}</strong><span data-state="${escape(state.state)}">${escape(stateName(state.state))}</span><small>${escape(state.targetId)} · ${state.basis === 'baseline' ? '기준 상태' : `근거 이벤트 ${state.evidence.length}건`}${state.active ? '' : ' · 비활성'}</small>${state.evidence.length ? `<ul>${state.evidence.map(item => `<li>${eventLink(item)} · ${escape(stateName(item.impact))}</li>`).join('')}</ul>` : ''}</article>`).join('') : '<p class="form-hint">먼저 서비스 제안 목록을 등록해 주세요.</p>'}<h3>예상 변경</h3>${result.transitions.length ? `<div class="preview-table"><table><thead><tr><th>평가 시각</th><th>서비스</th><th>상태</th><th>변경</th></tr></thead><tbody>${result.transitions.map(item => `<tr><td>${escape(formatTime(item.evaluatedAt))}</td><td>${escape(result.states.find(state => state.targetId === item.targetId)?.name ?? item.targetId)}</td><td>${escape(stateName(item.previousState))} → ${escape(stateName(item.targetState))}</td><td>${item.applyRequired ? '상태 변경' : '근거만 변경'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="form-hint">조회 기간에 예상 변경이 없습니다.</p>'}<details><summary>계산에서 제외된 이벤트 ${result.excluded.length}건</summary><ul>${result.excluded.map(item => `<li>${eventLink(item)} · ${item.reasons.map(reason => escape(reasons[reason] ?? reason)).join(', ')}</li>`).join('')}</ul></details>`;
    } catch (failure) { if (request === previewRequest && session === generation()) error('#state-preview-error', failure.message); }
  }
  previewForm.addEventListener('submit', preview);
  $('#state-preview-content').addEventListener('click', event => {
    const link = event.target.closest('[data-preview-event]');
    if (!link) return;
    $('#state-preview-dialog').close();
    $('#branding-dialog').close();
    openEvent(link.dataset.previewEvent);
  });
  function openPreview() {
    const local = localInput(new Date());
    previewForm.elements.date.value = local.slice(0, 10);
    previewForm.elements.hour.value = local.slice(11, 13);
    previewForm.elements.minute.value = local.slice(14, 16);
    $('#state-preview-content').replaceChildren();
    $('#state-preview-dialog').showModal();
    preview();
  }
  $('#open-state-preview').addEventListener('click', openPreview);

  function clear() {
    editorRequest++; settingsRequest++; previewRequest++;
    settings = null; selected = []; editing = null; editorReady = false;
    for (const selector of ['#event-services', '#service-suggestions', '#operations-services', '#operations-policy-states', '#operations-affected', '#state-preview-content', '#confirmed-end-status']) $(selector).replaceChildren();
    settingsForm.reset();
    settingsForm.elements.baseline.replaceChildren();
    eventForm.elements.impact.replaceChildren();
    for (const selector of ['#operations-error', '#state-preview-error', '#service-picker-status']) $(selector).textContent = '';
    $('#operations-fields').disabled = true;
    $('#operations-save').disabled = true;
  }
  return { openEditor, eventFields, openPreview, clear };
}
