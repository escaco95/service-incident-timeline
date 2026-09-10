import { TRIGGERS, switchLabel } from './workflow-spec.js';
import { DRY_RUN_LIMITS, mergeDryRunSetup } from './workflow-dry-run-spec.js';
import { createDryRunEvents } from './workflow-dry-run-events.js';

export function createDryRunUI({ api, escape, formatTime, generation, authenticated, active, current, types }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'workflow-dry-run-dialog'; dialog.className = 'dialog wf-dry-dialog';
  dialog.setAttribute('aria-labelledby', 'wf-dry-title'); document.body.append(dialog);
  let record = null, request = 0;
  const query = selector => dialog.querySelector(selector);
  const valid = item => record === item && item.session === generation() && authenticated() && dialog.open;
  const events = createDryRunEvents({ api, escape, formatTime, dialog, valid, apply(item, node, { now, values }) {
    item.setup.now = now; item.setup.nodes[node.id] = values;
    query('[data-dry-field=now]').value = now;
    const card = query(`[data-dry-node="${CSS.escape(node.id)}"]`);
    for (const key of ['event', 'trigger']) { const field = card.querySelector(`[data-dry-field=${key}]`); if (field) field.value = values[key]; }
    changed(item);
  } });
  const json = value => `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;
  const statusNames = { success: '성공', failure: '실패', review: '확인 필요', skipped: '생략', 'handled-error': '오류 처리 후 계속' };
  const area = (label, key, value, max = DRY_RUN_LIMITS.json) => `<label class="field">${label}<textarea data-dry-field="${key}" rows="5" maxlength="${max}" spellcheck="false">${escape(value)}</textarea></label>`;
  function saveStatus(item) {
    if (!valid(item)) return;
    query('[data-dry-save-state]').textContent = item.saving ? '입력값 저장 중…' : item.error ? '입력값 저장 실패' : item.revision === item.savedRevision ? '입력값 저장됨' : '입력값 저장 대기';
    query('[data-dry-retry]').hidden = !item.error || item.conflict;
    query('[data-dry-reload]').hidden = !item.conflict;
  }
  function showError(message) { const target = query('[data-dry-error]'); if (target) { target.textContent = message; target.hidden = false; } }
  function setBusy(busy) {
    const fields = query('[data-dry-fields]'); if (fields) fields.disabled = busy;
    for (const button of dialog.querySelectorAll('button')) button.disabled = busy;
    if (record) events.refresh(record);
  }
  async function persist(item) {
    clearTimeout(item.timer);
    if (item.saving) return item.saving;
    if (item.conflict) throw new Error(item.error);
    if (item.session !== generation() || !authenticated()) return;
    if (item.revision === item.savedRevision) return;
    item.saving = (async () => {
      try {
        while (item.savedRevision < item.revision) {
          const revision = item.revision, setup = structuredClone(item.setup);
          const result = await api(`/api/workflows/${item.id}/dry-run-setup`, { method: 'PUT', body: JSON.stringify({ version: item.version, setup }) });
          if (item.session !== generation() || !authenticated()) return;
          item.version = result.version; item.savedRevision = revision; item.error = null;
        }
      } catch (error) {
        item.error = error.message; item.conflict = error.status === 409;
        if (valid(item)) showError(error.message);
        throw error;
      } finally { item.saving = null; saveStatus(item); }
    })();
    saveStatus(item);
    return item.saving;
  }
  function nodeMarkup(node, setup) {
    const values = setup.nodes[node.id];
    let fields;
    if (TRIGGERS.includes(node.type)) {
      fields = (['start', 'end', 'service-state'].includes(node.type) ? events.markup(node, values) : '') + (['start', 'end'].includes(node.type) ? area('이벤트 초기값 (JSON 객체)', 'event', values.event) : '') + area('트리거 초기값 (JSON 객체)', 'trigger', values.trigger);
    } else if (node.type === 'http') {
      const error = values.outcome === 'error';
      fields = `<div class="wf-dry-http-fields"><label class="field">호출 결과<select data-dry-field="outcome"><option value="response" ${!error ? 'selected' : ''}>HTTP 응답</option><option value="error" ${error ? 'selected' : ''}>통신 오류</option></select></label><label class="field" data-dry-response ${error ? 'hidden' : ''}>HTTP 상태 코드<input data-dry-field="status" value="${escape(values.status)}" inputmode="numeric" maxlength="3"></label></div><div data-dry-response ${error ? 'hidden' : ''}>${area('응답 헤더 (JSON 객체)', 'headers', values.headers, DRY_RUN_LIMITS.headers)}${area('응답 본문 (JSON · 문자열은 따옴표로 감싸기)', 'body', values.body)}</div><label class="field" data-dry-failure ${!error ? 'hidden' : ''}>통신 오류 메시지<input data-dry-field="error" maxlength="2000" value="${escape(values.error)}"></label>`;
    } else {
      const hint = { datetime: '입력한 테스트 기준 시각과 노드 설정으로 날짜·시각을 계산합니다.', context: '노드에 설정된 키·값을 실행 컨텍스트에 주입합니다.', condition: '앞선 노드의 테스트 결과로 조건 분기를 판단합니다.', switch: '비교 값에 일치하는 분기 하나로 진행하며, 일치하지 않거나 값이 없으면 기본 경로로 진행합니다.', find: '앞선 노드의 테스트 결과에서 목록을 검색합니다.', finish: '노드에 설정된 종료 결과와 사유를 사용합니다.' }[node.type];
      fields = `<p class="form-hint">${hint}</p>`;
    }
    return `<details class="wf-dry-node" data-dry-node="${escape(node.id)}" ${values ? 'open' : ''}><summary><strong>${escape(node.name)}</strong><span>${escape(types[node.type].label)}</span></summary><div class="wf-dry-node-body">${fields}</div></details>`;
  }
  function render(item) {
    dialog.innerHTML = `<form data-dry-form><div class="dialog-heading"><h2 id="wf-dry-title">Dry-Run 테스트 설정</h2><button type="button" class="icon-button" data-dry-close aria-label="닫기">×</button></div><p class="wf-dry-description"><strong>${escape(item.definition.name)}</strong> · 현재 편집 중인 구성</p><p class="form-hint">입력한 이벤트·API 응답으로 흐름을 테스트합니다. 외부 API를 호출하지 않으며 감사 로그와 실행 이력에 남기지 않습니다.</p><fieldset data-dry-fields><label class="field">테스트 기준 시각 (ISO · 날짜·시각 노드의 now)<input data-dry-field="now" value="${escape(item.setup.now)}" maxlength="100" spellcheck="false" placeholder="2026-09-10T00:00:00.000Z"></label><div class="wf-dry-nodes">${item.definition.nodes.map(node => nodeMarkup(node, item.setup)).join('') || '<p class="form-hint">먼저 테스트할 노드를 추가해 주세요.</p>'}</div></fieldset><div class="wf-dry-save"><span data-dry-save-state role="status"></span><button type="button" class="wf-text-button" data-dry-retry hidden>저장 재시도</button><button type="button" class="wf-text-button" data-dry-reload hidden>입력 버리고 서버 설정 불러오기</button></div><p class="form-error" data-dry-error role="alert" hidden></p><section class="wf-dry-result" data-dry-result aria-label="Dry-Run 결과" tabindex="-1" hidden></section><div class="dialog-actions"><button type="button" class="button secondary" data-dry-close>닫기</button><button type="submit" class="button primary" ${!item.definition.nodes.length ? 'disabled' : ''}>Dry-Run 실행</button></div></form>`;
    saveStatus(item);
  }
  function resultMarkup(result) {
    return `<h3>Dry-Run 결과 · <span class="wf-dry-status ${escape(result.status)}">${escape(statusNames[result.status])}</span></h3><p class="form-hint">${result.steps.length}개 노드 실행 · ${result.skipped.length}개 노드 미실행</p>${result.message ? `<p>${escape(result.message)}</p>` : ''}<ol class="wf-dry-steps">${result.steps.map(step => `<li><details ${step.status === 'failure' || step.status === 'review' ? 'open' : ''}><summary><strong>${escape(step.name)}</strong> · <span class="wf-dry-status ${escape(step.status)}">${escape(statusNames[step.status])}</span> <span class="form-hint">${escape(step.type === 'switch' ? switchLabel(record.definition.nodes.find(node => node.id === step.nodeId), step.port) : step.port)}${step.attempts ? ` · 모의 시도 ${step.attempts}회` : ''}</span></summary>${step.error ? `<p class="form-error">${escape(step.error)}</p>` : ''}${step.request ? `<h4>요청 미리보기</h4>${json(step.request)}` : ''}${step.output === undefined ? '' : `<h4>노드 출력</h4>${json(step.output)}`}</details></li>`).join('')}</ol>${result.skipped.length ? `<details><summary>실행하지 않은 노드</summary><p>${result.skipped.map(node => escape(node.name)).join(', ')}</p></details>` : ''}<details><summary>최종 실행 컨텍스트</summary>${json(result.context)}</details>`;
  }
  async function closeAfterSave() {
    const item = record;
    if (item?.running || item?.closing) return;
    if (item) { item.closing = true; setBusy(true); }
    try {
      if (item) await persist(item);
      if (record === item) { request++; dialog.close(); record = null; dialog.replaceChildren(); }
    } catch (error) { showError(error.message); }
    finally { if (item) { item.closing = false; if (valid(item)) setBusy(false); } }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeAfterSave(); });
  dialog.addEventListener('click', event => {
    events.click(record, event.target);
    if (event.target.closest('[data-dry-close]')) closeAfterSave();
    if (event.target.closest('[data-dry-retry]') && record) { query('[data-dry-error]').hidden = true; persist(record).catch(() => {}); }
    if (event.target.closest('[data-dry-reload]')) open();
  });
  dialog.addEventListener('input', event => {
    const key = event.target.dataset.dryField, item = record;
    if (!key || !item || item.running || item.closing) return;
    const nodeId = event.target.closest('[data-dry-node]')?.dataset.dryNode;
    if (nodeId) {
      item.setup.nodes[nodeId][key] = event.target.value;
      if (key === 'trigger' && item.setup.nodes[nodeId].type === 'service-state') {
        delete item.setup.nodes[nodeId].scenario;
        events.manual(item, nodeId);
      }
    }
    else item.setup.now = event.target.value;
    if (key === 'outcome') {
      const node = event.target.closest('[data-dry-node]'), error = event.target.value === 'error';
      for (const field of node.querySelectorAll('[data-dry-response]')) field.hidden = error;
      node.querySelector('[data-dry-failure]').hidden = !error;
    }
    changed(item);
  });
  dialog.addEventListener('change', event => events.change(record, event.target));
  function changed(item) {
    item.revision++; query('[data-dry-result]').hidden = true;
    if (!item.conflict) query('[data-dry-error]').hidden = true;
    clearTimeout(item.timer); item.timer = setTimeout(() => persist(item).catch(() => {}), 500);
    saveStatus(item);
  }
  dialog.addEventListener('submit', async event => {
    event.preventDefault();
    const item = record;
    if (!item || item.running || item.closing) return;
    item.running = true; setBusy(true);
    query('[data-dry-error]').hidden = true; query('[data-dry-result]').hidden = true;
    try {
      await persist(item);
      if (!valid(item)) return;
      const result = await api(`/api/workflows/${item.id}/dry-run`, { method: 'POST', body: JSON.stringify({ definition: item.definition, setup: item.setup }) });
      if (!valid(item)) return;
      const target = query('[data-dry-result]'); target.innerHTML = resultMarkup(result); target.hidden = false; target.focus();
    } catch (error) { if (valid(item)) showError(error.message); }
    finally {
      item.running = false;
      if (valid(item)) setBusy(false);
    }
  });
  window.addEventListener('beforeunload', event => { if (record && authenticated() && record.revision !== record.savedRevision) { event.preventDefault(); event.returnValue = ''; } });
  async function open() {
    if (record) clearTimeout(record.timer);
    const flow = current(), session = generation(), token = ++request;
    if (!flow || !authenticated()) return;
    const definition = structuredClone({ name: flow.name, nodes: flow.nodes, edges: flow.edges });
    record = null;
    dialog.innerHTML = '<div class="dialog-heading"><h2 id="wf-dry-title">Dry-Run 테스트 설정</h2><button type="button" class="icon-button" data-dry-close aria-label="닫기">×</button></div><p>저장된 테스트 입력값을 불러오고 있습니다…</p><p class="form-error" data-dry-error hidden></p>';
    if (!dialog.open) dialog.showModal();
    try {
      const loaded = await api(`/api/workflows/${flow.id}/dry-run-setup`);
      if (token !== request || session !== generation() || !dialog.open || !active() || current()?.id !== flow.id) return;
      const setup = mergeDryRunSetup(definition, loaded.version ? loaded.setup : undefined);
      record = { id: flow.id, session, definition, version: loaded.version, setup, revision: 1, savedRevision: JSON.stringify(setup) === JSON.stringify(loaded.setup) ? 1 : 0 };
      render(record);
      query('[data-dry-field=now]').focus();
    } catch (error) { if (token === request && session === generation()) showError(error.message); }
  }
  return { open, close() { request++; if (record) clearTimeout(record.timer); record = null; dialog.close(); dialog.replaceChildren(); } };
}
