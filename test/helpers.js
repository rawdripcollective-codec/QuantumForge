'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempCwd(fn) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantumforge-test-'));
  process.chdir(tempDir);
  const cleanup = () => {
    if (process.cwd() === tempDir) {
      process.chdir(originalCwd);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    const result = fn(tempDir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function freshRequire(moduleId, extraModuleIds = []) {
  for (const id of [...extraModuleIds, moduleId]) {
    delete require.cache[require.resolve(id)];
  }
  return require(moduleId);
}

function stubModule(moduleId, exports) {
  const resolved = require.resolve(moduleId);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };

  return () => {
    if (previous) {
      require.cache[resolved] = previous;
    } else {
      delete require.cache[resolved];
    }
  };
}

module.exports = { withTempCwd, freshRequire, stubModule };
