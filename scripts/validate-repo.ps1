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
  "examples/express-paid-api/src/catalog.ts",
  "examples/express-paid-api/src/commerce-service.ts",
  "examples/express-paid-api/src/commerce-store.ts",
  "examples/express-paid-api/src/rpc.ts",
  "examples/express-paid-api/src/server.ts",
  "examples/express-paid-api/src/payments.ts",
  "examples/express-paid-api/test/commerce-routes.test.ts",
  "examples/express-paid-api/test/commerce-store.test.ts",
  "examples/express-paid-api/test/commerce-service.test.ts",
  "examples/express-paid-api/test/payment-contract.test.ts",
  "examples/express-paid-api/test/onchain-payment.e2e.test.ts",
  "examples/express-paid-api/test/payment-security.e2e.test.ts",
  "examples/express-paid-api/test/support/surfpool.ts"
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
$trackedFiles = git -C $root ls-files
$matches = $trackedFiles |
  Where-Object { $_ -notmatch "package-lock\.json$" } |
  ForEach-Object {
    $path = Join-Path $root $_
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Select-String -LiteralPath $path -Pattern $forbidden -CaseSensitive:$false
    }
  }
if ($matches) {
  $matches | ForEach-Object { Write-Error ("Blocked term in {0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.Trim()) }
  throw "Blocked terms found"
}
$readme = Get-Content -LiteralPath (Join-Path $root "README.md") -Raw
foreach ($needle in @("@solana/mpp", "Mppx", "solana", "402 Payment Required", "fail closed")) {
  if ($readme -notmatch [regex]::Escape($needle)) { throw "README missing: $needle" }
}
foreach ($needle in @("Capability matrix", "| Endpoint | Asset | Implementation file | Test evidence |", "Judge / Reviewer Quickstart", "npm run verify", "npm run example:e2e")) {
  if ($readme -notmatch [regex]::Escape($needle)) { throw "README missing capability evidence: $needle" }
}
Write-Output "Repo validation passed"
