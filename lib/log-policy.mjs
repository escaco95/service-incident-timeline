import { AppError } from './errors.mjs';
import { parseCron } from './workflow-definition.mjs';

export const DEFAULT_LOG_POLICY = Object.freeze({ version: 1, cron: '0 3 * * *', eventRetentionDays: 1825, auditRetentionDays: 90 });

export function validateLogPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, '로그 관리 정책을 확인해 주세요.');
  if (!Number.isSafeInteger(input.eventRetentionDays) || input.eventRetentionDays < 30 || input.eventRetentionDays > 3650) throw new AppError(400, '이벤트 데이터 보관 기간은 30~3650일의 정수로 입력해 주세요.');
  if (!Number.isSafeInteger(input.auditRetentionDays) || input.auditRetentionDays < 7 || input.auditRetentionDays > 180) throw new AppError(400, '감사 로그 로테이션 기간은 7~180일의 정수로 입력해 주세요.');
  parseCron(input.cron);
  return { cron: input.cron.trim().replace(/\s+/g, ' '), eventRetentionDays: input.eventRetentionDays, auditRetentionDays: input.auditRetentionDays };
}

export function validateStoredLogPolicy(state) {
  if (state.logPolicy !== undefined) {
    validateLogPolicy(state.logPolicy);
    if (!Number.isSafeInteger(state.logPolicy.version) || state.logPolicy.version < 1) throw new Error('Invalid log policy version');
  }
}
