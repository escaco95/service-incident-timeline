import { randomUUID } from './random-id.js';
const $ = selector => document.querySelector(selector);

export function createServicesUI({ api, escape, generation, authenticated, onChanged, onSavingChange }) {
  let settings = null;
  let selected = [];
  let editorRequest = 0;
  let settingsRequest = 0;
  let editorReady = false;
  let saving = false;
  const eventForm = $('#event-form');
  const settingsForm = $('#services-form');
  const error = (selector, message) => { $(selector).textContent = message; $(selector).hidden = !message; };

  function renderSelections() {
    $('#event-services').innerHTML = selected.map((entry, index) => `<div class="service-tag"><span>${escape(entry.label)}${entry.kind === 'custom' ? '<small>직접 입력</small>' : ''}</span><button type="button" class="icon-button" data-service-remove="${index}" aria-label="${escape(entry.label)} 선택 해제">×</button></div>`).join('');
    renderSuggestions();
  }
  function renderSuggestions() {
    const query = eventForm.elements.service.value.trim().toLocaleLowerCase();
    const suggestions = (settings?.services ?? []).filter(service => service.active && !selected.some(entry => entry.kind === 'catalog' && entry.id === service.id) && service.name.toLocaleLowerCase().includes(query));
    $('#service-suggestions').innerHTML = suggestions.slice(0, 12).map(service => `<button type="button" class="service-suggestion" data-service-pick="${escape(service.id)}">${escape(service.name)}</button>`).join('');
    $('#service-picker-status').textContent = !editorReady ? '서비스 목록을 불러오고 있습니다…' : settings.services.length ? '직접 입력 항목은 제안 목록에 자동으로 추가되지 않습니다.' : '등록된 제안이 없습니다. 서비스명을 직접 추가할 수 있습니다.';
  }
  function addCustom() {
    const name = eventForm.elements.service.value.trim();
    if (!name) return;
    if (!selected.some(entry => entry.kind === 'custom' && entry.label === name)) selected.push({ kind: 'custom', label: name });
    eventForm.elements.service.value = '';
    renderSelections();
  }
  eventForm.elements.service.addEventListener('input', renderSuggestions);
  eventForm.elements.service.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addCustom(); } });
  $('#service-custom-add').addEventListener('click', addCustom);
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
    selected = structuredClone(event?.services ?? (event?.service ? [{ kind: 'custom', label: event.service }] : []));
    eventForm.elements.service.value = '';
    editorReady = false;
    $('#event-save').disabled = true;
    renderSelections();
    try {
      const result = await api('/api/services');
      if (request !== editorRequest || session !== generation() || !$('#event-dialog').open) return;
      settings = result;
      editorReady = true;
      renderSelections();
      $('#event-save').disabled = false;
    } catch (failure) { if (request === editorRequest && session === generation()) { error('#event-error', failure.message); $('#service-picker-status').textContent = '서비스 목록을 불러오지 못했습니다. 편집 창을 다시 열어 주세요.'; } }
  }

  function eventFields() {
    if (!editorReady) throw new Error('서비스 목록을 불러온 뒤 저장해 주세요.');
    addCustom();
    return { services: selected.map(entry => entry.kind === 'catalog' ? { kind: 'catalog', id: entry.id } : { kind: 'custom', label: entry.label }) };
  }

  function catalogRow(service, saved = false) {
    return `<div class="catalog-row" data-catalog-row data-service-id="${escape(service.id)}"><label class="field">표시명<input data-key="name" value="${escape(service.name)}" maxlength="80" required></label><label class="check-field"><input type="checkbox" data-key="active" ${service.active ? 'checked' : ''}>사용</label><div class="row-buttons"><button type="button" class="icon-button" data-move="up" aria-label="서비스 위로">↑</button><button type="button" class="icon-button" data-move="down" aria-label="서비스 아래로">↓</button>${saved ? '' : '<button type="button" class="icon-button" data-remove-row aria-label="새 서비스 제거">×</button>'}</div></div>`;
  }
  $('#catalog-add').addEventListener('click', () => $('#services-catalog').insertAdjacentHTML('beforeend', catalogRow({ id: `service-${randomUUID()}`, name: '', active: true })));
  settingsForm.addEventListener('click', event => {
    const action = event.target.closest('[data-move],[data-remove-row]');
    if (!action) return;
    const row = action.closest('[data-catalog-row]');
    if (action.hasAttribute('data-remove-row')) row.remove();
    else if (action.dataset.move === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
    else if (action.dataset.move === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
  });
  async function loadSettings() {
    const request = ++settingsRequest, session = generation();
    error('#services-error', '');
    $('#services-fields').disabled = true;
    $('#services-save').disabled = true;
    try {
      const result = await api('/api/services');
      if (request !== settingsRequest || session !== generation() || !$('#branding-dialog').open) return;
      settings = result;
      $('#services-catalog').innerHTML = settings.services.map(service => catalogRow(service, true)).join('');
      $('#services-fields').disabled = false;
      $('#services-save').disabled = false;
    } catch (failure) { if (request === settingsRequest && session === generation()) error('#services-error', failure.message); }
  }
  $('#services-reload').addEventListener('click', loadSettings);
  $('#branding-dialog').addEventListener('close', () => { settingsRequest++; });
  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !settings || !authenticated()) return;
    const services = [...document.querySelectorAll('[data-catalog-row]')].map(row => ({ id: row.dataset.serviceId, name: row.querySelector('[data-key=name]').value.trim(), active: row.querySelector('[data-key=active]').checked }));
    const session = generation();
    saving = true;
    onSavingChange(true);
    $('#services-fields').disabled = true;
    $('#services-save').disabled = true;
    $('#services-reload').disabled = true;
    try {
      await api('/api/services', { method: 'PUT', body: JSON.stringify({ version: settings.version, services }) });
      if (session !== generation()) return;
      await loadSettings();
      await onChanged();
    } catch (failure) { if (session === generation()) error('#services-error', failure.message); }
    finally { saving = false; onSavingChange(false); $('#services-fields').disabled = !authenticated(); $('#services-save').disabled = !authenticated(); $('#services-reload').disabled = false; }
  });

  function clear() {
    editorRequest++; settingsRequest++;
    settings = null; selected = []; editorReady = false;
    for (const selector of ['#event-services', '#service-suggestions', '#services-catalog']) $(selector).replaceChildren();
    settingsForm.reset();
    for (const selector of ['#services-error', '#service-picker-status']) $(selector).textContent = '';
    $('#services-fields').disabled = true;
    $('#services-save').disabled = true;
  }
  return { openEditor, eventFields, loadSettings, clear };
}
