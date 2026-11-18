$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) {
  Copy-Item (Join-Path $root 'config.example.json') $cfgPath
}
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host '=== Qoder 额度自动领取 · 账号设置 ==='
Write-Host '密码将用 Windows DPAPI 加密保存(仅本机当前用户可解密),不会明文落盘。'
Write-Host ''

$prompt = if ($cfg.username) { "学工号/GID [当前: $($cfg.username)]" } else { '学工号/GID' }
$username = Read-Host $prompt
if (-not $username) { $username = $cfg.username }
if (-not $username) { Write-Host '未提供学工号,退出。'; exit 1 }

$sec1 = Read-Host '统一身份认证密码' -AsSecureString
$sec2 = Read-Host '再输入一次确认' -AsSecureString

Add-Type -AssemblyName System.Security
function Get-Plain([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$p1 = Get-Plain $sec1
$p2 = Get-Plain $sec2
if (-not $p1) { Write-Host '密码为空,退出。'; exit 1 }
if ($p1 -ne $p2) { Write-Host '两次输入不一致,退出。'; exit 1 }

$enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($p1), $null, 'CurrentUser')
$dec = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
if ([Text.Encoding]::UTF8.GetString($dec) -ne $p1) { Write-Host 'DPAPI 加解密自检失败,退出。'; exit 1 }

[IO.File]::WriteAllText((Join-Path $root 'secret.dat'), [Convert]::ToBase64String($enc))
$cfg.username = $username
$utf8NoBom = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 10), $utf8NoBom)

Write-Host ''
Write-Host "已保存账号 $username,密码加密自检通过。现在可以运行「2-启动监控.bat」。"