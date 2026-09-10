import { randomUUID } from './random-id.js';
import { LIMITS } from './workflow-spec.js';

export function createWorkflowFiles({ api, escape, generation, active, current, imported, toast }) {
  const dialog = document.createElement('dialog'); dialog.className = 'dialog'; dialog.id = 'workflow-file-dialog'; document.body.append(dialog);
  const error = message => { const target = dialog.querySelector('[data-file-error]'); if (target) { target.hidden = false; target.textContent = message; } };
  async function upload() {
    const session = generation(), flow = current(), requestId = randomUUID(); let parsed, revision = 0;
    dialog.innerHTML = `<form><div class="dialog-heading"><h2>워크플로우 JSON 가져오기</h2><button type="button" data-close="workflow-file-dialog" class="button secondary">닫기</button></div><label class="field">JSON 파일 · 최대 1MiB<input type="file" accept=".json,application/json" data-workflow-file required></label><label class="field">적용 대상<select name="destination"><option value="new">새 OFF 초안</option>${flow ? '<option value="current">현재 편집 초안에 적용</option>' : ''}</select></label><p data-file-summary>파일을 선택하면 실행 없이 검증합니다.</p><div data-file-preview></div><p class="form-error" data-file-error hidden></p><div class="dialog-actions"><button type="submit" class="button primary" disabled>검토한 정의 가져오기</button></div></form>`;
    dialog.showModal();
    const form = dialog.querySelector('form'), button = form.querySelector('[type=submit]');
    form.querySelector('input').addEventListener('change', async event => {
      const token = ++revision; parsed = null; button.disabled = true;
      dialog.querySelector('[data-file-error]').hidden = true;
      try {
        const file = event.target.files[0]; if (!file) return;
        if (file.size > LIMITS.bytes) throw Error('파일은 1MiB까지 지원합니다.');
        const input = JSON.parse(await file.text());
        const result = await api('/api/workflows/validate', { method: 'POST', body: JSON.stringify(input) });
        if (session !== generation() || token !== revision || !dialog.open || !active()) return;
        parsed = result.definition;
        dialog.querySelector('[data-file-summary]').textContent = `${parsed.name} · ${parsed.nodes.length}개 노드 · ${parsed.edges.length}개 연결 · ${result.executable ? '구성 검증 통과' : '실행 전 수정 필요: ' + result.executableError} · 필요한 비밀 변수: ${result.requiredSecrets.join(', ') || '없음'}`;
        dialog.querySelector('[data-file-preview]').innerHTML = `${flow ? `<details><summary>현재 편집 정의</summary><pre>${escape(JSON.stringify({ name: flow.name, nodes: flow.nodes, edges: flow.edges }, null, 2))}</pre></details>` : ''}<details open><summary>가져올 정의</summary><pre>${escape(JSON.stringify(parsed, null, 2))}</pre></details>`;
        button.disabled = false;
      } catch (failure) { if (session === generation() && token === revision && dialog.open) error(failure.message); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!parsed || button.disabled) return; button.disabled = true;
      try {
        const destination = form.elements.destination.value;
        let created;
        if (destination === 'new') created = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ ...parsed, requestId }) });
        if (session !== generation() || !active() || !dialog.open) return;
        if (destination === 'current' && current()?.id !== flow.id) throw Error('편집 대상이 바뀌었습니다. 파일을 다시 가져와 주세요.');
        imported(created ?? parsed, destination === 'new'); dialog.close(); toast(destination === 'new' ? 'OFF 초안을 생성했습니다.' : '편집 초안에 적용했습니다. 저장으로 반영하세요.');
      } catch (failure) { if (session === generation() && dialog.open) error(failure.message); }
      finally { button.disabled = false; }
    });
  }
  async function download() {
    const flow = current(), session = generation();
    const file = await api(`/api/workflows/${flow.id}/export`);
    if (session !== generation() || !active()) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `workflow-${flow.id}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('저장된 정의를 다운로드했습니다. 컨텍스트 주입 값이 포함됩니다.');
  }
  async function services() {
    const session = generation(), data = await api('/api/workflow-services');
    if (session !== generation() || !active()) return;
    dialog.innerHTML = `<div class="dialog-heading"><h2>서비스 계산 상태와 보류</h2><button class="button secondary" data-close="workflow-file-dialog">닫기</button></div><p>계산 상태는 외부 시스템의 실제 상태와 다를 수 있습니다. 보류 해소 후 워크플로우에서 현재 상태를 수동 평가하세요.</p><p class="form-error" data-file-error hidden></p>${data.services.map((item, index) => `<div class="wf-service-row"><strong>${escape(item.service)}</strong> · ${escape(({ incident: '적색', warning: '황색', '': '정상' })[item.severity])}${item.hold ? `<p>확인 필요 · 실행 ${escape(item.hold.runId)}</p><button class="button secondary" data-resolve-service="${index}">확인 후 보류 해소</button>` : ' · 보류 없음'}</div>`).join('') || '<p>아직 수립된 서비스 상태가 없습니다.</p>'}`;
    if (!dialog.open) dialog.showModal();
    for (const button of dialog.querySelectorAll('[data-resolve-service]')) {
      const requestId = randomUUID();
      button.addEventListener('click', async () => {
      const item = data.services[Number(button.dataset.resolveService)];
      if (!confirm('이전 요청의 실제 적용 결과와 처리가 완전히 끝났음을 외부 시스템에서 확인했습니까? 현재 상태가 같다는 사실만으로는 충분하지 않습니다. 확인한 경우 보류를 해소하고 감사 기록을 남깁니다.')) return;
      button.disabled = true;
      try { await api('/api/workflow-services/resolve', { method: 'POST', body: JSON.stringify({ service: item.service, runId: item.hold.runId, requestId, confirmed: true, previousRequestFinished: true }) }); if (session === generation() && dialog.open && active()) await services(); }
      catch (failure) { if (session === generation() && dialog.open) error(failure.message); }
      finally { button.disabled = false; }
      });
    }
  }
  return { upload, download, services, close: () => dialog.close() };
}
