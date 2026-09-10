import { randomUUID } from './random-id.js';
import { SWITCH_LIMITS, validateSwitchCases, validPath } from './workflow-spec.js';

export function createSwitchEditor({ escape }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'workflow-switch-dialog'; dialog.className = 'dialog wf-switch-dialog';
  dialog.setAttribute('aria-labelledby', 'wf-switch-title'); document.body.append(dialog);
  let apply;
  const query = selector => dialog.querySelector(selector);
  const rows = () => query('[data-switch-rows]');
  function valueControl(row, value = '') {
    const type = row.querySelector('[data-switch-type]').value;
    const holder = row.querySelector('[data-switch-value-holder]');
    holder.innerHTML = type === 'boolean' ? `<select data-switch-value aria-label="분기 값"><option value="true" ${value !== false ? 'selected' : ''}>true</option><option value="false" ${value === false ? 'selected' : ''}>false</option></select>` : type === 'null' ? '<span class="wf-switch-null">null</span>' : `<input data-switch-value aria-label="분기 값" type="${type === 'number' ? 'number' : 'text'}" ${type === 'number' ? 'required step="any"' : `maxlength="${SWITCH_LIMITS.value}"`} value="${escape(type === 'number' ? typeof value === 'number' ? String(value) : '' : value === null ? '' : String(value))}" autocomplete="off" spellcheck="false" placeholder="${type === 'number' ? '예: 200' : '예: A (빈 문자열도 가능)'}">`;
  }
  function addRow(entry = { id:`case-${randomUUID()}`, value:'' }) {
    const row = document.createElement('div'), type = entry.value === null ? 'null' : typeof entry.value;
    row.className = 'wf-switch-row'; row.dataset.caseId = entry.id;
    row.innerHTML = `<label class="field">자료형<select data-switch-type>${[['string','문자열'],['number','숫자'],['boolean','참/거짓'],['null','null']].map(([value,label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field">일치할 값<span data-switch-value-holder></span></label><button type="button" class="wf-text-button" data-switch-remove aria-label="분기 삭제">삭제</button>`;
    rows().append(row); valueControl(row, entry.value);
    query('[data-switch-add]').disabled = rows().children.length >= SWITCH_LIMITS.cases;
    return row;
  }
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-switch-close]')) dialog.close();
    if (event.target.closest('[data-switch-add]') && rows().children.length < SWITCH_LIMITS.cases) addRow().querySelector('[data-switch-value]').focus();
    const remove = event.target.closest('[data-switch-remove]');
    if (remove) {
      const row = remove.closest('.wf-switch-row'), next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove(); query('[data-switch-add]').disabled = false;
      (next?.querySelector('select') ?? query('[data-switch-add]')).focus();
    }
  });
  dialog.addEventListener('input', () => { query('[data-switch-error]').hidden = true; });
  dialog.addEventListener('change', event => {
    if (event.target.matches('[data-switch-type]')) valueControl(event.target.closest('.wf-switch-row'));
  });
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const field = query('[data-switch-field]').value;
      if (!validPath(field)) throw new Error('비교할 값의 경로를 입력해 주세요. 예: trigger.service, response.status, context.environment');
      const cases = validateSwitchCases([...rows().children].map(row => {
        const type = row.querySelector('[data-switch-type]').value, raw = row.querySelector('[data-switch-value]')?.value;
        if (type === 'number' && !raw?.trim()) throw new Error('숫자 분기 값을 입력해 주세요.');
        return { id:row.dataset.caseId, value:type === 'null' ? null : type === 'boolean' ? raw === 'true' : type === 'number' ? Number(raw) : raw };
      }));
      apply({ field, cases }); dialog.close();
    } catch (error) { const message = query('[data-switch-error]'); message.textContent = error.message; message.hidden = false; }
  });
  dialog.addEventListener('close', () => { if (!dialog.open) { apply = null; dialog.replaceChildren(); } });
  return {
    open(node, onApply) {
      apply = onApply;
      dialog.innerHTML = `<form><div class="dialog-heading"><h2 id="wf-switch-title">switch 분기 설정</h2><button type="button" class="icon-button" data-switch-close aria-label="닫기">×</button></div><p class="wf-context-name">${escape(node.name)}</p><label class="field">비교할 값의 경로<input data-switch-field required maxlength="200" value="${escape(node.config.field)}" placeholder="예: trigger.service" autocomplete="off" spellcheck="false"></label><p class="form-hint">자료형과 값이 모두 같은 한 경로로 진행합니다. 문자열 “200”과 숫자 200은 서로 다릅니다.</p><div class="wf-switch-rows" data-switch-rows></div><button type="button" class="button secondary" data-switch-add>분기 추가</button><p class="wf-note"><strong>기본 경로</strong> · 일치하는 값이 없거나 값이 누락되면 기본 연결로 진행합니다. null은 별도 분기 값으로 지정할 수 있습니다.</p><p class="form-hint">최대 20개 분기와 기본 경로를 지원합니다. 템플릿처럼 보이는 문자열도 그대로 비교합니다. 분기를 삭제하면 해당 연결도 적용 시 삭제됩니다. 연결되지 않은 출력은 그 지점에서 실행을 마칩니다.</p><p class="form-error" data-switch-error role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary" data-switch-close>취소</button><button type="submit" class="button primary">적용</button></div></form>`;
      for (const entry of node.config.cases) addRow(entry);
      dialog.showModal(); query('[data-switch-field]').focus();
    },
    close() { dialog.close(); apply = null; dialog.replaceChildren(); }
  };
}
