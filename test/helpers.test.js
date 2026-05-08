'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withTempCwd } = require('../support/helpers');

test('withTempCwd restores the original cwd after entering a nested temp directory', () => {
  const originalCwd = process.cwd();
  let nestedDir;

  withTempCwd((tempDir) => {
    nestedDir = path.join(tempDir, 'nested');
    fs.mkdirSync(nestedDir, { recursive: true });
    process.chdir(nestedDir);
  });

  assert.equal(process.cwd(), originalCwd);
  assert.equal(fs.existsSync(nestedDir), false);
});
