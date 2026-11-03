export const NEW_PASSWORD_LIMITS = Object.freeze({ min: 15, max: 256 });
export const NEW_PASSWORD_HINT = '새 비밀번호는 공백 없는 영문·숫자·특수문자(ASCII) 15~256자로 입력해 주세요.';
export const validNewPassword = value => typeof value === 'string' && value.length >= NEW_PASSWORD_LIMITS.min && value.length <= NEW_PASSWORD_LIMITS.max && !/[^!-~]/.test(value);
