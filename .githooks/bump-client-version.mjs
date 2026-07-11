#!/usr/bin/env node
/**
 * Bump client/package.json patch (x.y.Z → x.y.Z+1).
 * Prints the new version to stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'client', 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

const parts = String(pkg.version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
while (parts.length < 3) parts.push(0);
parts[2] += 1;
pkg.version = parts.join('.');

const indent = raw.match(/^(\s*)"name"/m)?.[1]?.includes('\t') ? '\t' : '  ';
const ending = raw.endsWith('\n') ? '\n' : '';
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}${ending}`);
process.stdout.write(pkg.version);
