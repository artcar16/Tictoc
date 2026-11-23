// Entry point for `node --test tests/unit/` (the command in the spec).
// Node 22 does not expand a directory given to --test: it runs it as a module, which resolves to
// this file. It loads every *.test.mjs of this folder, so both commands run the same suite:
//   node --test tests/unit/        and        npm test  (node --test "tests/unit/*.test.mjs")
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
for (const name of readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(`${dir}/${name}`).href);
}
