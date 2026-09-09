import { LIMITS, ports as outputs, TRIGGERS } from './workflow-spec.js';
import { createWorkflowFiles } from './workflow-file-ui.js';
// Local editor drafts are separate from the saved definition used by the server.
const TYPES = {
  start: { label: '이벤트 시작', group: 'trigger', icon: 'play', hint: '이벤트가 시작될 때' },
  end: { label: '이벤트 종료', group: 'trigger', icon: 'flag', hint: '이벤트가 종료될 때' },
  cron: { label: '크론 스케줄', group: 'trigger', icon: 'clock', hint: '정해진 시간마다' },
  'service-state': { label: '서비스 상태 변경', group: 'trigger', icon: 'flag', hint: '중첩 집계 결과가 바뀔 때' },
  find: { label: '목록 검색', group: 'condition', icon: 'search', hint: '0건·1건·복수 건 분기' },
  datetime: { label: '날짜·시각', group: 'action', icon: 'clock', hint: '현재 시각과 시간대 변환' },
  condition: { label: '조건', group: 'condition', icon: 'split', hint: '조건에 따라 분기' },
  http: { label: 'API 호출', group: 'action', icon: 'globe', hint: 'HTTP 요청 구성하기' },
  finish: { label: '워크플로우 종료', group: 'action', icon: 'check', hint: '결과를 정하고 종료' }
};
const DRAWINGS = {
  play: '<path d="m9 5 11 7-11 7V5Z"/><path d="M4 5v14"/>',
  flag: '<path d="M5 21V3m0 1h14l-3 4 3 4H5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  split: '<path d="M12 3v6M5 21v-5l7-7 7 7v5M2 18l3 3 3-3m8 0 3 3 3-3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="5"/><path d="m8 12 3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m16 3 5 5M4 20l4-1L21 6a2 2 0 0 0-3-3L5 16l-1 4Z"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="8" y="8" width="8" height="8" rx="2"/>',
  arrange: '<rect x="8" y="2" width="8" height="6" rx="1"/><rect x="2" y="16" width="8" height="6" rx="1"/><rect x="14" y="16" width="8" height="6" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  failure: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  never: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'
};
const W = 230, H = 132, GRID = 18;
const snap = (value, minimum = 0) => Math.max(Math.ceil(minimum / GRID), Math.round(value / GRID)) * GRID;
const svg = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${DRAWINGS[name] ?? DRAWINGS.play}</svg>`;
const outputLabel = port => ({ true: '일치', false: '불일치', next: '다음', error: '통신 오류', zero: '0건', one: '1건', many: '복수 건' })[port];

function makeNode(type, id, x, y) {
  return { id, type, x: snap(x, 16), y: snap(y, 24), name: TYPES[type].label, config: {
    ...(['start', 'end'].includes(type) ? { service: '모든 서비스' } : {}),
    ...(type === 'service-state' ? { service: '' } : {}),
    ...(type === 'find' ? { source: 'response.body', field: 'id', value: '', valueSource: 'literal' } : {}),
    ...(type === 'datetime' ? { source: 'now', timezone: 'Asia/Seoul', format: 'iso' } : {}),
    ...(type === 'cron' ? { expression: '0 9 * * 1-5', timezone: 'Asia/Seoul' } : {}),
    ...(type === 'condition' ? { field: 'event.category', operator: 'equals', value: 'incident' } : {}),
    ...(type === 'http' ? { method: 'POST', url: '', headers: '{\n  "Content-Type": "application/json"\n}', body: '{\n  "title": "{{event.title}}"\n}', onError: 'stop', timeoutMs: 10000, retries: 0 } : {}),
    ...(type === 'finish' ? { result: 'success', message: '' } : {})
  } };
}

const STATUS_LABELS = { success: '성공', failure: '실패', never: '실행 기록 없음', queued: '대기', running: '실행 중', canceled: '취소', interrupted: '중단', review: '확인 필요', skipped: '생략' };
const enabledHint = enabled => enabled ? 'ON · 이벤트 발생 시 자동 실행하도록 설정되어 있습니다.' : 'OFF · 이벤트가 발생해도 실행하지 않습니다.';

export function createWorkflowUI({ api, escape, toast, formatTime, dateSummary, authenticated, generation, active, openRuns }) {
  let workflows = [], currentId = null, createKey = null;
  let saved = new Map(), request = 0, busy = false, mode = 'list', loaded = false;
  let search = '', pendingDelete = null;
  let host, controller, gridObserver, connecting = null, selectedEdge = null, drag = null, suppressClick = false;
  const files = createWorkflowFiles({ api, escape, generation, active, toast, current: () => mode === 'editor' ? current() : null, imported: (data, isNew) => { if (isNew) { accept(data); currentId = data.id; } else Object.assign(current(), data, { selected: data.nodes[0]?.id ?? null }); mountEditor(); } });
  const current = () => workflows.find(item => item.id === currentId);
  const find = id => current().nodes.find(node => node.id === id);
  const query = selector => host?.querySelector(selector);
  const options = (values, selected) => values.map(([value, label]) => `<option value="${escape(value)}" ${value === selected ? 'selected' : ''}>${escape(label)}</option>`).join('');
  const field = (label, key, value, settings = '') => `<label class="wf-field">${label}<input data-wf-field="${key}" value="${escape(value)}" ${settings}></label>`;
  const select = (label, key, value, values) => `<label class="wf-field">${label}<select data-wf-field="${key}">${options(values, value)}</select></label>`;
  const area = (label, key, value, rows = 4) => `<label class="wf-field">${label}<textarea data-wf-field="${key}" rows="${rows}" spellcheck="false">${escape(value)}</textarea></label>`;
  const definition = flow => ({ name: flow.name, nodes: flow.nodes, edges: flow.edges });
  const signature = flow => JSON.stringify({ ...definition(flow), secretEdits: flow.secretEdits ?? '{}' });
  const dirty = flow => saved.has(flow.id) && signature(flow) !== signature(saved.get(flow.id));
  const editorState = flow => ({ ...flow, selected: flow.selected ?? flow.nodes[0]?.id ?? null, zoom: flow.zoom ?? 1, secretEdits: '{}' });
  function accept(flow) {
    const previous = workflows.find(item => item.id === flow.id);
    const next = editorState({ ...previous, ...flow });
    saved.set(flow.id, structuredClone(next));
    workflows = workflows.filter(item => item.id !== flow.id); workflows.push(next);
    return next;
  }
  function showError(message) { const node = deleteDialog.open ? deleteDialog.querySelector('#workflow-delete-message') : query('[data-wf-error]'); if (node) { node.hidden = false; node.textContent = message; } else toast(message, true); }
  async function perform(action) {
    if (busy || !authenticated()) return;
    const session = generation(); busy = true;
    const workspace = query('.wf-workspace'); if (workspace) workspace.inert = true;
    const error = query('[data-wf-error]'); if (error) error.hidden = true;
    try { await action(() => session === generation() && authenticated() && active()); }
    catch (failure) { if (session === generation() && authenticated()) showError(failure.message); }
    finally { if (session === generation()) { busy = false; if (workspace) workspace.inert = false; updateEditorState(); } }
  }
  function updateEditorState() {
    if (!current() || !query('[data-wf-save-state]')) return;
    const changed = dirty(current());
    query('[data-wf-save-state]').textContent = changed ? '저장하지 않은 변경' : `저장됨 · v${current().definitionVersion}`;
    query('[data-wf-command="save"]').disabled = busy || !changed;
    query('[data-wf-command="revert"]').disabled = busy || !changed;
    query('[data-wf-command="run"]').disabled = busy || changed;
  }
  async function refresh() {
    if (!active() || !authenticated() || busy || mode !== 'list') return;
    const currentRequest = ++request, session = generation();
    try {
      const data = await api('/api/workflows');
      if (currentRequest !== request || session !== generation() || !active() || busy || mode !== 'list') return;
      const local = workflows;
      workflows = data.workflows.map(flow => {
        const draft = local.find(item => item.id === flow.id);
        if (draft && dirty(draft)) return { ...draft, activity: flow.activity, enabled: flow.enabled };
        const value = editorState(flow); saved.set(flow.id, structuredClone(value)); return value;
      });
      loaded = true;
      renderListRows();
      if (data.engine.fault) showError(data.engine.fault);
    } catch (failure) { if (currentRequest === request && session === generation() && active()) showError(failure.message); }
  }
  window.addEventListener('beforeunload', event => { if (authenticated() && workflows.some(dirty)) { event.preventDefault(); event.returnValue = ''; } });

  const runDialog = document.createElement('dialog');
  runDialog.id = 'workflow-run-dialog'; runDialog.className = 'dialog'; runDialog.setAttribute('aria-label', '워크플로우 수동 실행');
  document.body.append(runDialog);
  async function openRunDialog() {
    if (dirty(current())) { showError('편집 내용을 저장한 뒤 실행해 주세요.'); return; }
    const session = generation(), id = currentId;
    try {
      const data = await api('/api/events');
      if (session !== generation() || !active() || id !== currentId) return;
      const root = current().nodes.find(node => TRIGGERS.includes(node.type));
      runDialog.innerHTML = `<form data-wf-run-form><div class="dialog-heading"><h2>워크플로우 수동 실행</h2><button class="icon-button" type="button" data-close="workflow-run-dialog" aria-label="닫기">${svg('close')}</button></div><p>${escape(current().name)} · 저장된 v${current().definitionVersion}</p><p class="form-hint">실제 API를 호출합니다. 자동 실행이 OFF여도 수동으로 실행할 수 있습니다.</p>${!['cron', 'service-state'].includes(root?.type) ? `<label class="field">입력으로 사용할 이벤트<select name="eventId" required><option value="">이벤트 선택</option>${data.events.map(event => `<option value="${escape(event.id)}">${escape(event.title)}</option>`).join('')}</select></label>` : ''}${root?.type === 'service-state' ? `<label class="field">평가할 서비스 문자열<input name="service" required maxlength="100" value="${escape(root.config.service || '')}"></label><p>현재 상태를 새로 평가합니다. 이전 입력을 반복하지 않습니다.</p>` : ''}<p class="form-error" data-wf-run-error hidden></p><div class="dialog-actions"><button class="button secondary" type="button" data-close="workflow-run-dialog">취소</button><button class="button primary" type="submit">실행</button></div></form>`;
      if (!['cron', 'service-state'].includes(root?.type)) {
        const select = runDialog.querySelector('[name="eventId"]');
        select.closest('label').insertAdjacentHTML('afterend', '<div class="dialog-actions" data-wf-event-pages><button type="button" class="button secondary" data-wf-event-page="-1">이전</button><span data-wf-event-count></span><button type="button" class="button secondary" data-wf-event-page="1">다음</button></div>');
        let pageData = data, loading = false;
        const showPage = () => {
          select.innerHTML = '<option value="">이벤트 선택</option>' + pageData.events.map(event => `<option value="${escape(event.id)}">${escape(event.title)} · ${escape(formatTime(event.start))}</option>`).join('');
          runDialog.querySelector('[data-wf-event-count]').textContent = `${pageData.page} / ${pageData.pages} 페이지 · ${pageData.total}건`;
          for (const button of runDialog.querySelectorAll('[data-wf-event-page]')) button.disabled = loading || (button.dataset.wfEventPage === '-1' ? pageData.page <= 1 : pageData.page >= pageData.pages);
        };
        showPage();
        for (const button of runDialog.querySelectorAll('[data-wf-event-page]')) button.addEventListener('click', async () => {
          if (loading) return; loading = true;
          const page = pageData.page + Number(button.dataset.wfEventPage); showPage();
          try {
            let next;
            try { next = await api(`/api/events?page=${page}&revision=${pageData.revision}`); }
            catch (failure) { if (failure.status !== 409) throw failure; next = await api('/api/events'); }
            if (session !== generation() || !runDialog.open || id !== currentId) return;
            pageData = next;
          } catch (failure) { const error = runDialog.querySelector('[data-wf-run-error]'); error.hidden = false; error.textContent = failure.message; }
          finally { loading = false; if (session === generation() && runDialog.open && id === currentId) showPage(); }
        });
      }
      const requestId = crypto.randomUUID();
      runDialog.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]'); if (button.disabled) return;
        button.disabled = true;
        try {
          const run = await api(`/api/workflows/${id}/run`, { method: 'POST', body: JSON.stringify({ version: current().version, requestId, eventId: form.elements.eventId?.value, service: form.elements.service?.value }) });
          if (session !== generation()) return;
          runDialog.close(); openRuns(id, run.id);
        } catch (failure) { if (session === generation()) { const error = form.querySelector('[data-wf-run-error]'); error.hidden = false; error.textContent = failure.message; } }
        finally { button.disabled = false; }
      });
      runDialog.showModal();
    } catch (failure) { if (session === generation()) showError(failure.message); }
  }

  const deleteDialog = document.createElement('dialog');
  deleteDialog.id = 'workflow-delete-dialog';
  deleteDialog.className = 'dialog delete-dialog';
  deleteDialog.setAttribute('aria-labelledby', 'workflow-delete-title');
  deleteDialog.setAttribute('aria-describedby', 'workflow-delete-name workflow-delete-message');
  deleteDialog.innerHTML = `<div class="dialog-heading"><h2 id="workflow-delete-title">워크플로우 삭제</h2><button type="button" class="icon-button" data-close="workflow-delete-dialog" aria-label="닫기"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 5 14 14M19 5 5 19"/></svg></button></div><p id="workflow-delete-name" class="delete-description"></p><p id="workflow-delete-message" class="muted">이 워크플로우를 삭제하시겠습니까?</p><div class="dialog-actions"><button type="button" class="button secondary" data-close="workflow-delete-dialog" autofocus>취소</button><button type="button" class="button danger" data-wf-confirm-delete>삭제</button></div>`;
  document.body.append(deleteDialog);
  deleteDialog.addEventListener('close', () => { if (!deleteDialog.open) pendingDelete = null; });
  deleteDialog.querySelector('[data-wf-confirm-delete]').addEventListener('click', () => perform(async valid => {
    if (!deleteDialog.open || !pendingDelete) return;
    const { id, index } = pendingDelete;
    const flow = workflows.find(flow => flow.id === id);
    const button = deleteDialog.querySelector('[data-wf-confirm-delete]'); button.disabled = true;
    try { await api(`/api/workflows/${id}`, { method: 'DELETE', body: JSON.stringify({ version: flow.version }) }); }
    finally { button.disabled = false; }
    if (!valid()) return;
    pendingDelete = null; deleteDialog.close(); saved.delete(id);
    workflows = workflows.filter(flow => flow.id !== id);
    if (currentId === id) currentId = workflows[0]?.id ?? null;
    renderListRows();
    const remaining = host.querySelectorAll('[data-wf-open]');
    (remaining[Math.min(index, remaining.length - 1)] ?? query(workflows.length ? '[data-wf-search]' : '[data-wf-command="new"]')).focus({ preventScroll: true });
    toast('워크플로우를 삭제했습니다.');
  }));

  function renderListRows() {
    const needle = search.trim().toLocaleLowerCase('ko-KR');
    const filtered = workflows.filter(flow => flow.name.toLocaleLowerCase('ko-KR').includes(needle));
    const counts = { failure: 0, success: 0, never: 0, working: 0 };
    for (const flow of workflows) counts[['queued', 'running'].includes(flow.activity?.status) ? 'working' : ['canceled', 'interrupted', 'review', 'skipped'].includes(flow.activity?.status) ? 'failure' : flow.activity?.status ?? 'never']++;
    const cards = [
      ['failure', 'failure', STATUS_LABELS.failure, counts.failure],
      ['success', 'success', STATUS_LABELS.success, counts.success],
      ['never', 'never', STATUS_LABELS.never, counts.never],
      ['working', 'clock', '대기 · 실행 중', counts.working]
    ];
    query('[data-wf-summary]').innerHTML = cards.map(([status, icon, label, count]) => `<div class="summary-card ${status}"><span class="summary-icon">${svg(icon)}</span><span class="summary-label">${label}</span><span class="summary-value">${count}<small>개</small></span></div>`).join('');
    const date = value => value ? `<time datetime="${escape(value)}">${escape(formatTime(value))}</time>` : '<span class="wf-no-history">—</span>';
    query('[data-wf-list-count]').textContent = search.trim() ? `${filtered.length} / ${workflows.length}개` : `${workflows.length}개`;
    query('.wf-list-rows').innerHTML = filtered.length ? filtered.map(flow => {
      const activity = flow.activity ?? { status: 'never', lastRun: null, lastSuccess: null, duration: null };
      const trigger = flow.nodes.find(node => TYPES[node.type].group === 'trigger');
      return `<tr><td class="wf-status-cell"><span class="wf-run-status ${activity.status}" role="img" aria-label="마지막 실행: ${STATUS_LABELS[activity.status]}" title="${STATUS_LABELS[activity.status]}">${svg(['queued', 'running'].includes(activity.status) ? 'clock' : ['canceled', 'interrupted', 'review', 'skipped'].includes(activity.status) ? 'failure' : activity.status)}</span></td><td class="wf-name-cell"><button class="wf-flow-link" data-wf-open="${escape(flow.id)}" title="노드 구성 편집. 변경 내용은 저장 버튼으로 반영합니다.">${escape(flow.name || '이름 없는 워크플로우')}</button><small>${trigger ? TYPES[trigger.type].label : '시작 이벤트 미설정'} · ${flow.nodes.length}개 노드${dirty(flow) ? ' · 저장 전 수정' : ''} <button class="wf-history-link" data-wf-history="${escape(flow.id)}">실행 이력</button></small></td><td>${date(activity.lastRun)}</td><td>${date(activity.lastSuccess)}</td><td class="wf-duration-cell">${activity.duration === null ? '<span class="wf-no-history">—</span>' : activity.duration.toFixed(2)}</td><td class="wf-enabled-cell"><button type="button" class="wf-enable-toggle" data-wf-toggle="${escape(flow.id)}" role="switch" aria-checked="${flow.enabled}" aria-label="${escape(flow.name || '이름 없는 워크플로우')} 자동 실행" title="${enabledHint(flow.enabled)}"><span class="wf-switch-track" aria-hidden="true"></span><span data-wf-enabled-label aria-hidden="true">${flow.enabled ? 'ON' : 'OFF'}</span></button></td><td class="wf-row-actions"><button class="wf-icon-button wf-delete-flow" data-wf-delete-flow="${escape(flow.id)}" title="워크플로우 삭제" aria-label="${escape(flow.name || '이름 없는 워크플로우')} 삭제">${svg('trash')}</button></td></tr>`;
    }).join('') : `<tr><td colspan="7" class="wf-list-empty">${svg(workflows.length ? 'search' : 'arrange')}<strong>${!loaded ? '워크플로우를 불러오고 있습니다…' : workflows.length ? '일치하는 워크플로우가 없습니다.' : '등록된 워크플로우가 없습니다.'}</strong><span>${workflows.length ? '다른 이름으로 검색해 보세요.' : '새 워크플로우를 추가해 보세요.'}</span>${workflows.length ? '<button class="wf-text-button" data-wf-command="clear-search">검색 초기화</button>' : ''}</td></tr>`;
  }

  function mountList() {
    mode = 'list';
    pendingDelete = null; deleteDialog.close();
    gridObserver?.disconnect();
    controller?.abort(); controller = new AbortController();
    host = document.querySelector('#main'); connecting = null; selectedEdge = null; drag = null; suppressClick = false;
    host.classList.remove('workflow-main');
    host.innerHTML = `<section class="wf-workspace wf-list-workspace" aria-label="워크플로우 목록">
      <div class="overview"><section class="summary wf-summary" aria-label="워크플로우 요약" title="전체 워크플로우의 마지막 실행 결과 기준">${dateSummary()}<div class="summary-items" data-wf-summary></div></section></div>
      <section class="wf-list-card" aria-label="등록된 워크플로우"><div class="wf-list-toolbar"><div class="wf-list-title"><h1>등록된 워크플로우 <span data-wf-list-count></span></h1></div><div class="wf-list-actions"><label class="wf-list-search">${svg('search')}<input type="search" data-wf-search value="${escape(search)}" placeholder="워크플로우 이름 검색" aria-label="워크플로우 이름 검색" maxlength="100"></label><button class="button secondary" data-wf-command="services">서비스 상태</button><button class="button secondary" data-wf-command="upload">JSON 가져오기</button><button class="button primary" data-wf-command="new">${svg('plus')} 새 워크플로우</button></div></div>
      <p class="form-error" data-wf-error hidden></p><div class="wf-table-scroll" tabindex="0" role="region" aria-label="워크플로우 목록 표"><table class="wf-list-table"><thead><tr><th scope="col" class="wf-status-cell"><span title="마지막 실행 상태">상태</span></th><th scope="col" class="wf-name-cell">워크플로우 이름</th><th scope="col">마지막 실행일자</th><th scope="col">마지막 성공일자</th><th scope="col" class="wf-duration-cell">마지막 동작 시간 <span>(sec)</span></th><th scope="col" class="wf-enabled-cell">자동 실행</th><th scope="col" class="wf-row-actions">삭제</th></tr></thead><tbody class="wf-list-rows"></tbody></table></div>
      </section>
    </section>`;
    const settings = { signal: controller.signal };
    host.addEventListener('click', onClick, settings);
    host.addEventListener('input', onInput, settings);
    renderListRows(); refresh();
  }

  function subtitle(node) {
    const c = node.config;
    if (node.type === 'http') return c.url || '호출할 URL을 입력하세요';
    if (node.type === 'condition') return `${c.field} ${ { equals: '=', notEquals: '≠', contains: '포함', exists: '값 있음', gt: '>', gte: '≥', lt: '<', lte: '≤' }[c.operator]} ${c.operator === 'exists' ? '' : c.value}`;
    if (node.type === 'cron') return `${c.expression} · ${c.timezone}`;
    if (node.type === 'finish') return { success: '성공으로 종료', failure: '실패로 종료' }[c.result];
    return c.service || '모든 서비스';
  }

  function nodeMarkup(node) {
    const type = TYPES[node.type], isTrigger = type.group === 'trigger';
    return `<article class="wf-node wf-${type.group}${current().selected === node.id && !selectedEdge ? ' is-selected' : ''}" data-node-id="${escape(node.id)}" style="left:${node.x}px;top:${node.y}px" aria-label="${escape(node.name)} 노드">
      ${!isTrigger ? `<button class="wf-port wf-input" data-wf-input="${escape(node.id)}" aria-label="${escape(node.name)}에 연결" title="이 노드로 연결"></button>` : ''}
      <button class="wf-node-select" data-wf-select="${escape(node.id)}" aria-pressed="${current().selected === node.id && !selectedEdge}"><span class="wf-node-top"><span class="wf-type-icon">${svg(type.icon)}</span><span><small>${type.label}</small><strong>${escape(node.name)}</strong></span></span><span class="wf-node-description">${escape(subtitle(node))}</span><span class="wf-node-caption">${node.type === 'http' ? `<b>${escape(node.config.method)}</b> HTTP 요청` : isTrigger ? '시작점' : node.type === 'condition' ? '두 갈래로 분기' : '이 경로의 마지막 동작'}</span></button>
      ${outputs(node).map(port => `<button class="wf-port wf-output ${port}${connecting?.from === node.id && connecting.port === port ? ' is-connecting' : ''}" data-wf-output="${escape(node.id)}" data-port="${port}" aria-label="${escape(node.name)} ${outputLabel(port)} 연결" title="노드 아래의 연결점을 누른 뒤 다음 노드를 선택하세요."><span>${outputLabel(port)}</span></button>`).join('')}
    </article>`;
  }

  function edgePath(edge) {
    const from = find(edge.from), to = find(edge.to);
    if (!from || !to) return '';
    const sx = from.x + W * (edge.port === 'true' ? .28 : ['false', 'error'].includes(edge.port) ? .72 : .5), sy = from.y + H;
    const tx = to.x + W / 2, ty = to.y;
    const bend = Math.max(50, Math.abs(ty - sy) * .5);
    return `M ${sx} ${sy} C ${sx} ${sy + bend}, ${tx} ${ty - bend}, ${tx} ${ty}`;
  }

  function renderEdges() {
    const layer = query('.wf-edges');
    if (!layer) return;
    layer.innerHTML = current().edges.map(edge => `<g class="wf-edge ${edge.port}${selectedEdge === edge.id ? ' is-selected' : ''}"><path class="wf-edge-line" d="${edgePath(edge)}"/><path class="wf-edge-hit" d="${edgePath(edge)}" data-wf-edge="${escape(edge.id)}" role="button" tabindex="0" aria-label="${escape(find(edge.from)?.name)}에서 ${escape(find(edge.to)?.name)} 연결 선택"/></g>`).join('');
  }

  function dimensions() {
    return { width: Math.max(720, ...current().nodes.map(node => node.x + W + 65)), height: Math.max(640, ...current().nodes.map(node => node.y + H + 80)) };
  }

  function syncGrid() {
    const stage = query('.wf-stage'), world = query('.wf-world');
    if (!stage || !world) return;
    const spacing = GRID * current().zoom;
    const stageBounds = stage.getBoundingClientRect(), worldBounds = world.getBoundingClientRect();
    // Gradient dots sit at tile centers; align those centers with world (0, 0).
    stage.style.backgroundSize = `${spacing}px ${spacing}px`;
    stage.style.backgroundPosition = `${worldBounds.left - stageBounds.left - stage.clientLeft - spacing / 2}px ${worldBounds.top - stageBounds.top - stage.clientTop - spacing / 2}px`;
  }

  function sizeCanvas() {
    const world = query('.wf-world');
    if (!world) return;
    const { width, height } = dimensions(), zoom = current().zoom;
    world.style.width = `${width}px`; world.style.height = `${height}px`;
    world.style.transform = `translate(${current().panX ?? 0}px, ${current().panY ?? 0}px) scale(${zoom})`;
    query('[data-wf-zoom-label]').textContent = `${Math.round(zoom * 100)}%`;
    syncGrid();
  }

  function zoomAt(value, clientX, clientY) {
    if (drag) return;
    const stage = query('.wf-stage'), flow = current(), rect = stage.getBoundingClientRect();
    const zoom = Math.max(.35, Math.min(1.5, value));
    if (zoom === flow.zoom) return;
    const x = clientX === undefined ? stage.clientWidth / 2 : clientX - rect.left - stage.clientLeft;
    const y = clientY === undefined ? stage.clientHeight / 2 : clientY - rect.top - stage.clientTop;
    const ratio = zoom / flow.zoom;
    flow.panX = x - (x - (flow.panX ?? 0)) * ratio;
    flow.panY = y - (y - (flow.panY ?? 0)) * ratio;
    flow.zoom = zoom;
    sizeCanvas();
  }

  function onWheel(event) {
    event.preventDefault();
    if (drag || !event.deltaY) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? query('.wf-stage').clientHeight : 1;
    const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
    zoomAt(current().zoom * Math.exp(-delta * .002), event.clientX, event.clientY);
  }

  function revealNode(node) {
    const stage = query('.wf-stage'), flow = current(), margin = 24;
    const left = (flow.panX ?? 0) + node.x * flow.zoom, top = (flow.panY ?? 0) + node.y * flow.zoom;
    const maxLeft = Math.max(margin, stage.clientWidth - W * flow.zoom - margin);
    const maxTop = Math.max(margin, stage.clientHeight - (H + 32) * flow.zoom - margin);
    flow.panX = (flow.panX ?? 0) + Math.max(margin, Math.min(maxLeft, left)) - left;
    flow.panY = (flow.panY ?? 0) + Math.max(margin, Math.min(maxTop, top)) - top;
    sizeCanvas();
  }

  function renderCanvas() {
    const active = document.activeElement;
    const focusAttribute = ['data-wf-select', 'data-wf-input', 'data-wf-output', 'data-wf-edge'].find(attribute => active?.hasAttribute(attribute));
    const focusSelector = focusAttribute ? `[${focusAttribute}="${CSS.escape(active.getAttribute(focusAttribute))}"]${active.dataset.port ? `[data-port="${active.dataset.port}"]` : ''}` : null;
    query('.wf-nodes').innerHTML = current().nodes.map(nodeMarkup).join('');
    query('.wf-canvas-empty').hidden = current().nodes.length > 0;
    renderEdges(); sizeCanvas(); renderStatus();
    if (focusSelector) query(focusSelector)?.focus({ preventScroll: true });
  }

  function renderStatus() {
    query('.wf-count').textContent = `${current().nodes.length}개 노드 · ${current().edges.length}개 연결`;
    query('.wf-canvas-help').textContent = connecting ? `${find(connecting.from)?.name}의 ‘${outputLabel(connecting.port)}’ → 연결할 노드를 선택하세요. Esc로 취소` : '';
    query('.wf-editor-footer').hidden = !connecting;
    query('.wf-stage').classList.toggle('is-connecting', !!connecting);
    updateEditorState();
  }

  function fit() {
    const stage = query('.wf-stage');
    if (!stage) return;
    const { width, height } = dimensions();
    current().zoom = Math.max(.35, Math.min(1, (stage.clientWidth - 32) / width, (stage.clientHeight - 24) / height));
    current().panX = (stage.clientWidth - width * current().zoom) / 2;
    current().panY = (stage.clientHeight - height * current().zoom) / 2;
    sizeCanvas();
  }

  function renderInspector() {
    const inspector = query('.wf-inspector');
    const edge = current().edges.find(item => item.id === selectedEdge);
    if (edge) {
      inspector.innerHTML = `<div class="wf-panel-title"><span>${svg('link')} 연결 설정</span></div><div class="wf-inspector-body"><p class="wf-section-label">선택한 연결</p><div class="wf-connection-summary"><strong>${escape(find(edge.from).name)}</strong><span>${outputLabel(edge.port)} ↓</span><strong>${escape(find(edge.to).name)}</strong></div><p class="wf-help">연결을 지워도 양쪽 노드는 그대로 남습니다.</p><button class="wf-delete" data-wf-command="delete-edge">${svg('trash')} 연결 삭제</button></div>`;
      return;
    }
    const node = find(current().selected);
    if (!node) {
      inspector.innerHTML = `<div class="wf-panel-title"><span>${svg('arrange')} 노드 설정</span></div><div class="wf-inspector-empty">${svg('fit')}<h3>노드를 선택하세요</h3><p>캔버스의 노드를 선택하면<br>이곳에서 내용을 바꿀 수 있습니다.</p></div>`;
      return;
    }
    const c = node.config, type = TYPES[node.type];
    let fields = '';
    if (['start', 'end'].includes(node.type)) fields = `${field('대상 서비스', 'service', c.service, 'maxlength="100"')}<p class="wf-help">‘모든 서비스’ 또는 서비스 ID·선택 당시 표시명을 입력하세요.</p><div class="wf-note">입력한 ${node.type === 'start' ? '시작' : '종료'} 시각에 실행합니다. 지난 시각은 소급 실행하지 않습니다.</div>`;
    if (node.type === 'cron') fields = `${field('크론 표현식', 'expression', c.expression, 'spellcheck="false" maxlength="100"')}${select('시간대', 'timezone', c.timezone, [['Asia/Seoul', 'Asia/Seoul'], ['UTC', 'UTC'], ['Asia/Tokyo', 'Asia/Tokyo']])}<div class="wf-note">예시: <code>0 9 * * 1-5</code><br>매주 월요일부터 금요일, 오전 9시</div>`;
    if (node.type === 'condition') fields = `${field('비교할 값의 경로', 'field', c.field, 'maxlength="200" placeholder="response.body.success"')}${select('조건', 'operator', c.operator, [['equals', '같음'], ['notEquals', '다름'], ['contains', '포함'], ['exists', '값이 있음'], ['isPresent', '필드 존재 (null 포함)'], ['isMissing', '필드 누락'], ['isNull', 'null'], ['gt', '초과'], ['gte', '이상'], ['lt', '미만'], ['lte', '이하']])}${!['exists', 'isPresent', 'isMissing', 'isNull'].includes(c.operator) ? field('비교 값', 'value', c.value, 'maxlength="2000"') : ''}<div class="wf-branch-key"><span><i></i> 일치하는 경우</span><span><i></i> 일치하지 않는 경우</span></div><p class="wf-help">예: event.category, response.status, response.body.success, nodes.노드ID.body 값. 숫자와 true/false는 해당 자료형으로 비교합니다.</p>`;
    if (node.type === 'http') fields = `${select('메서드', 'method', c.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(value => [value, value]))}${field('요청 URL', 'url', c.url, 'type="url" spellcheck="false" maxlength="2000"')}${area('헤더 (JSON)', 'headers', c.headers, 3)}${area('요청 본문', 'body', c.body, 5)}<p class="wf-help">변수 예시: {{event.title}}, {{response.body.id}}, {{secrets.token}}. URL 변수는 인코딩하며 JSON 본문의 문자열은 따옴표를 보존합니다.</p>${field('요청 제한 시간 (ms)', 'timeoutMs', String(c.timeoutMs ?? 10000), 'type="number" min="100" max="30000" step="100"')}${field('통신 오류 재시도 횟수 (같은 요청 반복)', 'retries', String(c.retries ?? 0), 'type="number" min="0" max="3"')}${select('통신 오류가 발생하면', 'onError', c.onError, [['stop', '워크플로우 실패로 종료'], ['continue', '다음 노드로 계속 진행'], ['branch', '오류 연결로 진행']])}<div class="wf-note">HTTP 상태와 응답 본문은 조건 노드에서 판단합니다. 리다이렉트는 따라가지 않으며 응답은 최대 128KB입니다.</div>`;
    if (node.type === 'service-state') fields = field('서비스 문자열 (비우면 모든 서비스)', 'service', c.service, 'maxlength="100"') + '<p>활성 이벤트 전체를 집계합니다. trigger.service / previous / severity를 사용하세요.</p>';
    if (node.type === 'find') fields = field('배열 경로', 'source', c.source) + field('항목 안의 키 경로', 'field', c.field) + select('비교 대상', 'valueSource', c.valueSource, [['literal', '고정값'], ['path', '값 경로']]) + field('비교 값 또는 경로', 'value', c.value);
    if (node.type === 'datetime') fields = field('시각 경로 또는 now', 'source', c.source) + field('IANA 시간대', 'timezone', c.timezone) + select('출력 형식', 'format', c.format, [['iso','UTC ISO'],['local','현지 ISO (시차 포함)'],['date','날짜'],['time','시각'],['unix-ms','Unix 밀리초']]);
    if (node.type === 'condition') fields += select('비교 대상', 'valueSource', c.valueSource || 'literal', [['literal','고정값'],['path','값 경로']]) + area('복합 조건 JSON (입력하면 위 단일 조건 대신 사용)', 'rules', c.rules || '', 6);
    if (node.type === 'http') fields += select('요청 의도', 'intent', c.intent || 'auto', [['auto','메서드 기준'],['read','조회'],['change','변경']]) + select('외부 중복 방지', 'idempotency', c.idempotency || 'none', [['none','검증되지 않음'],['verified','외부 보장 검증 완료']]) + select('응답 기록', 'outputMode', c.outputMode || 'summary', [['summary','가린 요약'],['none','본문 미저장'],['allowlist','허용 필드만']]) + field('기록 허용 경로 (쉼표 구분)', 'outputPaths', c.outputPaths || '');
    if (TRIGGERS.includes(node.type) && node.type !== 'service-state') fields += field('변경 대상 서비스 문자열 (호출 직렬화)', 'executionService', c.executionService || '', 'maxlength="100"');
    if (node.type === 'finish') fields = `${select('워크플로우 결과', 'result', c.result, [['success', '성공'], ['failure', '실패'], ['review', '확인 필요'], ['skipped', '생략']])}${area('종료 사유', 'message', c.message, 3)}`;
    inspector.innerHTML = `<div class="wf-panel-title"><span>${svg('arrange')} 노드 설정</span><span class="wf-panel-meta">${type.label}</span></div><div class="wf-inspector-body"><div class="wf-inspector-type wf-${type.group}"><span class="wf-type-icon">${svg(type.icon)}</span><div><strong>${type.label}</strong><small>${type.hint}</small></div></div>${field('노드 이름', 'name', node.name, 'maxlength="80"')}<div class="wf-field-divider"></div>${fields}<button class="wf-delete" data-wf-command="delete-node">${svg('trash')} 노드 삭제</button></div>`;
  }

  function refreshSelection() { renderCanvas(); renderInspector(); }

  function addNode(type) {
    if (current().nodes.length >= LIMITS.nodes) { toast('최대 100개 노드를 배치할 수 있습니다.'); return; }
    const count = current().nodes.length;
    const node = makeNode(type, `node-${crypto.randomUUID()}`, 65 + (count % 2) * 360, count ? Math.max(...current().nodes.map(item => item.y)) + 202 : 36);
    current().nodes.push(node); current().selected = node.id; selectedEdge = null; connecting = null;
    refreshSelection();
    revealNode(node);
  }

  function connect(toId) {
    if (!connecting) return;
    const fromId = connecting.from;
    if (toId === fromId || TYPES[find(toId).type].group === 'trigger') { toast('시작점 이외의 다른 노드를 선택하세요.'); return; }
    const reachable = [toId], seen = new Set();
    while (reachable.length) {
      const id = reachable.pop();
      if (id === fromId) { toast('순환하지 않는 흐름으로 연결해 주세요.'); return; }
      if (seen.has(id)) continue;
      seen.add(id); reachable.push(...current().edges.filter(edge => edge.from === id).map(edge => edge.to));
    }
    current().edges = current().edges.filter(edge => edge.from !== fromId || edge.port !== connecting.port);
    current().edges.push({ id: `edge-${crypto.randomUUID()}`, ...connecting, to: toId });
    current().selected = toId; connecting = null; selectedEdge = null; refreshSelection();
  }

  function arrange() {
    const nodes = current().nodes, levels = new Map(nodes.map(node => [node.id, 0]));
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      for (const edge of current().edges) if (levels.get(edge.to) <= levels.get(edge.from)) { levels.set(edge.to, levels.get(edge.from) + 1); changed = true; }
      if (!changed) break;
    }
    const rows = new Map();
    for (const node of nodes) { const level = levels.get(node.id); if (!rows.has(level)) rows.set(level, []); rows.get(level).push(node); }
    const columns = Math.max(2, ...[...rows.values()].map(row => row.length));
    for (const [level, row] of rows) row.forEach((node, index) => { node.x = snap(65 + (columns - row.length) * 162 + index * 324); node.y = snap(36 + level * 216); });
    renderCanvas(); fit();
  }

  function onClick(event) {
    if (busy) return;
    if (suppressClick) { suppressClick = false; if (event.detail > 0) return; }
    const target = event.target.closest('button, [data-wf-edge]');
    if (!target) return;
    if (target.dataset.wfHistory) { openRuns(target.dataset.wfHistory); return; }
    if (target.dataset.wfToggle) {
      const flow = workflows.find(item => item.id === target.dataset.wfToggle);
      if (!flow) return;
      if (dirty(flow)) { showError('편집 내용을 저장하거나 되돌린 뒤 자동 실행을 변경해 주세요.'); return; }
      perform(async valid => { const updated = await api(`/api/workflows/${flow.id}/enabled`, { method: 'PUT', body: JSON.stringify({ version: flow.version, enabled: !flow.enabled }) }); if (valid()) { accept(updated); renderListRows(); } });
      return;
    }
    if (target.dataset.wfDeleteFlow) {
      const id = target.dataset.wfDeleteFlow;
      const flow = workflows.find(item => item.id === id);
      if (!flow) return;
      const index = [...host.querySelectorAll('[data-wf-delete-flow]')].indexOf(target);
      pendingDelete = { id, index };
      deleteDialog.querySelector('#workflow-delete-name').textContent = flow.name || '이름 없는 워크플로우';
      deleteDialog.querySelector('#workflow-delete-message').textContent = '이 워크플로우를 삭제하시겠습니까? 실행 중인 작업도 중지합니다. 실행 이력은 남습니다.';
      deleteDialog.showModal();
      return;
    }
    if (target.dataset.wfOpen) { currentId = target.dataset.wfOpen; mountEditor(); return; }
    if (target.dataset.wfAdd) { addNode(target.dataset.wfAdd); return; }
    if (target.dataset.wfOutput) {
      const next = { from: target.dataset.wfOutput, port: target.dataset.port };
      connecting = connecting?.from === next.from && connecting.port === next.port ? null : next;
      current().selected = next.from; selectedEdge = null; refreshSelection();
      query(`[data-wf-output="${next.from}"][data-port="${next.port}"]`)?.focus({ preventScroll: true });
      return;
    }
    const nodeId = target.dataset.wfSelect ?? target.dataset.wfInput;
    if (nodeId) {
      if (connecting) connect(nodeId);
      else { current().selected = nodeId; selectedEdge = null; refreshSelection(); }
      return;
    }
    if (target.dataset.wfEdge) { selectedEdge = target.dataset.wfEdge; connecting = null; refreshSelection(); return; }
    switch (target.dataset.wfCommand) {
      case 'upload': files.upload().catch(error => showError(error.message)); break;
      case 'download': files.download().catch(error => showError(error.message)); break;
      case 'services': files.services().catch(error => showError(error.message)); break;
      case 'new': {
        createKey ??= crypto.randomUUID();
        perform(async valid => { const flow = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ requestId: createKey, name: '새 워크플로우' }) }); if (valid()) { createKey = null; accept(flow); currentId = flow.id; mountEditor(); startNameEdit(); } }); break;
      }
      case 'save': finishNameEdit(); perform(async valid => { const flow = current(); const updated = await api(`/api/workflows/${flow.id}`, { method: 'PUT', body: JSON.stringify({ ...definition(flow), version: flow.version, secrets: JSON.parse(flow.secretEdits || '{}') }) }); if (valid()) { accept(updated); mountEditor(); toast('워크플로우를 저장했습니다.'); } }); break;
      case 'revert': workflows = workflows.map(flow => flow.id === currentId ? structuredClone(saved.get(flow.id)) : flow); mountEditor(); break;
      case 'reload': if (dirty(current()) && !confirm('저장하지 않은 변경을 버리고 다시 불러오시겠습니까?')) break; perform(async valid => { const flow = await api(`/api/workflows/${currentId}`); if (valid()) { accept(flow); mountEditor(); } }); break;
      case 'run': openRunDialog(); break;
      case 'history': openRuns(currentId); break;
      case 'rename': startNameEdit(); break;
      case 'list': mountList(); break;
      case 'clear-search': search = ''; query('[data-wf-search]').value = ''; renderListRows(); query('[data-wf-search]').focus(); break;
      case 'delete-node': {
        const id = current().selected;
        current().nodes = current().nodes.filter(node => node.id !== id);
        current().edges = current().edges.filter(edge => edge.from !== id && edge.to !== id);
        current().selected = null; connecting = null; refreshSelection(); break;
      }
      case 'delete-edge': current().edges = current().edges.filter(edge => edge.id !== selectedEdge); selectedEdge = null; refreshSelection(); break;
      case 'arrange': arrange(); break;
      case 'fit': fit(); break;
      case 'zoom-in': zoomAt(current().zoom + .1); break;
      case 'zoom-out': zoomAt(current().zoom - .1); break;
      case 'cancel-connect': connecting = null; renderCanvas(); break;
    }
  }

  function startNameEdit() {
    const input = query('[data-wf-name]');
    input.dataset.previousName = current().name;
    query('[data-wf-command="rename"]').hidden = true;
    input.hidden = false;
    input.focus(); input.select();
  }

  function finishNameEdit(cancel = false) {
    const input = query('[data-wf-name]');
    if (!input || input.hidden) return;
    current().name = cancel ? input.dataset.previousName : input.value.trim() || input.dataset.previousName || '이름 없는 워크플로우';
    input.value = current().name;
    query('[data-wf-editor-title]').textContent = current().name || '이름 없는 워크플로우';
    input.hidden = true;
    query('[data-wf-command="rename"]').hidden = false; updateEditorState();
  }

  function onInput(event) {
    if (busy) return;
    if (event.target.matches('[data-wf-secrets]')) { current().secretEdits = event.target.value; updateEditorState(); return; }
    if (event.target.matches('[data-wf-search]')) { search = event.target.value; renderListRows(); return; }
    if (event.target.matches('[data-wf-name]')) {
      current().name = event.target.value;
      query('[data-wf-editor-title]').textContent = current().name || '이름 없는 워크플로우';
      updateEditorState(); return;
    }
    const key = event.target.dataset.wfField, node = find(current().selected);
    if (!key || !node) return;
    if (key === 'name') node.name = event.target.value;
    else node.config[key] = event.target.value;
    renderCanvas();
  }

  function onPointerDown(event) {
    if (busy) return;
    suppressClick = false;
    if (drag || !event.isPrimary || event.button !== 0) return;
    const stage = event.target.closest('.wf-stage');
    if (!stage) return;
    const handle = event.target.closest('[data-wf-select]');
    if (handle) {
      if (connecting) return;
      const node = find(handle.dataset.wfSelect);
      drag = { mode: 'node', node, x: event.clientX, y: event.clientY, startX: node.x, startY: node.y, handle, pointerId: event.pointerId, moved: false };
    } else {
      if (event.target.closest('.wf-node, [data-wf-edge], button, input, select, textarea, a')) return;
      const rect = stage.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.left + stage.clientWidth || event.clientY < rect.top || event.clientY >= rect.top + stage.clientHeight) return;
      event.preventDefault(); stage.focus({ preventScroll: true });
      drag = { mode: 'pan', x: event.clientX, y: event.clientY, startX: current().panX ?? 0, startY: current().panY ?? 0, handle: stage, pointerId: event.pointerId, moved: false };
      stage.classList.add('is-panning');
    }
    drag.handle.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; event.preventDefault();
    if (drag.mode === 'pan') {
      current().panX = drag.startX + dx; current().panY = drag.startY + dy;
      sizeCanvas(); return;
    }
    const zoom = current().zoom;
    drag.node.x = snap(drag.startX + dx / zoom, 16);
    drag.node.y = snap(drag.startY + dy / zoom, 24);
    const element = drag.handle.closest('.wf-node');
    element.style.left = `${drag.node.x}px`; element.style.top = `${drag.node.y}px`; element.classList.add('is-dragging');
    renderEdges(); sizeCanvas(); updateEditorState();
  }

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const previous = drag; drag = null;
    if (previous.handle.hasPointerCapture(event.pointerId)) previous.handle.releasePointerCapture(event.pointerId);
    if (previous.mode === 'pan') {
      previous.handle.classList.remove('is-panning');
      suppressClick = previous.moved && event.type === 'pointerup';
      return;
    }
    previous.handle.closest('.wf-node').classList.remove('is-dragging');
    if (previous.moved) {
      suppressClick = event.type === 'pointerup'; current().selected = previous.node.id; selectedEdge = null;
      // Wait for the following click before replacing the captured element.
      queueMicrotask(() => { if (host?.isConnected) { renderEdges(); renderInspector(); for (const node of host.querySelectorAll('.wf-node')) { const selected = node.dataset.nodeId === current().selected; node.classList.toggle('is-selected', selected); node.querySelector('.wf-node-select').setAttribute('aria-pressed', String(selected)); } } });
    }
  }

  function mountEditor() {
    mode = 'editor'; request++;
    pendingDelete = null; deleteDialog.close();
    gridObserver?.disconnect();
    controller?.abort(); controller = new AbortController();
    host = document.querySelector('#main'); connecting = null; selectedEdge = null; drag = null; suppressClick = false;
    host.classList.add('workflow-main');
    host.innerHTML = `<section class="wf-workspace" aria-label="워크플로우 편집">
      <div class="wf-editor-actions"><button class="wf-back-link" data-wf-command="list">${svg('back')} 워크플로우 목록</button><div><button class="button secondary" data-wf-command="upload">JSON 가져오기</button><button class="button secondary" data-wf-command="download" title="저장된 정의 다운로드">JSON 다운로드</button><button class="button secondary" data-wf-command="history">실행 이력</button><button class="button secondary" data-wf-command="revert">저장된 내용으로 되돌리기</button><button class="button secondary" data-wf-command="reload">다시 불러오기</button><button class="button secondary" data-wf-command="run" title="저장된 구성으로 실제 API 호출">수동 실행</button><button class="button primary" data-wf-command="save">저장</button></div></div><p class="form-error" data-wf-error hidden></p>
      <details class="wf-secrets"><summary>비밀 변수${current().secretNames?.length ? ` · ${current().secretNames.join(', ')}` : ''}</summary><p class="form-hint">JSON 객체로 입력하면 암호화하여 저장합니다. 사용 예: {{secrets.token}}. 기존 값은 표시하지 않습니다. 삭제하려면 해당 값을 null로 입력하세요.</p><textarea data-wf-secrets rows="3" aria-label="비밀 변수 JSON" placeholder='{"token":"새 값"}'>${escape(current().secretEdits)}</textarea></details><div class="wf-editor">
      <div class="wf-canvas-bar" title="빈 배경을 끌어 화면 이동 · 마우스 휠로 확대·축소 · 노드를 끌어 이동 · 아래 연결점을 눌러 연결 · 연결선을 눌러 편집"><div class="wf-heading-title"><h1><button class="wf-title-button" data-wf-command="rename" title="워크플로우 이름 편집"><span data-wf-editor-title>${escape(current().name || '이름 없는 워크플로우')}</span>${svg('edit')}</button><input class="wf-title-input" data-wf-name value="${escape(current().name)}" maxlength="80" aria-label="워크플로우 이름" hidden></h1><span class="wf-save-state" data-wf-save-state></span></div><button class="wf-icon-button" data-wf-command="arrange" title="노드 자동 정렬" aria-label="노드 자동 정렬">${svg('arrange')}</button></div>
      <aside class="wf-palette" aria-label="노드 목록"><div class="wf-library">${[['trigger', '시작 이벤트'], ['condition', '흐름 제어'], ['action', '액션']].map(([group, label]) => `<section class="wf-node-group"><h2>${label}</h2>${Object.entries(TYPES).filter(([, type]) => type.group === group).map(([id, type]) => `<button class="wf-library-item wf-${group}" data-wf-add="${id}"><span class="wf-type-icon">${svg(type.icon)}</span><span><strong>${type.label}</strong><small>${type.hint}</small></span>${svg('plus')}</button>`).join('')}</section>`).join('')}</div></aside>
      <div class="wf-canvas"><div class="wf-stage" tabindex="0" aria-label="노드 캔버스"><div class="wf-world-wrap"><div class="wf-world"><svg class="wf-edges" aria-label="노드 연결"></svg><div class="wf-nodes"></div></div></div><div class="wf-canvas-empty" hidden>${svg('arrange')}<h3>첫 번째 노드를 추가해 보세요</h3><p>시작 이벤트를 고르고, 필요한 동작을 연결하세요.</p><button class="button secondary" data-wf-add="start">${svg('plus')} 이벤트 시작 추가</button></div></div><div class="wf-canvas-footer"><span class="wf-count"></span><div class="wf-zoom"><button class="wf-icon-button" data-wf-command="zoom-out" aria-label="축소">${svg('minus')}</button><span data-wf-zoom-label></span><button class="wf-icon-button" data-wf-command="zoom-in" aria-label="확대">${svg('plus')}</button><span class="wf-zoom-divider"></span><button class="wf-icon-button" data-wf-command="fit" aria-label="화면에 맞추기" title="화면에 맞추기">${svg('fit')}</button></div></div></div>
      <aside class="wf-inspector" aria-label="노드 설정"></aside><div class="wf-editor-footer"><span class="wf-canvas-help" role="status"></span></div></div></section>`;
    const settings = { signal: controller.signal };
    host.addEventListener('click', onClick, settings);
    host.addEventListener('input', onInput, settings);
    host.addEventListener('change', event => {
      if (['operator', 'onError'].includes(event.target.dataset.wfField)) {
        if (event.target.dataset.wfField === 'onError' && event.target.value !== 'branch') current().edges = current().edges.filter(edge => edge.from !== current().selected || edge.port !== 'error');
        renderCanvas(); renderInspector();
      }
    }, settings);
    host.addEventListener('focusout', event => { if (event.target.matches('[data-wf-name]')) finishNameEdit(); }, settings);
    host.addEventListener('focusin', event => {
      const node = event.target.closest('[data-node-id]');
      if (!drag && node) revealNode(find(node.dataset.nodeId));
    }, settings);
    host.addEventListener('keydown', event => {
      if (event.target.matches('[data-wf-name]') && !event.isComposing && ['Enter', 'Escape'].includes(event.key)) {
        event.preventDefault(); finishNameEdit(event.key === 'Escape'); query('[data-wf-command="rename"]').focus(); return;
      }
      if (event.key === 'Escape' && connecting) { connecting = null; renderCanvas(); }
      if (event.target.matches('.wf-stage') && !drag && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 160 : 48;
        current().panX = (current().panX ?? 0) + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0);
        current().panY = (current().panY ?? 0) + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0);
        sizeCanvas();
      }
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-wf-edge]')) { event.preventDefault(); selectedEdge = event.target.dataset.wfEdge; refreshSelection(); }
    }, settings);
    host.addEventListener('pointerdown', onPointerDown, settings);
    host.addEventListener('pointermove', onPointerMove, settings);
    host.addEventListener('pointerup', endDrag, settings);
    host.addEventListener('pointercancel', endDrag, settings);
    host.addEventListener('lostpointercapture', endDrag, settings);
    renderCanvas(); renderInspector();
    const stage = query('.wf-stage');
    stage.addEventListener('wheel', onWheel, { ...settings, passive: false });
    gridObserver = new ResizeObserver(syncGrid);
    gridObserver.observe(stage);
    if (stage.clientWidth < 500) {
      current().zoom = .85;
      current().panX = (stage.clientWidth - dimensions().width * current().zoom) / 2;
      current().panY = 12;
      sizeCanvas();
    } else fit();
  }

  function refreshDate() {
    const context = query('.wf-summary .summary-context');
    if (!context) return;
    const markup = dateSummary();
    if (context.outerHTML !== markup) context.outerHTML = markup;
  }

  return { mount() { if (mode === 'editor' && current()) mountEditor(); else mountList(); }, refresh, refreshDate, clear() { files.close(); pendingDelete = null; deleteDialog.close(); gridObserver?.disconnect(); controller?.abort(); controller = null; host = null; request++; runDialog.close(); runDialog.replaceChildren(); saved.clear(); workflows = []; currentId = null; createKey = null; loaded = false; busy = false; mode = 'list'; search = ''; connecting = null; selectedEdge = null; drag = null; } };
}
