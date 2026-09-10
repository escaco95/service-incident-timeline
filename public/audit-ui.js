import { randomUUID } from './random-id.js';
import { switchLabel } from './workflow-spec.js';
import { addDays, calendarDate, dateParts, fromDateKey } from './date-utils.js';

const $ = selector => document.querySelector(selector);
const PERIODS = [
  { id: '1d', label: '1일', days: 1 }, { id: '1w', label: '1주', days: 7 }, { id: '2w', label: '2주', days: 14 },
  { id: '1m', label: '1개월', months: 1 }, { id: '3m', label: '3개월', months: 3 }, { id: '6m', label: '6개월', months: 6 }, { id: '1y', label: '1년', months: 12 }
];
const DEFAULT_PERIOD = '1m';
const REFRESH_FEEDBACK_MS = 600;

// Date inputs include both endpoints. Month/year shortcuts clamp to month end.
export function auditDateRange(period, today) {
  const preset = PERIODS.find(item => item.id === period);
  if (!preset) throw new Error('조회 기간을 확인해 주세요.');
  if (preset.days) return { fromDate: addDays(today, 1 - preset.days), untilDate: today };
  const { year, month, day } = dateParts(today);
  const monthIndex = month - 1 - preset.months;
  const lastDay = dateParts(calendarDate(year, monthIndex + 1, 0)).day;
  return { fromDate: calendarDate(year, monthIndex, Math.min(day, lastDay)), untilDate: today };
}
const changeNames = { 'event-created': '이벤트 생성', 'event-updated': '이벤트 수정', 'event-deleted': '이벤트 삭제', 'services-updated': '서비스 목록 변경' };
Object.assign(changeNames, { 'events-reset': '이벤트 초기화', 'workflows-reset': '워크플로우 초기화' });
const statusNames = { queued: '대기', running: '실행 중', skipped: '생략', success: '성공', failure: '실패', canceled: '취소', interrupted: '중단', review: '확인 필요', 'handled-error': '오류 처리됨' };

Object.assign(changeNames, { 'log-policy-updated': '로그 관리 정책 변경', 'audit-rotated': '감사 로그 로테이션', 'events-expired': '이벤트 만료 처리', 'log-maintenance-failed': '로그 관리 처리 실패' });
const maintenanceTypes = new Set(['audit-rotated', 'events-expired', 'log-maintenance-failed']);
Object.assign(changeNames, { 'workflow-created': '워크플로우 생성', 'workflow-updated': '워크플로우 저장', 'workflow-enabled': '워크플로우 ON/OFF', 'workflow-deleted': '워크플로우 삭제', 'workflow-run-requested': '수동 실행 요청', 'workflow-rerun-requested': '다시 실행 요청', 'workflow-run-canceled': '실행 중지 요청' });
changeNames['data-restored'] = '데이터 복원';

export function createAuditUI({ api, escape, icon, generation, authenticated, active, today, dateBoundary, formatTime, dateSummary, events, openEvent }) {
  let request = 0, detailRequest = 0, filters = { kind: 'workflows', page: 1 };
  let period = DEFAULT_PERIOD;
  let filtersOpen = false, changeItems = new Map();
  let runTimer, runId = null, runActionBusy = false;
  let refreshFeedback = null;
  const runKeys = new Map();
  const kindName = kind => ({ manual: '수동', automatic: '자동', rerun: '다시 실행' })[kind] ?? kind;
  const format = value => value ? escape(formatTime(value)) : '—';
  const time = value => value ? `<time datetime="${escape(value)}">${format(value)}</time>` : '—';
  const actorName = actor => actor === 'shared-user' ? '공유 계정' : actor === 'system' ? '시스템' : actor || '서버';
  const json = value => `<pre class="audit-json">${escape(JSON.stringify(value, null, 2))}</pre>`;
  const detailDialog = document.createElement('dialog');
  detailDialog.id = 'audit-detail-dialog';
  detailDialog.className = 'dialog audit-dialog';
  detailDialog.setAttribute('aria-labelledby', 'audit-detail-title');
  document.body.append(detailDialog);
  detailDialog.addEventListener('close', () => { detailRequest++; runId = null; clearTimeout(runTimer); });

  function mount(eventId) {
    if (eventId !== undefined) { filters = { kind: 'changes', page: 1, eventId }; period = DEFAULT_PERIOD; filtersOpen = true; }
    applyPeriod();
    changeItems.clear();
    $('#main').classList.remove('workflow-main');
    $('#main').innerHTML = `<section class="audit-workspace" aria-label="감사 로그"><h1 class="visually-hidden">감사 로그</h1>
      <div class="overview"><section class="summary audit-summary" aria-label="감사 기록 요약">${dateSummary()}<div class="summary-items" data-audit-summary></div></section></div>
      <section class="workspace audit-list" aria-label="감사 기록 목록"><form id="audit-filter-form">
        <div class="toolbar audit-toolbar"><div class="filter-row audit-tabs" role="group" aria-label="감사 기록 종류">${[['workflows', '워크플로우 실행'], ['changes', '변경 기록']].map(([kind, label]) => `<button type="button" class="filter ${filters.kind === kind ? 'active' : ''}" data-audit-kind="${kind}" aria-pressed="${filters.kind === kind}">${label}</button>`).join('')}</div>
          <div class="audit-actions"><label class="audit-search">${icon('search')}<span class="visually-hidden">감사 기록 검색</span><input type="search" name="search" value="${escape(filters.search ?? '')}" maxlength="128" placeholder="이름 또는 식별자 검색"></label><button class="button primary" type="submit">조회</button><button class="button secondary" type="button" data-audit-command="filters" aria-expanded="${filtersOpen}" aria-controls="audit-filter-panel">${icon('settings')}필터<span data-audit-filter-count hidden></span></button><button class="icon-button" type="button" data-audit-command="refresh" aria-label="감사 기록 새로고침" title="새로고침">${icon('refresh')}</button></div>
        </div>
        <div class="audit-date-range">
          <div class="audit-date-fields"><label class="field">시작일<input name="fromDate" type="date" min="1900-01-01" max="9998-12-31" value="${escape(filters.fromDate ?? '')}" aria-describedby="audit-date-hint"></label><label class="field">종료일<input name="untilDate" type="date" min="1900-01-01" max="9998-12-31" value="${escape(filters.untilDate ?? '')}" aria-describedby="audit-date-hint"></label></div>
          <div class="audit-periods" role="group" aria-label="오늘 기준 조회 기간"><span>최근</span>${PERIODS.map(item => `<button type="button" class="filter${period === item.id ? ' active' : ''}" data-audit-period="${item.id}" aria-pressed="${period === item.id}">${item.label}</button>`).join('')}</div>
          <p id="audit-date-hint" class="audit-date-hint">앱 시간대 기준 · 시작일과 종료일을 포함합니다. 간편 기간은 오늘을 기준으로 바로 조회합니다.</p>
        </div>
        <div id="audit-filter-panel" class="audit-filters" ${filtersOpen ? '' : 'hidden'}><label class="field">서비스<select name="targetId"><option value="">전체 서비스</option>${filters.targetId ? `<option value="${escape(filters.targetId)}" selected>${escape(filters.targetId)}</option>` : ''}</select></label><label class="field">이벤트 ID<input name="eventId" value="${escape(filters.eventId ?? '')}" maxlength="128"></label><label class="field">워크플로우 ID<input name="workflowId" value="${escape(filters.workflowId ?? '')}" maxlength="128"></label><div class="audit-filter-actions"><button class="button secondary" type="button" data-audit-command="reset">검색 조건 초기화</button></div></div>
      </form>
      <p class="form-error" id="audit-error" role="alert" hidden></p><div id="audit-results" aria-live="polite"><div class="audit-empty">기록을 불러오고 있습니다…</div></div><div id="audit-pages" class="audit-pagination" hidden></div></section>
    </section>`;
    renderSummary();
    updateFilterCount();
    updatePeriodControls();
    updateRefreshButton();
    $('#audit-filter-form').addEventListener('input', event => {
      if (!['fromDate', 'untilDate'].includes(event.target.name)) return;
      period = null;
      updatePeriodControls();
    });
    $('#audit-filter-form').addEventListener('submit', event => {
      event.preventDefault();
      filters = { kind: filters.kind, page: 1, ...Object.fromEntries(new FormData(event.currentTarget)) };
      updateFilterCount();
      refresh();
    });
    refresh();
  }

  function applyPeriod() {
    if (period) Object.assign(filters, auditDateRange(period, today()));
  }

  function updatePeriodControls() {
    const form = $('#audit-filter-form');
    form.elements.fromDate.max = form.elements.untilDate.value || '9998-12-31';
    form.elements.untilDate.min = form.elements.fromDate.value || '1900-01-01';
    for (const button of form.querySelectorAll('[data-audit-period]')) {
      const selected = button.dataset.auditPeriod === period;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }

  function renderSummary(changes, workflows, result) {
    const cards = [
      ['total', 'shield', '전체 기록', changes === undefined ? undefined : changes + workflows, '보관 중인 전체 감사 기록'],
      ['changes', 'edit', '변경 기록', changes, '전체 변경 기록'],
      ['workflows', 'workflow', '워크플로우 실행', workflows, '워크플로우 실행 기록'],
      ['result', 'search', '조회 결과', result, '선택한 종류와 검색 조건에 맞는 전체 기록']
    ];
    $('[data-audit-summary]').innerHTML = cards.map(([kind, symbol, label, count, hint]) => `<div class="summary-card ${kind}" title="${hint}"><span class="summary-icon">${icon(symbol)}</span><span class="summary-label">${label}</span><span class="summary-value">${count ?? '—'}<small>건</small></span></div>`).join('');
  }

  function updateFilterCount() {
    const count = ['targetId', 'eventId', 'workflowId'].filter(key => filters[key]).length;
    const badge = $('[data-audit-filter-count]');
    badge.textContent = count;
    badge.hidden = count === 0;
  }

  function refreshDate() {
    const context = $('.audit-summary .summary-context');
    if (!context) return;
    const markup = dateSummary();
    if (context.outerHTML !== markup) context.outerHTML = markup;
  }

  const heading = title => `<div class="dialog-heading"><div><p class="eyebrow">AUDIT RECORD</p><h2 id="audit-detail-title">${escape(title)}</h2></div><button type="button" class="icon-button" data-close="audit-detail-dialog" aria-label="닫기"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 5 14 14M19 5 5 19"/></svg></button></div>`;
  const closeAction = () => '<div class="dialog-actions"><button class="button secondary" data-close="audit-detail-dialog">닫기</button></div>';

  function changeValues(value) {
    if (!value) return '—';
    const parts = [];
    if (value.title) parts.push(value.title);
    if (value.version !== undefined) parts.push(`버전 ${value.version}`);
    if (value.cron) parts.push(`실행 일정: ${value.cron}`);
    if (value.eventRetentionDays !== undefined) parts.push(`이벤트 데이터 보관: ${value.eventRetentionDays}일`);
    if (value.auditRetentionDays !== undefined) parts.push(`감사 로그 로테이션: ${value.auditRetentionDays}일`);
    if (value.id) parts.push(`이벤트 ${value.id}`);
    if (value.category) parts.push(`유형: ${value.category === 'incident' ? '장애' : '점검/불안정'}`);
    if (value.services) parts.push(`서비스: ${value.services.map(item => item.label ?? `${item.name ?? item.id} (${item.active ? '사용' : '사용 안 함'})`).join(', ') || '없음'}`);
    if (value.start) parts.push(`시작 ${formatTime(value.start)}`);
    if ('end' in value) parts.push(`종료 ${value.end ? formatTime(value.end) : '미정'}`);
    if (value.description) parts.push(value.description);
    return `${parts.map(escape).join('<br>')}<details><summary>저장된 상세 값</summary>${json(value)}</details>`;
  }

  function eventLink(id) {
    const event = events().find(item => item.id === id);
    return `<button class="audit-event-link" data-audit-event="${escape(id)}">${escape(event?.title ?? id)}</button>`;
  }

  function changeTarget(item) {
    if (item.type === 'log-policy-updated' || item.type === 'log-maintenance-failed') return '로그 관리 정책';
    if (maintenanceTypes.has(item.type)) return `${item.type === 'events-expired' ? '이벤트' : '감사 로그'} ${escape(item.after?.count ?? 0)}건 ${item.after?.status === 'pending' ? '정리 대상' : '삭제'}`;
    const value = item.after ?? item.before;
    if (value?.runId) return `<button class="audit-event-link" data-audit-run="${escape(value.runId)}">실행 기록</button>`;
    if (value?.workflowId) return escape(value.name ?? value.workflowId);
    if (value?.id) return `<button class="audit-event-link" data-audit-event="${escape(value.id)}">${escape(value.title || value.id)}</button>`;
    if (item.type === 'services-updated') return '서비스 제안 목록';
    return '시스템';
  }

  function renderRows(data) {
    if (!data.items.length) return `<div class="audit-empty">${icon('search')}<strong>조건에 맞는 감사 기록이 없습니다.</strong><span>기록 종류나 검색 조건을 확인해 주세요.</span><button class="button secondary" data-audit-command="reset">검색 조건 초기화</button></div>`;
    if (data.kind === 'workflows') return `<div class="audit-table" tabindex="0" role="region" aria-label="워크플로우 실행 표"><table><thead><tr><th>실행 시각</th><th>워크플로우</th><th>결과</th><th>계기</th><th>동작 시간 (sec)</th><th>상세</th></tr></thead><tbody>${data.items.map(item => `<tr><td>${time(item.createdAt)}</td><td>${escape(item.workflowName)}<small>v${item.definitionVersion}</small></td><td><span class="audit-result ${escape(item.status)}">${escape(statusNames[item.status] ?? item.status)}</span></td><td>${escape(kindName(item.kind))}</td><td>${item.durationMs === undefined ? '—' : (item.durationMs / 1000).toFixed(2)}</td><td><button class="button secondary" data-audit-run="${escape(item.id)}">실행 보기</button></td></tr>`).join('')}</tbody></table></div>`;
    const columns = ['기록 시각', '변경 내용', '대상', '작업자', '상세'];
    const rows = data.items.map(item => `<tr><td class="audit-time">${time(item.at)}</td><td><span class="audit-change-type">${icon(item.type === 'services-updated' ? 'settings' : 'edit')}<strong>${escape(changeNames[item.type] ?? item.type)}</strong></span></td><td class="audit-target">${changeTarget(item)}</td><td>${escape(actorName(item.actor))}</td><td class="audit-row-actions"><button class="button secondary" data-audit-change="${escape(item.id)}">변경 전후</button></td></tr>`).join('');
    return `<div class="audit-table" tabindex="0" role="region" aria-label="변경 기록 표"><table><thead><tr>${columns.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function updateRefreshButton() {
    const button = $('[data-audit-command="refresh"]');
    if (!button) return;
    button.disabled = refreshFeedback !== null;
    button.setAttribute('aria-busy', String(button.disabled));
    button.title = button.disabled ? '새로고침 중' : '새로고침';
  }

  async function refreshFromButton() {
    if (refreshFeedback) return;
    const feedback = refreshFeedback = {};
    updateRefreshButton();
    try {
      const cooldown = new Promise(resolve => setTimeout(resolve, REFRESH_FEEDBACK_MS));
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        feedback.animation = $('[data-audit-command="refresh"] .icon').animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
          { duration: REFRESH_FEEDBACK_MS, easing: 'ease-in-out', iterations: 1 }
        );
      }
      // Both a fast response and a finished spin must still respect the lock.
      await Promise.allSettled([refresh(), cooldown, feedback.animation?.finished]);
    } finally {
      if (refreshFeedback === feedback) { refreshFeedback = null; updateRefreshButton(); }
    }
  }

  async function refresh() {
    if (!active() || !authenticated()) return;
    const current = ++request, session = generation();
    $('#audit-error').hidden = true;
    $('#audit-results').setAttribute('aria-busy', 'true');
    try {
      applyPeriod();
      if (period) {
        const form = $('#audit-filter-form');
        form.elements.fromDate.value = filters.fromDate;
        form.elements.untilDate.value = filters.untilDate;
        updatePeriodControls();
      }
      if (filters.fromDate && filters.untilDate && filters.fromDate > filters.untilDate) throw new Error('종료일은 시작일과 같거나 이후여야 합니다.');
      const query = new URLSearchParams(Object.entries(filters).filter(([key, value]) => value !== '' && !key.endsWith('Date')));
      for (const [name, field] of [['from', 'fromDate'], ['until', 'untilDate']]) if (filters[field]) {
        if (!fromDateKey(filters[field])) throw new Error('조회 날짜를 확인해 주세요.');
        query.set(name, dateBoundary(name === 'until' ? addDays(filters[field], 1) : filters[field]));
      }
      const dataRequest = api(`/api/audit?${query}`);
      const [data, catalog] = await Promise.all([dataRequest, api('/api/services')]);
      if (current !== request || session !== generation() || !active()) return;
      const select = $('#audit-filter-form').elements.targetId;
      const selectedTarget = select.value;
      select.innerHTML = '<option value="">전체 서비스</option>' + catalog.services.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
      if (selectedTarget && !catalog.services.some(item => item.id === selectedTarget)) select.insertAdjacentHTML('beforeend', `<option value="${escape(selectedTarget)}">${escape(selectedTarget)}</option>`);
      select.value = selectedTarget;
      changeItems = new Map(data.kind === 'changes' ? data.items.map(item => [item.id, item]) : []);
      renderSummary(data.counts.changes, data.counts.workflows, data.total);
      refreshDate();
      $('#audit-results').innerHTML = renderRows(data);
      $('#audit-pages').hidden = data.pages <= 1;
      $('#audit-pages').innerHTML = `<button class="button secondary" data-audit-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>${icon('left')}이전</button><span>${data.page} / ${data.pages} 페이지</span><button class="button secondary" data-audit-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''}>다음${icon('right')}</button>`;
    } catch (failure) {
      if (current === request && session === generation() && active()) {
        $('#audit-error').textContent = failure.message; $('#audit-error').hidden = false;
        if (!$('#audit-results table')) $('#audit-results').innerHTML = '<div class="audit-empty">기록을 불러오지 못했습니다. 새로고침해 주세요.</div>';
      }
    } finally {
      if (current === request && session === generation() && active()) $('#audit-results').setAttribute('aria-busy', 'false');
    }
  }

  function showChange(id) {
    runId = null; clearTimeout(runTimer);
    const item = changeItems.get(id);
    if (!item) return;
    detailRequest++;
    if (maintenanceTypes.has(item.type)) {
      const value = item.after;
      detailDialog.innerHTML = `${heading(changeNames[item.type])}<dl class="audit-meta"><dt>기록 시각</dt><dd>${time(item.at)}</dd><dt>작업자</dt><dd>${escape(actorName(item.actor))}</dd><dt>처리 결과</dt><dd>${value.status === 'success' ? '완료' : value.status === 'pending' ? '파일 정리 중' : '실패'}</dd><dt>대상</dt><dd>${changeTarget(item)}</dd>${value.cutoff ? `<dt>삭제 기준 시각</dt><dd>${time(value.cutoff)} 이전</dd><dt>보관 기간</dt><dd>${escape(value.retentionDays)}일</dd>` : ''}<dt>실행 일정</dt><dd>${escape(value.cron ?? value.policy?.cron)} · ${escape(value.timezone)}</dd></dl>${value.error ? `<p class="form-error">${escape(value.error)}</p>` : ''}<details><summary>처리 상세 기록</summary>${json(value)}</details>${closeAction()}`;
      if (!detailDialog.open) detailDialog.showModal();
      return;
    }
    detailDialog.innerHTML = `${heading(changeNames[item.type] ?? item.type)}<dl class="audit-meta"><dt>기록 시각</dt><dd>${time(item.at)}</dd><dt>작업자</dt><dd>${escape(actorName(item.actor))}</dd><dt>대상</dt><dd>${changeTarget(item)}</dd></dl>${item.before || item.after ? `<div class="audit-change-values"><section><h3>변경 전</h3>${changeValues(item.before)}</section><section><h3>변경 후</h3>${changeValues(item.after)}</section></div>` : `<details><summary>저장된 상세 값</summary>${json(item)}</details>`}${closeAction()}`;
    if (!detailDialog.open) detailDialog.showModal();
  }

  function runGraph(run) {
    const nodes = run.definition.nodes, edges = run.definition.edges;
    const width = Math.max(600, ...nodes.map(node => node.x + 250)), height = Math.max(180, ...nodes.map(node => node.y + 120));
    const steps = new Map(run.steps.map(step => [step.nodeId, step]));
    return `<div class="audit-run-graph"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="실행 당시 노드 구성과 실행 경로">${edges.map(edge => {
      const from = nodes.find(node => node.id === edge.from), to = nodes.find(node => node.id === edge.to), followed = steps.get(from.id)?.port === edge.port && steps.has(to.id);
      return `<path class="${followed ? 'followed' : ''}" d="M${from.x + 110} ${from.y + 90} C${from.x + 110} ${from.y + 130}, ${to.x + 110} ${to.y - 40}, ${to.x + 110} ${to.y}"/>`;
    }).join('')}${nodes.map(node => `<g class="${escape(steps.get(node.id)?.status ?? 'skipped')}"><rect x="${node.x}" y="${node.y}" width="220" height="90" rx="8"/><text x="${node.x + 14}" y="${node.y + 30}">${escape(node.name.slice(0, 18))}</text><text x="${node.x + 14}" y="${node.y + 62}">${escape(statusNames[steps.get(node.id)?.status] ?? '건너뜀')}</text></g>`).join('')}</svg></div>`;
  }

  function switchResult(step, definition) {
    const node = definition.nodes.find(node => node.id === step.nodeId);
    return node?.type === 'switch' && step.port ? `<p>선택한 분기: <strong>${escape(switchLabel(node, step.port))}</strong></p>` : '';
  }

  async function showRun(id, open = true) {
    clearTimeout(runTimer); runId = id;
    const current = ++detailRequest, session = generation();
    if (open) { detailDialog.innerHTML = `${heading('워크플로우 실행')}<p>실행 기록을 불러오고 있습니다…</p>`; if (!detailDialog.open) detailDialog.showModal(); }
    try {
      const run = await api(`/api/workflow-runs/${encodeURIComponent(id)}`);
      if (current !== detailRequest || session !== generation() || !detailDialog.open || runId !== id) return;
      const live = ['queued', 'running'].includes(run.status);
      const expanded = [...detailDialog.querySelectorAll('[data-run-step][open]')].map(node => node.dataset.runStep);
      detailDialog.innerHTML = `${heading(`${run.workflowName} · v${run.definitionVersion}`)}<dl class="audit-meta"><dt>결과</dt><dd><span class="audit-result ${escape(run.status)}">${escape(statusNames[run.status])}</span></dd><dt>실행 계기</dt><dd>${escape(kindName(run.kind))}</dd><dt>접수 / 완료</dt><dd>${time(run.createdAt)} / ${time(run.finishedAt)}</dd><dt>실행 ID</dt><dd>${escape(id)}</dd>${run.message ? `<dt>종료 사유</dt><dd>${escape(run.message)}</dd>` : ''}</dl>${run.parentId ? `<button class="button secondary" data-audit-run="${escape(run.parentId)}">원래 실행 보기</button>` : ''}<h3>실행 당시 구성</h3>${runGraph(run)}<details><summary>트리거 입력</summary>${json(run.input)}</details><h3>노드별 결과</h3><div class="audit-attempts">${run.steps.map(step => `<details data-run-step="${escape(step.nodeId)}" ${expanded.includes(step.nodeId) ? 'open' : ''}><summary>${escape(step.name)} · ${escape(statusNames[step.status] ?? step.status)}</summary><p>${time(step.startedAt)} ~ ${time(step.finishedAt)}</p>${switchResult(step, run.definition)}${step.error ? `<p class="form-error">${escape(step.error)}</p>` : ''}${step.output === undefined ? '' : json(step.output)}${step.attempts.length ? `<h4>HTTP 시도 ${step.attempts.length}회</h4>${json(step.attempts)}` : ''}</details>`).join('')}</div><p class="form-error" data-run-error hidden></p><div class="dialog-actions"><button class="button secondary" data-close="audit-detail-dialog">닫기</button><div>${live ? '<button class="button danger" data-audit-run-action="cancel">실행 중지</button>' : run.canReevaluate ? '<button class="button primary" data-audit-run-action="reevaluate">현재 서비스 상태 재평가</button>' : run.canRerun ? '<button class="button primary" data-audit-run-action="rerun">같은 버전·입력으로 다시 실행</button>' : '<span class="form-hint">삭제된 워크플로우는 다시 실행할 수 없습니다.</span>'}</div></div>`;
      if (live) runTimer = setTimeout(() => { if (runId === id && detailDialog.open && authenticated() && active() && !runActionBusy) showRun(id, false); }, 1000);
    } catch (failure) {
      if (current === detailRequest && session === generation() && detailDialog.open) detailDialog.innerHTML = `${heading('워크플로우 실행')}<p class="form-error">${escape(failure.message)}</p>${closeAction()}`;
    }
  }

  async function actOnRun(action) {
    if (!runId || runActionBusy) return;
    if (action === 'reevaluate' && !confirm('현재 서비스 상태와 최신 정의로 새 실행을 접수합니다. 실제 API를 호출할 수 있습니다. 계속하시겠습니까?')) return;
    if (action === 'rerun' && !confirm('당시 구성과 입력으로 처음부터 다시 실행합니다. 앞서 성공한 API도 다시 호출할 수 있습니다. 계속하시겠습니까?')) return;
    const id = runId, session = generation(), key = `${id}:${action}`;
    if (!runKeys.has(key)) runKeys.set(key, randomUUID());
    runActionBusy = true; clearTimeout(runTimer);
    for (const button of detailDialog.querySelectorAll('[data-audit-run-action]')) button.disabled = true;
    try {
      const run = await api(`/api/workflow-runs/${id}/${action}`, { method: 'POST', body: JSON.stringify({ requestId: runKeys.get(key) }) });
      if (session !== generation() || !detailDialog.open || runId !== id) return;
      runKeys.delete(key); runActionBusy = false;
      showRun(run.id, run.id !== id); refresh();
    } catch (failure) {
      if (session === generation() && runId === id && detailDialog.open) { const error = detailDialog.querySelector('[data-run-error]'); if (error) { error.hidden = false; error.textContent = failure.message; } }
    } finally { runActionBusy = false; for (const button of detailDialog.querySelectorAll('[data-audit-run-action]')) button.disabled = false; }
  }

  document.addEventListener('click', event => {
    if (!authenticated() || !active()) return;
    const tab = event.target.closest('[data-audit-kind]');
    if (tab) {
      filters = { ...filters, kind: tab.dataset.auditKind, page: 1 }; mount();
      $(`[data-audit-kind="${filters.kind}"]`).focus({ preventScroll: true });
    }
    const shortcut = event.target.closest('[data-audit-period]');
    if (shortcut) {
      period = shortcut.dataset.auditPeriod;
      const range = auditDateRange(period, today()), form = $('#audit-filter-form');
      form.elements.fromDate.value = range.fromDate;
      form.elements.untilDate.value = range.untilDate;
      updatePeriodControls();
      form.requestSubmit();
    }
    const page = event.target.closest('[data-audit-page]');
    if (page) { filters.page = Number(page.dataset.auditPage); refresh(); }
    const run = event.target.closest('[data-audit-run]');
    if (run) showRun(run.dataset.auditRun);
    const runAction = event.target.closest('[data-audit-run-action]');
    if (runAction) actOnRun(runAction.dataset.auditRunAction);
    const change = event.target.closest('[data-audit-change]');
    if (change) showChange(change.dataset.auditChange);
    const related = event.target.closest('[data-audit-event]');
    if (related) { detailDialog.close(); openEvent(related.dataset.auditEvent); }
    const command = event.target.closest('[data-audit-command]')?.dataset.auditCommand;
    if (command === 'refresh') void refreshFromButton();
    if (command === 'filters') {
      filtersOpen = !filtersOpen;
      $('#audit-filter-panel').hidden = !filtersOpen;
      $('[data-audit-command="filters"]').setAttribute('aria-expanded', String(filtersOpen));
    }
    if (command === 'reset') { filters = { kind: filters.kind, page: 1 }; period = DEFAULT_PERIOD; mount(); $('#audit-filter-form').elements.search.focus({ preventScroll: true }); }
  });

  function clear() {
    request++; detailRequest++;
    refreshFeedback?.animation?.cancel();
    refreshFeedback = null;
    filters = { kind: 'workflows', page: 1 };
    period = DEFAULT_PERIOD;
    filtersOpen = false; changeItems.clear();
    runId = null; runActionBusy = false; runKeys.clear(); clearTimeout(runTimer);
    detailDialog.close(); detailDialog.replaceChildren();
  }
  return { mount, refresh, refreshDate, clear, openWorkflow(id, selectedRun) { filters = { kind: 'workflows', workflowId: id, page: 1 }; period = DEFAULT_PERIOD; filtersOpen = true; mount(); if (selectedRun) showRun(selectedRun); } };
}
