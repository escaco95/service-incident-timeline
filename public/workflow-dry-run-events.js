import { eventDryRunValues } from './workflow-dry-run-spec.js';

export function createDryRunEvents({ api, escape, formatTime, dialog, valid, apply }) {
  const labels = (event, node) => [...new Set((event?.services ?? []).map(item => item.label).filter(label => label && (!node.config.service || node.config.service === label)))];
  const severityName = value => ({ '': '정상', warning: '주의', incident: '장애' })[value] ?? value;
  const state = (item, id) => {
    item.eventPages ??= new Map();
    if (!item.eventPages.has(id)) {
      let saved;
      try { saved = JSON.parse(item.setup.nodes[id].scenario); } catch {}
      item.eventPages.set(id, { selected: '', request: 0, occurrence: saved?.occurrence ?? 'start', service: saved?.service ?? '' });
    }
    return item.eventPages.get(id);
  };
  const holder = id => dialog.querySelector(`[data-dry-node="${CSS.escape(id)}"] [data-dry-event-picker]`);
  function markup(node, values) {
    const serviceState = node.type === 'service-state', occurrence = node.type === 'end' ? '종료' : '시작';
    let saved = '';
    try { const event = JSON.parse(values.event); if (/^[a-f0-9-]{36}$/i.test(event.id)) saved = `저장된 초기값: ${event.title || event.id}`; } catch {}
    if (serviceState) { try { const source = JSON.parse(values.scenario); saved = `저장된 재현: ${source.eventTitle} · ${source.occurrence === 'end' ? '종료' : '시작'} · ${source.service} · ${severityName(source.previous)} → ${severityName(source.severity)}${source.changed ? '' : ' (상태 변화 없음)'}`; } catch {} }
    const hint = serviceState ? '일정과 시작·종료 시점을 선택하면 같은 시각에 겹치는 일정까지 계산해 서비스 상태를 채웁니다. 적용 후 직접 수정할 수 있으며 다음 테스트에도 보존됩니다.' : `선택한 일정의 정보와 ${occurrence} 시각을 아래 초기값·테스트 기준 시각에 적용합니다. 적용 후 직접 수정할 수 있으며 다음 테스트에도 보존됩니다.`;
    return `<details class="wf-dry-source" data-dry-event-picker><summary data-dry-event-open>${serviceState ? '등록 일정으로 서비스 상태 변경 재현' : `등록 일정에서 ${occurrence} 상황 불러오기`}</summary><p class="form-hint">${hint}</p>${serviceState ? '<p class="form-hint">현재 등록된 일정으로 시점 전후를 계산합니다. 실행 세대(generation)는 현재 저장된 세대에 모의 상태 변경을 반영한 값입니다.</p>' : ''}<div data-dry-event-list></div>${serviceState ? '<div data-dry-service-options></div>' : ''}<div class="wf-dry-source-actions"><button type="button" class="button secondary" data-dry-events="load">일정 목록 불러오기</button><button type="button" class="button secondary" data-dry-events="previous" hidden>이전</button><span data-dry-event-page-label></span><button type="button" class="button secondary" data-dry-events="next" hidden>다음</button><button type="button" class="button secondary" data-dry-events="apply" hidden>${serviceState ? '서비스 상태 계산·적용' : `일정 ${occurrence} 상황 적용`}</button></div><p class="form-hint" data-dry-event-state role="status">${escape(saved)}</p></details>`;
  }
  function serviceOptions(item, node, entry) {
    if (node.type !== 'service-state') return;
    const event = entry.data?.events.find(event => event.id === entry.selected), services = labels(event, node);
    if (event && !services.includes(entry.service)) entry.service = services[0] ?? '';
    if (event && !event.end) entry.occurrence = 'start';
    holder(node.id).querySelector('[data-dry-service-options]').innerHTML = `<div class="wf-dry-http-fields"><label class="field">재현 시점<select data-dry-occurrence><option value="start" ${entry.occurrence === 'start' ? 'selected' : ''}>일정 시작</option><option value="end" ${entry.occurrence === 'end' ? 'selected' : ''} ${!event?.end ? 'disabled' : ''}>일정 종료${event && !event.end ? ' (종료 미정)' : ''}</option></select></label><label class="field">대상 서비스<select data-dry-service>${services.length ? services.map(service => `<option value="${escape(service)}" ${entry.service === service ? 'selected' : ''}>${escape(service)}</option>`).join('') : '<option value="">서비스가 포함된 일정 선택</option>'}</select></label></div>`;
  }
  function refresh(item) {
    for (const [id, entry] of item.eventPages ?? []) {
      const element = holder(id); if (!element) continue;
      const busy = item.running || item.closing || entry.loading || entry.applying, data = entry.data;
      const node = item.definition.nodes.find(node => node.id === id);
      for (const select of element.querySelectorAll('select')) select.disabled = busy || (!select.matches('[data-dry-event-select]') && !entry.selected);
      for (const button of element.querySelectorAll('[data-dry-events]')) {
        const action = button.dataset.dryEvents;
        button.hidden = action !== 'load' && !data;
        button.disabled = busy || (action === 'previous' && (!data || data.page <= 1)) || (action === 'next' && (!data || data.page >= data.pages)) || (action === 'apply' && (!entry.selected || node.type === 'service-state' && !entry.service));
      }
      element.querySelector('[data-dry-events=load]').textContent = entry.loading ? '불러오는 중…' : data ? '목록 새로고침' : '일정 목록 불러오기';
      element.querySelector('[data-dry-event-page-label]').textContent = data ? `${data.page} / ${data.pages} 페이지 · ${data.total}건` : '';
      const message = element.querySelector('[data-dry-event-state]');
      if (entry.message !== undefined) message.textContent = entry.message;
      message.classList.toggle('form-error', Boolean(entry.error));
    }
  }
  async function load(item, node, page = 1) {
    const entry = state(item, node.id);
    if (entry.loading || entry.applying) return;
    const token = ++entry.request;
    entry.loading = true; entry.error = false; entry.message = '등록된 일정을 불러오고 있습니다.'; refresh(item);
    try {
      let data;
      try { data = await api(`/api/events?limit=50&page=${page}${page !== 1 && entry.data ? `&revision=${entry.data.revision}` : ''}`); }
      catch (error) { if (error.status !== 409) throw error; data = await api('/api/events?limit=50&page=1'); }
      if (!valid(item) || token !== entry.request) return;
      entry.data = data; entry.selected = '';
      holder(node.id).querySelector('[data-dry-event-list]').innerHTML = `<label class="field">등록 일정<select data-dry-event-select><option value="">일정을 선택해 주세요</option>${data.events.map(event => `<option value="${escape(event.id)}" ${node.type === 'end' && !event.end || node.type === 'service-state' && !labels(event, node).length ? 'disabled' : ''}>${escape(event.title)} · 시작 ${escape(formatTime(event.start))} · ${event.end ? `종료 ${escape(formatTime(event.end))}` : '종료 미정'}${node.type === 'service-state' && !labels(event, node).length ? ' · 대상 서비스 없음' : ''}</option>`).join('')}</select></label>`;
      serviceOptions(item, node, entry);
      entry.message = !data.total ? '등록된 일정이 없습니다. 아래에 초기값을 직접 입력할 수 있습니다.' : node.type === 'service-state' ? '대상 서비스가 포함된 일정과 시작·종료 시점을 선택해 주세요.' : node.type === 'end' ? '종료 시각이 지정된 일정을 선택해 주세요.' : '일정을 선택하고 시작 상황을 적용해 주세요.';
    } catch (error) { if (valid(item)) { entry.error = true; entry.message = error.message; } }
    finally { entry.loading = false; if (valid(item)) refresh(item); }
  }
  async function useEvent(item, node) {
    const entry = state(item, node.id);
    if (!entry.selected || entry.loading || entry.applying) return;
    const revision = item.revision;
    entry.applying = true; entry.error = false; entry.message = '선택한 일정의 최신 정보를 불러오고 있습니다.'; refresh(item);
    try {
      let values, message;
      if (node.type === 'service-state') {
        values = await api(`/api/workflows/${item.id}/dry-run-service-event`, { method: 'POST', body: JSON.stringify({ eventId: entry.selected, occurrence: entry.occurrence, service: entry.service }) });
        const source = JSON.parse(values.values.scenario), trigger = JSON.parse(values.values.trigger);
        message = `${source.eventTitle} · ${source.occurrence === 'end' ? '종료' : '시작'} ${formatTime(values.now)} · ${source.service}: ${severityName(trigger.previous)} → ${severityName(trigger.severity)} · 관련 일정 ${trigger.events.length}건. ${source.changed ? '트리거 초기값에 적용했습니다.' : '상태 변화가 없어 자동 실행은 발생하지 않으며 Dry-Run 후속 단계도 생략합니다.'}`;
      } else {
        const { event } = await api(`/api/events/${encodeURIComponent(entry.selected)}`);
        values = eventDryRunValues(node, event);
        message = `${event.title} · ${node.type === 'end' ? '종료' : '시작'} ${formatTime(event[node.type])} 적용됨. 아래에서 직접 수정할 수 있습니다.`;
      }
      if (!valid(item) || item.running || item.closing) return;
      if (revision !== item.revision) throw new Error('불러오는 동안 입력값이 변경되었습니다. 일정을 적용하려면 다시 눌러 주세요.');
      apply(item, node, values);
      entry.message = message;
    } catch (error) { if (valid(item)) { entry.error = true; entry.message = error.message; } }
    finally { entry.applying = false; if (valid(item)) refresh(item); }
  }
  return { markup, refresh,
    manual(item, id) {
      const entry = state(item, id); entry.message = '직접 수정한 트리거 초기값으로 테스트합니다. 일정 재현을 다시 적용하면 상태를 재계산합니다.'; entry.error = false; refresh(item);
    },
    click(item, target) {
      if (!item || item.running || item.closing) return;
      const button = target.closest('[data-dry-events], [data-dry-event-open]'); if (!button) return;
      const node = item.definition.nodes.find(node => node.id === button.closest('[data-dry-node]').dataset.dryNode);
      const entry = state(item, node.id), action = button.dataset.dryEvents;
      if (entry.loading || entry.applying) return;
      if (!action) { if (!entry.data && !button.closest('details').open) load(item, node); }
      else if (action === 'apply') useEvent(item, node);
      else load(item, node, action === 'previous' ? entry.data.page - 1 : action === 'next' ? entry.data.page + 1 : 1);
    },
    change(item, target) {
      if (!item || !target.matches('[data-dry-event-select], [data-dry-occurrence], [data-dry-service]')) return;
      const id = target.closest('[data-dry-node]').dataset.dryNode, entry = state(item, id), node = item.definition.nodes.find(node => node.id === id);
      if (target.matches('[data-dry-event-select]')) { entry.selected = target.value; serviceOptions(item, node, entry); }
      else if (target.matches('[data-dry-occurrence]')) entry.occurrence = target.value;
      else entry.service = target.value;
      refresh(item);
    }
  };
}
