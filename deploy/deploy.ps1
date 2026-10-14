<#
.SYNOPSIS
  Deploys Kickstream to Azure: infrastructure with Terraform, the image built in Azure Container Registry.
.EXAMPLE
  ./deploy/deploy.ps1
.EXAMPLE
  ./deploy/deploy.ps1 -LocalBuild   # build with Docker on this machine instead of in the registry
#>
param(
    [string]$Tag = (Get-Date -Format "yyyyMMdd-HHmmss"),
    [switch]$LocalBuild
)
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

$root = Split-Path -Parent $PSScriptRoot
$terraform = Join-Path $PSScriptRoot "terraform"
$tools = @("az", "terraform") + $(if ($LocalBuild) { @("docker") } else { @() })
foreach ($tool in $tools) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed." }
}

if (-not (Test-SignedIn)) { Invoke-Native az login --output none }
$env:ARM_SUBSCRIPTION_ID = (az account show --query id --output tsv)
Write-Host "Deploying to subscription $(az account show --query name --output tsv)"

Invoke-Native terraform "-chdir=$terraform" init -input=false
# The registry first: the app cannot start until its image is in it.
Invoke-Native terraform "-chdir=$terraform" apply -input=false -auto-approve "-target=azurerm_container_registry.main"
$registry = (terraform "-chdir=$terraform" output -raw registry_name)
$image = "kickstream:$Tag"

if ($LocalBuild) {
    $server = (az acr show --name $registry --query loginServer --output tsv)
    Invoke-Native az acr login --name $registry
    Invoke-Native docker build --file "$root/deploy/docker/Dockerfile" --tag "$server/$image" $root
    Invoke-Native docker push "$server/$image"
} else {
    Invoke-Native az acr build --registry $registry --image $image --file "$root/deploy/docker/Dockerfile" $root
}

Invoke-Native terraform "-chdir=$terraform" apply -input=false -auto-approve "-var=image_tag=$Tag"
Write-Host ""
Write-Host "Kickstream is at $(terraform "-chdir=$terraform" output -raw url)"
