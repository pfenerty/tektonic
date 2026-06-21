import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bash } from './bash';
import { Nushell } from './nushell';
import { Python } from './python';
import { EXIT_CODE_PATH } from './types';
import type { ScriptLanguage } from './types';

/**
 * Pattern for unit-testing a script in isolation: render a body through its
 * language wrapper, execute it with the real interpreter, and assert both the
 * process exit code and the captured exit-code contract file. Each case is
 * skipped when its interpreter is unavailable so the suite stays hermetic.
 */
const has = (bin: string): boolean => {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return !r.error;
};

/** Runs a captured wrapper and returns the process exit code + contract value. */
function runWrapped(lang: ScriptLanguage, interp: string, ext: string, body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tek-rt-'));
  const ecPath = path.join(dir, 'exit-code');
  const file = path.join(dir, `step.${ext}`);
  // Render against a writable contract path inside the temp dir.
  fs.writeFileSync(file, lang.wrap(body, { exitCodePath: ecPath, captureExitCode: true }));
  const r = spawnSync(interp, [file], { encoding: 'utf8' });
  const contract = fs.existsSync(ecPath) ? fs.readFileSync(ecPath, 'utf8').trim() : '<none>';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, contract };
}

describe('script runtime contract', () => {
  it.skipIf(!has('bash'))('bash captures a failing exit code', () => {
    const r = runWrapped(new Bash(), 'bash', 'bash', 'echo hi\nexit 3');
    expect(r.status).toBe(3);
    expect(r.contract).toBe('3');
  });

  it.skipIf(!has('nu'))('nushell maps a raised error to exit code 1', () => {
    const r = runWrapped(new Nushell(), 'nu', 'nu', 'print hi\nerror make {msg: "boom"}');
    expect(r.status).toBe(1);
    expect(r.contract).toBe('1');
  });

  it.skipIf(!has('python3'))('python captures sys.exit', () => {
    const r = runWrapped(new Python(), 'python3', 'py', 'log("hi")\nsys.exit(3)');
    expect(r.status).toBe(3);
    expect(r.contract).toBe('3');
  });

  it('uses the canonical contract path constant', () => {
    expect(EXIT_CODE_PATH).toBe('/tekton/home/.exit-code');
  });
});
