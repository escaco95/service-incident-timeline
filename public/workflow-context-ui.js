import { CONTEXT_LIMITS, validateContextEntries } from './workflow-spec.js';

export function createContextEditor({ escape }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'workflow-context-dialog';
  dialog.className = 'dialog wf-context-dialog';
  dialog.setAttribute('aria-labelledby', 'wf-context-title');
  document.body.append(dialog);
  let apply;
  const rows = () => dialog.querySelector('[data-context-rows]');
  function addRow(entry = { key: '', value: '' }) {
    const row = document.createElement('div');
    row.className = 'wf-context-row';
    row.innerHTML = `<label class="field">키<input data-context-key required maxlength="${CONTEXT_LIMITS.key}" value="${escape(entry.key)}" placeholder="예: token" autocomplete="off" spellcheck="false"></label><label class="field">값<textarea data-context-value rows="2" maxlength="${CONTEXT_LIMITS.value}" spellcheck="false">${escape(entry.value)}</textarea></label><button type="button" class="wf-text-button" data-context-remove aria-label="키·값 삭제">삭제</button>`;
    rows().append(row);
    dialog.querySelector('[data-context-add]').disabled = rows().children.length >= CONTEXT_LIMITS.entries;
    return row;
  }
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-context-close]')) dialog.close();
    if (event.target.closest('[data-context-add]') && rows().children.length < CONTEXT_LIMITS.entries) addRow().querySelector('input').focus();
    const remove = event.target.closest('[data-context-remove]');
    if (remove) {
      const row = remove.closest('.wf-context-row'), next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      const add = dialog.querySelector('[data-context-add]'); add.disabled = false;
      (next?.querySelector('input') ?? add).focus();
    }
  });
  dialog.addEventListener('input', () => { dialog.querySelector('[data-context-error]').hidden = true; });
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const entries = validateContextEntries([...rows().children].map(row => ({ key: row.querySelector('input').value, value: row.querySelector('textarea').value })));
      apply(entries);
      dialog.close();
    } catch (error) {
      const message = dialog.querySelector('[data-context-error]'); message.textContent = error.message; message.hidden = false;
    }
  });
  dialog.addEventListener('close', () => { if (!dialog.open) { apply = null; dialog.replaceChildren(); } });
  return {
    open(node, onApply) {
      apply = onApply;
      dialog.innerHTML = `<form><div class="dialog-heading"><h2 id="wf-context-title">컨텍스트 값 주입</h2><button type="button" class="icon-button" data-context-close aria-label="닫기">×</button></div><p class="wf-context-name">${escape(node.name)}</p><p class="form-hint">입력한 문자열은 이 노드가 실행된 뒤 <code>{{context.token}}</code>처럼 사용합니다. 같은 키를 다시 주입하면 새 값으로 바뀝니다.</p><p class="form-hint">키는 영문자로 시작하는 영문·숫자·밑줄·하이픈을 사용합니다.</p><div class="wf-context-rows" data-context-rows></div><button type="button" class="button secondary" data-context-add>키·값 추가</button><p class="form-hint">최대 50개 · 키 64자 · 값 4,000자. 값은 워크플로우 설정과 JSON 다운로드에 포함됩니다.</p><p class="form-error" data-context-error role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary" data-context-close>취소</button><button type="submit" class="button primary">적용</button></div></form>`;
      for (const entry of node.config.entries?.length ? node.config.entries : [{ key: '', value: '' }]) addRow(entry);
      dialog.showModal();
      rows().querySelector('input').focus();
    },
    close() { dialog.close(); apply = null; dialog.replaceChildren(); }
  };
}
