import fs from 'node:fs/promises';
import { importWorkflow, exportWorkflow } from '../lib/workflow-file.mjs';
import { LIMITS } from '../public/workflow-spec.js';
try {
  const args = process.argv.slice(2), file = args.find(arg => !arg.startsWith('--'));
  if (!file || args.some(arg => arg.startsWith('--') && !['--draft', '--normalize'].includes(arg))) throw Error('사용법: node scripts/workflow-validate.mjs 파일.json [--draft] [--normalize]');
  if ((await fs.stat(file)).size > LIMITS.bytes) throw Error('파일은 1MiB까지 지원합니다.');
  const result = importWorkflow(JSON.parse(await fs.readFile(file, 'utf8')), { executable: !args.includes('--draft') });
  console.log(JSON.stringify(args.includes('--normalize') ? exportWorkflow(result.definition) : { ok: true, nodes: result.definition.nodes.length, ...result, definition: undefined }, null, 2));
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
