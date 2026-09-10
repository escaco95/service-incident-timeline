import { randomUUID } from './random-id.js';
const TARGETS = {
  audit: { name: '감사 로그 초기화', description: '모든 변경 기록과 워크플로우 실행 이력을 삭제합니다. 대기·실행 중인 워크플로우도 중지합니다. 이벤트와 워크플로우 구성은 유지합니다.' },
  events: { name: '이벤트 초기화', description: '종료 미정·예정 이벤트를 포함한 모든 이벤트를 삭제합니다. 서비스 제안 목록, 워크플로우와 기존 감사 기록은 유지합니다. 이미 접수한 실행은 당시 입력으로 계속 진행합니다.' },
  workflows: { name: '워크플로우 초기화', description: '모든 워크플로우 구성과 비밀 변수를 삭제하고 대기·실행 중인 작업을 중지합니다. 이벤트와 기존 실행 이력은 유지합니다.' },
  system: { name: '시스템 초기화', description: '이벤트, 서비스 제안 목록, 워크플로우, 비밀 변수, 감사 로그, 시스템 설정과 비밀번호를 모두 초기화합니다. 모든 실행과 로그인 세션을 종료하고 새 비밀번호 설정 화면으로 돌아갑니다.' }
};

export function createDangerZoneUI({ api, generation, authenticated, onSavingChange, onReset, toast }) {
  const $ = selector => document.querySelector(selector);
  const summaries = { audit: '변경 기록과 워크플로우 실행 이력을 삭제합니다.', events: '등록된 모든 이벤트를 삭제합니다.', workflows: '모든 워크플로우 구성과 비밀 변수를 삭제합니다.', system: '모든 데이터와 설정을 초기화하고 새 비밀번호를 설정합니다.' };
  $('#danger-zone-actions').innerHTML = Object.entries(TARGETS).map(([target, item]) => `<section class="danger-row"><div><h4>${item.name}</h4><p>${summaries[target]}</p></div><button class="button danger" type="button" data-reset-target="${target}">${item.name}</button></section>`).join('');
  const confirmDialog = document.createElement('dialog'), passwordDialog = document.createElement('dialog');
  confirmDialog.id = 'reset-confirm-dialog'; confirmDialog.className = 'dialog reset-dialog'; confirmDialog.setAttribute('aria-labelledby', 'reset-confirm-title'); confirmDialog.setAttribute('aria-describedby', 'reset-confirm-description');
  confirmDialog.innerHTML = '<div class="dialog-heading"><h2 id="reset-confirm-title"></h2></div><p id="reset-confirm-description" class="reset-description"></p><p class="form-hint">이 작업은 되돌릴 수 없습니다. 확인 후 비밀번호를 한 번 더 입력합니다.</p><div class="dialog-actions"><button type="button" class="button secondary" data-reset-cancel autofocus>취소</button><button type="button" class="button danger" data-reset-confirm>확인</button></div>';
  passwordDialog.id = 'reset-password-dialog'; passwordDialog.className = 'dialog reset-dialog'; passwordDialog.setAttribute('aria-labelledby', 'reset-password-title');
  passwordDialog.innerHTML = '<form id="reset-password-form"><div class="dialog-heading"><h2 id="reset-password-title">비밀번호 확인</h2></div><p id="reset-password-description" class="reset-description"></p><label class="field">현재 비밀번호<input type="password" name="password" required minlength="12" maxlength="256" autocomplete="current-password" aria-describedby="reset-password-description" autofocus></label><p class="form-error" id="reset-password-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary" data-reset-cancel>취소</button><button type="submit" class="button danger" id="reset-submit">초기화</button></div></form>';
  document.body.append(confirmDialog, passwordDialog);
  const form = $('#reset-password-form');
  let selected = null, phase = null, saving = false;
  const error = text => { $('#reset-password-error').textContent = text; $('#reset-password-error').hidden = !text; };
  const restoreFocus = target => $(target === 'restore' ? '#data-restore' : `[data-reset-target="${target}"]`)?.focus();
  $('#danger-zone-actions').addEventListener('click', event => {
    const button = event.target.closest('[data-reset-target]');
    if (!button || saving || !authenticated()) return;
    selected = { target: button.dataset.resetTarget, requestId: randomUUID(), session: generation() }; phase = 'confirm';
    const item = TARGETS[selected.target];
    $('#reset-confirm-title').textContent = item.name;
    $('#reset-confirm-description').textContent = item.description;
    confirmDialog.showModal();
  });
  confirmDialog.querySelector('[data-reset-confirm]').addEventListener('click', () => {
    if (!selected || !authenticated() || selected.session !== generation()) return;
    phase = 'password'; confirmDialog.close(); form.reset(); error('');
    $('#reset-password-description').textContent = `${selected.target === 'restore' ? '데이터 복원' : TARGETS[selected.target].name}를 진행하려면 현재 로그인 비밀번호를 입력해 주세요.`;
    $('#reset-submit').textContent = selected.target === 'restore' ? '데이터 복원' : TARGETS[selected.target].name;
    passwordDialog.showModal(); form.elements.password.focus();
  });
  for (const dialog of [confirmDialog, passwordDialog]) {
    dialog.querySelector('[data-reset-cancel]').addEventListener('click', () => { if (!saving) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (confirmDialog.open || passwordDialog.open) return;
      if (dialog === confirmDialog && phase === 'password') return;
      const target = selected?.target;
      selected = null; phase = null; form.reset(); error('');
      if (target && authenticated()) restoreFocus(target);
    });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!selected || phase !== 'password' || saving || !authenticated() || !form.reportValidity()) return;
    const choice = selected, body = { target: choice.target, requestId: choice.requestId, confirmed: true, password: form.elements.password.value };
    saving = true; onSavingChange(true); error('');
    for (const control of form.elements) control.disabled = true;
    $('#reset-submit').textContent = choice.target === 'restore' ? '복원을 요청하고 있습니다…' : '초기화하고 있습니다…'; form.setAttribute('aria-busy', 'true');
    try {
      const result = await api(choice.target === 'restore' ? `/api/settings/transfers/${choice.archive.id}/restore` : '/api/settings/reset', { method: 'POST', body: JSON.stringify(body) });
      if (choice.session !== generation()) return;
      selected = null; phase = null; passwordDialog.close();
      if (choice.target === 'restore') { choice.onStarted(result); return; }
      await onReset(result);
      toast(result.cleanupPending ? '데이터를 초기화했습니다. 일부 이전 파일은 아직 정리하지 못했습니다.' : choice.target === 'system' ? '시스템을 초기화했습니다. 새 비밀번호를 설정해 주세요.' : `${TARGETS[choice.target].name}를 완료했습니다.`, !!result.cleanupPending);
    } catch (failure) {
      if (choice.session === generation() && passwordDialog.open) { error(failure.message); form.elements.password.value = ''; }
    } finally {
      body.password = null; saving = false; onSavingChange(false);
      for (const control of form.elements) control.disabled = false;
      form.removeAttribute('aria-busy'); $('#reset-submit').textContent = selected?.target === 'restore' ? '데이터 복원' : selected ? TARGETS[selected.target].name : '초기화';
      if (passwordDialog.open) form.elements.password.focus();
    }
  });
  return {
    restore(archive, onStarted) {
      if (saving || !authenticated()) return;
      selected = { target: 'restore', archive, onStarted, requestId: randomUUID(), session: generation() }; phase = 'confirm';
      $('#reset-confirm-title').textContent = '데이터 복원';
      $('#reset-confirm-description').textContent = `${archive.name}의 데이터로 현재 이벤트, 서비스, 워크플로우, 감사 로그와 설정을 모두 교체합니다. 현재 비밀번호는 유지합니다. 실행 중 작업을 중지하며 백업의 미완료 실행은 자동 재개하지 않습니다.`;
      confirmDialog.showModal();
    },
    clear() { selected = null; phase = null; confirmDialog.close(); passwordDialog.close(); form.reset(); error(''); }
  };
}
