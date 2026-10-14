<#
.SYNOPSIS
  Deletes everything deploy.ps1 created, including the stored broadcasts and the sign-in app registration.
.EXAMPLE
  ./deploy/destroy.ps1          # shows the plan and asks first
.EXAMPLE
  ./deploy/destroy.ps1 -Force   # no question
#>
param([switch]$Force)
$ErrorActionPreference = "Stop"

function Invoke-Native {
    & $args[0] $args[1..($args.Count - 1)]
    if ($LASTEXITCODE -ne 0) { throw "Failed ($LASTEXITCODE): $($args -join ' ')" }
}

function Test-SignedIn {
    # Windows PowerShell turns a native command's redirected stderr into an error under "Stop".
    $ErrorActionPreference = "Continue"
    az account show --output none 2>$null
    $LASTEXITCODE -eq 0
}

$terraform = Join-Path $PSScriptRoot "terraform"
foreach ($tool in "az", "terraform") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed." }
}

if (-not (Test-SignedIn)) { Invoke-Native az login --output none }
$env:ARM_SUBSCRIPTION_ID = (az account show --query id --output tsv)

Invoke-Native terraform "-chdir=$terraform" init -input=false
if ($Force) {
    Invoke-Native terraform "-chdir=$terraform" destroy -input=false -auto-approve
} else {
    Invoke-Native terraform "-chdir=$terraform" destroy -input=false
}
