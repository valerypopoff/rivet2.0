param([Parameter(Mandatory=$true)][string]$GcloudPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
if (-not [IO.File]::Exists($GcloudPath)) { throw 'Reviewed Cloud SDK launcher is unavailable' }
$env:CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK='true'
$version = & $GcloudPath version --format=json --quiet
if ($LASTEXITCODE -ne 0) { throw 'Cloud SDK local version check failed' }
$null = ($version -join "`n") | ConvertFrom-Json
$bytes = [Text.Encoding]::UTF8.GetBytes('Synthetic Rivet deployment readiness; no production keys')
$entropy = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($entropy)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $verified = [Security.Cryptography.ProtectedData]::Unprotect($protected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  if ([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($verified)) { throw 'Local key recovery failed' }
  Write-Output '{"localOnly":true,"keyProtection":true,"cloudSdk":true}'
} finally {
  $rng.Dispose()
  [Array]::Clear($bytes,0,$bytes.Length)
  [Array]::Clear($entropy,0,$entropy.Length)
  if ($verified) { [Array]::Clear($verified,0,$verified.Length) }
}
