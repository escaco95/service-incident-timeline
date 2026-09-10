export function createWorkflowDiagnostics({ api, escape, current, selected, selectNode, centerNode, changed, layout, svg }) {
  let host, controller, timer, revision = 0, key = null, result = null, pending = false, failure = '', collapsed = false;
  const query = selector => host?.querySelector(selector);
  const rows = () => (result?.issues ?? []).flatMap(issue => (issue.nodeIds.length ? issue.nodeIds : [null]).map(nodeId => ({ ...issue, nodeId })));

  function syncNodes() {
    if (!host) return;
    const messages = new Map();
    for (const issue of result?.issues ?? []) for (const id of issue.nodeIds) {
      if (!messages.has(id)) messages.set(id, []);
      messages.get(id).push(issue.message);
    }
    for (const element of host.querySelectorAll('.wf-node')) {
      const errors = messages.get(element.dataset.nodeId), button = element.querySelector('[data-wf-select]');
      element.classList.toggle('has-error', !!errors);
      if (errors) button.setAttribute('aria-description', '오류: ' + errors.join(' '));
      else button.removeAttribute('aria-description');
    }
    for (const button of host.querySelectorAll('[data-wf-diagnostic-node]')) button.setAttribute('aria-pressed', String(button.dataset.wfDiagnosticNode === selected()));
  }

  function render() {
    const panel = query('.wf-diagnostics');
    if (!panel) return;
    const items = rows();
    panel.hidden = !failure && !items.length;
    query('[data-wf-diagnostics-status]').textContent = pending ? '진단 중…' : failure ? '진단 확인 필요' : `오류 ${result?.issues.length ?? 0}건`;
    query('[data-wf-diagnostics-toggle]').setAttribute('aria-expanded', String(!collapsed));
    query('[data-wf-diagnostics-toggle]').title = collapsed ? '오류 진단 펼치기' : '오류 진단 접기';
    query('[data-wf-diagnostics-body]').hidden = collapsed;
    query('[data-wf-diagnostics-notice]').textContent = failure || (pending ? '현재 구성을 확인하고 있습니다.' : result?.saveAllowed ? '저장할 수 있지만, 오류를 해결해야 실행할 수 있습니다.' : result?.issues.some(issue => issue.code === 'definition') ? '구성 오류를 해결한 뒤 저장·실행해 주세요.' : '자동 실행이 ON입니다. 오류를 해결하거나 OFF로 전환한 뒤 저장해 주세요.');
    query('[data-wf-diagnostics-retry]').hidden = !failure;
    query('[data-wf-diagnostics-list]').innerHTML = items.map(({ message, nodeId }) => {
      const node = current().nodes.find(node => node.id === nodeId);
      const text = `${svg('failure')}<span><strong>${escape(node?.name ?? '워크플로우 전체')}</strong><span>${escape(message)}</span></span>${node ? svg('fit') : ''}`;
      return `<li>${node ? `<button type="button" class="wf-diagnostic-item" data-wf-diagnostic-node="${escape(node.id)}" title="클릭: 노드 선택 · 더블 클릭: 화면 중앙으로 이동" aria-keyshortcuts="Alt+Enter">${text}</button>` : `<div class="wf-diagnostic-item">${text}</div>`}</li>`;
    }).join('');
    syncNodes(); layout();
  }

  function update() {
    if (!host || !current()) return;
    const flow = current();
    // Camera and node position changes do not change execution diagnostics.
    const next = JSON.stringify({ id: flow.id, version: flow.version, name: flow.name, nodes: flow.nodes.map(({ x, y, ...node }) => node), edges: flow.edges, secrets: flow.secretEdits });
    if (next === key) { syncNodes(); return; }
    key = next; pending = true; failure = '';
    const request = ++revision, signal = controller.signal;
    const body = JSON.stringify({ name: flow.name, nodes: flow.nodes, edges: flow.edges, secrets: JSON.parse(flow.secretEdits || '{}') });
    clearTimeout(timer);
    render();
    timer = setTimeout(async () => {
      try {
        const data = await api(`/api/workflows/${flow.id}/diagnostics`, { method: 'POST', body, signal });
        if (signal.aborted || request !== revision) return;
        if (data.issues.some(issue => !result?.issues.some(old => JSON.stringify(old) === JSON.stringify(issue)))) collapsed = false;
        result = data;
      } catch (error) {
        if (signal.aborted || request !== revision) return;
        failure = `오류 진단을 불러오지 못했습니다. ${error.message}`;
      }
      pending = false; render(); changed();
    }, 180);
  }

  function close() {
    clearTimeout(timer); controller?.abort(); revision++;
    host = null; key = null; result = null; pending = false; failure = ''; collapsed = false;
  }

  return {
    update, close, blocked: () => pending || !!failure || !result?.executable,
    mount(element) {
      close(); host = element; controller = new AbortController();
      query('.wf-editor').insertAdjacentHTML('beforeend', `<section class="wf-diagnostics" aria-label="오류 진단" hidden><button type="button" class="wf-diagnostics-heading" data-wf-diagnostics-toggle aria-controls="wf-diagnostics-body" aria-expanded="true"><span>${svg('failure')} 오류 진단</span><span data-wf-diagnostics-status role="status" aria-live="polite"></span><span class="wf-diagnostics-chevron" aria-hidden="true">⌄</span></button><div id="wf-diagnostics-body" class="wf-diagnostics-body" data-wf-diagnostics-body><p data-wf-diagnostics-notice></p><p class="wf-diagnostics-hint">클릭: 노드 선택 · 더블 클릭 / Alt+Enter: 중앙 이동</p><button type="button" class="wf-text-button" data-wf-diagnostics-retry hidden>다시 진단</button><ul data-wf-diagnostics-list aria-label="실행을 막는 오류 목록"></ul></div></section>`);
      const panel = query('.wf-diagnostics');
      panel.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        event.stopPropagation();
        if (button.hasAttribute('data-wf-diagnostics-toggle')) { collapsed = !collapsed; render(); }
        else if (button.hasAttribute('data-wf-diagnostics-retry')) { key = null; update(); changed(); }
        else if (button.dataset.wfDiagnosticNode) selectNode(button.dataset.wfDiagnosticNode);
      }, { signal: controller.signal });
      const focus = event => {
        const button = event.target.closest('[data-wf-diagnostic-node]');
        if (!button) return;
        event.preventDefault(); event.stopPropagation();
        selectNode(button.dataset.wfDiagnosticNode); centerNode(button.dataset.wfDiagnosticNode);
      };
      panel.addEventListener('dblclick', focus, { signal: controller.signal });
      panel.addEventListener('keydown', event => { if (event.altKey && event.key === 'Enter') focus(event); }, { signal: controller.signal });
    }
  };
}
