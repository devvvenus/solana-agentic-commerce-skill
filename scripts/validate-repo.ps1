$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$required = @(
  "SKILL.md",
  "README.md",
  "LICENSE",
  "package.json",
  ".gitignore",
  ".github/workflows/verify.yml",
  "references/pay-kit-overview.md",
  "references/payment-protocols.md",
  "references/security-checklist.md",
  "workflows/add-paywall-to-api.md",
  "workflows/agent-paid-tool-call.md",
  "workflows/metered-session.md",
  "templates/express-paid-middleware.ts",
  "templates/nextjs-paid-route.ts",
  "examples/express-paid-api/package.json",
  "examples/express-paid-api/.env.example",
  "examples/express-paid-api/src/server.ts",
  "examples/express-paid-api/src/payments.ts",
  "examples/express-paid-api/test/payment-contract.test.ts",
  "examples/express-paid-api/test/onchain-payment.e2e.test.ts"
)
foreach ($file in $required) {
  $path = Join-Path $root $file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing required file: $file"
  }
}
$blockedTerms = @(
  ("mo" + "ck"),
  ("fa" + "ke"),
  ("place" + "holder"),
  ("premium content" + " goes here"),
  ("un" + "verified"),
  ("not" + "_configured"),
  ("TO" + "DO"),
  ("T" + "BD")
)
$forbidden = [string]::Join("|", ($blockedTerms | ForEach-Object { [regex]::Escape($_) }))
$matches = Get-ChildItem -LiteralPath $root -Recurse -File |
  Where-Object { $_.FullName -notmatch "\\.git\\|node_modules|package-lock\.json$" } |
  Select-String -Pattern $forbidden -CaseSensitive:$false
if ($matches) {
  $matches | ForEach-Object { Write-Error ("Blocked term in {0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.Trim()) }
  throw "Blocked terms found"
}
$readme = Get-Content -LiteralPath (Join-Path $root "README.md") -Raw
foreach ($needle in @("@solana/mpp", "Mppx", "solana", "402 Payment Required", "fail closed")) {
  if ($readme -notmatch [regex]::Escape($needle)) { throw "README missing: $needle" }
}
Write-Output "Repo validation passed"

