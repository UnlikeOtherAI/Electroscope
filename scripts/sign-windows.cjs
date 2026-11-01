const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async ({ path, hash }) => {
  if (process.platform !== 'win32' || hash !== 'sha256') throw new Error('Windows releases require SHA-256 Artifact Signing.');
  execFileSync('pwsh.exe', ['-NoProfile', '-File', join(__dirname, 'sign-windows-artifact.ps1'), '-FilePath', path], { stdio: 'inherit' });
  execFileSync('pwsh.exe', ['-NoProfile', '-File', join(__dirname, 'verify-windows-signature.ps1'), '-FilePath', path], { stdio: 'inherit' });
};
