#!/usr/bin/env node
/**
 * Enable .githooks when cloning/installing locally.
 * No-op in Docker / CI images without git (npm ci must not fail).
 */
import { execFileSync } from 'node:child_process';

function hasGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasGitRepo()) {
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // Read-only .git or missing git binary — ignore.
}
