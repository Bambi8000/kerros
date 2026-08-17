#!/usr/bin/env node
/**
 * check-version.mjs
 *
 * The version constant lives in exactly one place, src/version.ts, and
 * package.json must agree with it. Run this before every push. Muusia taught
 * that a version that drifts is a version nobody trusts in a bug report.
 *
 *   node tools/check-version.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const source = readFileSync(join(root, 'src/version.ts'), 'utf8');
const match = source.match(/KERROS_VERSION\s*=\s*['"]([^'"]+)['"]/);

if (!match) {
  console.error('FAIL  no KERROS_VERSION found in src/version.ts');
  process.exit(1);
}

const constant = match[1];
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (pkg.version !== constant) {
  console.error(`FAIL  package.json ${pkg.version} != src/version.ts ${constant}`);
  console.error(`      fix with: npm pkg set version=${constant}`);
  process.exit(1);
}

console.log(`OK    version ${constant} matches in package.json and src/version.ts`);
