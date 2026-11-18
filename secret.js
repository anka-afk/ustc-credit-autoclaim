'use strict';
// Windows DPAPI 加解密(当前用户作用域),密码不以明文落盘
const { spawn } = require('child_process');

function dpapi(op, b64) {
  return new Promise((resolve, reject) => {
    const script =
      `Add-Type -AssemblyName System.Security; ` +
      `$b = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
      `try { $r = [System.Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser') } catch { exit 1 }; ` +
      `[Console]::Out.Write([Convert]::ToBase64String($r))`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`DPAPI ${op} 失败(exit=${code}): ${err.trim()}`));
    });
    p.stdin.write(b64);
    p.stdin.end();
  });
}

const protect = (plain) => dpapi('Protect', Buffer.from(plain, 'utf8').toString('base64'));
const unprotect = (b64) =>
  dpapi('Unprotect', b64).then((out) => Buffer.from(out, 'base64').toString('utf8'));

module.exports = { protect, unprotect };