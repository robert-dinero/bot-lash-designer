Set-Location 'C:\Users\shoot\Documents\bot_IA_wpp_definitive'
$output = node node_modules\.bin\vitest run 2>&1
$output | Out-File -FilePath 'test_output.txt' -Encoding utf8
$exitCode = $LASTEXITCODE
Write-Host "Exit code: $exitCode"
Get-Content 'test_output.txt'
