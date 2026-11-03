import * as fs from 'node:fs/promises';
import { checkPassword } from './vault.mjs';

export async function readUnlockPassword(args) {
  if (!args.length) return undefined;
  const separator = args[0].indexOf('='), option = separator < 0 ? args[0] : args[0].slice(0, separator);
  let password = separator < 0 ? args[1] : args[0].slice(separator + 1);
  const options = ['--unlock-password', '--unlock-password-file'];
  if (!options.includes(option) || args.length !== (separator < 0 ? 2 : 1) || !password || separator < 0 && options.includes(password)) throw new Error('시작 옵션은 --unlock-password 값 또는 --unlock-password-file 경로 중 하나만 지정해 주세요. 옵션과 같은 모양의 값은 --unlock-password=값 형식으로 전달해 주세요.');
  if (option === '--unlock-password-file') {
    let file, bytes;
    try {
      const stat = await fs.stat(password);
      if (!stat.isFile() || stat.size > 1026 || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error();
      file = await fs.open(password, 'r');
      bytes = await file.readFile();
      password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, '');
      if (/^[\uFEFF]|[\r\n\0]/.test(password)) throw new Error();
    } catch { throw new Error('시작 암호 파일을 읽지 못했습니다. 파일·권한과 한 줄 UTF-8 형식을 확인해 주세요.'); }
    finally { bytes?.fill(0); await file?.close(); }
  }
  checkPassword(password);
  return password;
}
