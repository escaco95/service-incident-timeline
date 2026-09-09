export function createLogPolicyUI({ api, generation, authenticated, onSavingChange, toast, formatTime }) {
  const $ = selector => document.querySelector(selector);
  const form = $('#log-policy-form');
  let request = 0, policy = null, saving = false;
  const error = message => { $('#log-policy-error').textContent = message; $('#log-policy-error').hidden = !message; };
  function render(data) {
    policy = data.policy;
    for (const key of ['cron', 'eventRetentionDays', 'auditRetentionDays']) form.elements[key].value = policy[key];
    $('#log-policy-timezone').textContent = `실행 시간대: ${data.timezone} · 시스템 설정의 시간대를 따릅니다.`;
    const run = data.lastRun;
    $('#log-policy-status').textContent = run ? `${formatTime(run.at)} · ${run.status === 'success' ? `완료: 이벤트 ${run.expiredEvents}건 만료, 감사 로그 ${Object.values(run.rotatedAudit).reduce((sum, count) => sum + count, 0)}건 삭제` : run.status === 'pending' ? '파일 정리 중' : '처리 실패: 감사 로그에서 상세 내용을 확인하세요.'}` : '아직 실행 기록이 없습니다.';
    error(data.fault ?? '');
  }
  async function loadSettings() {
    if (saving) return;
    const current = ++request, session = generation();
    policy = null; error('');
    $('#log-policy-fields').disabled = true;
    $('#log-policy-save').disabled = true;
    $('#log-policy-loading').hidden = false;
    try {
      const data = await api('/api/settings/log-policy');
      if (current !== request || session !== generation() || !$('#branding-dialog').open) return;
      render(data);
      $('#log-policy-fields').disabled = false;
      $('#log-policy-save').disabled = false;
    } catch (failure) {
      if (current === request && session === generation()) error(failure.message);
    } finally { if (current === request) $('#log-policy-loading').hidden = true; }
  }
  $('#log-policy-reload').addEventListener('click', loadSettings);
  $('#branding-dialog').addEventListener('close', () => { request++; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !policy || !authenticated() || !form.reportValidity()) return;
    const session = generation();
    const next = { version: policy.version, cron: form.elements.cron.value.trim(), eventRetentionDays: Number(form.elements.eventRetentionDays.value), auditRetentionDays: Number(form.elements.auditRetentionDays.value) };
    saving = true; onSavingChange(true); error('');
    $('#log-policy-fields').disabled = true;
    $('#log-policy-save').disabled = true;
    $('#log-policy-reload').disabled = true;
    try {
      const data = await api('/api/settings/log-policy', { method: 'PUT', body: JSON.stringify({ policy: next }) });
      if (session !== generation()) return;
      render(data); toast('로그 관리 정책을 저장했습니다.');
    } catch (failure) {
      if (session === generation()) error(failure.message);
    } finally {
      saving = false; onSavingChange(false);
      $('#log-policy-fields').disabled = !authenticated() || !policy;
      $('#log-policy-save').disabled = !authenticated() || !policy;
      $('#log-policy-reload').disabled = false;
    }
  });
  function clear() {
    request++; policy = null; form.reset(); error('');
    $('#log-policy-timezone').textContent = '';
    $('#log-policy-status').textContent = '';
    $('#log-policy-loading').hidden = true;
    $('#log-policy-fields').disabled = true;
    $('#log-policy-save').disabled = true;
  }
  return { loadSettings, clear };
}
