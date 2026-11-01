param([Parameter(Mandatory = $true)][string]$FilePath)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
$subject = 'CN=UnlikeOtherAI s.r.o., O=UnlikeOtherAI s.r.o., L=Mnichovice, S=Central Bohemia, C=CZ'
if (-not $env:WINDOWS_SIGNER_EKU) { throw 'WINDOWS_SIGNER_EKU is required.' }
$ekus = @($signature.SignerCertificate.Extensions |
  Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
  ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $subject -or
    -not $signature.TimeStamperCertificate -or $env:WINDOWS_SIGNER_EKU -notin $ekus) {
  throw "Invalid UnlikeOtherAI signature or timestamp on $FilePath"
}
$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse -File |
  Where-Object { $_.FullName -match '[\\/]x64[\\/]' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signTool) { throw 'x64 Windows SDK SignTool is required.' }
& $signTool.FullName verify /pa /all /tw $FilePath
if ($LASTEXITCODE -ne 0) { throw "SignTool verification failed: $FilePath" }
