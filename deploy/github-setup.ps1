<#
.SYNOPSIS
  One-time setup for deploying from GitHub: an Entra app that GitHub Actions signs in as (no secret, through
  OIDC), a storage account for Terraform's state, and the repository variables the Deploy workflow reads.
  Safe to run again: whatever already exists is reused.
.EXAMPLE
  ./deploy/github-setup.ps1
.EXAMPLE
  ./deploy/github-setup.ps1 -Location westeurope
#>
param(
    [string]$Location = "centralindia",
    [string]$StateResourceGroup = "kickstream-tfstate"
)
$ErrorActionPreference = "Stop"

function Invoke-Native {
    & $args[0] $args[1..($args.Count - 1)]
    if ($LASTEXITCODE -ne 0) { throw "Failed ($LASTEXITCODE): $($args -join ' ')" }
}

function Get-Quiet {
    # Windows PowerShell turns a native command's redirected stderr into an error under "Stop".
    $ErrorActionPreference = "Continue"
    $out = & $args[0] $args[1..($args.Count - 1)] 2>$null
    if ($LASTEXITCODE -eq 0) { $out } else { $null }
}

foreach ($tool in @("az", "gh")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed." }
}
if (-not (Get-Quiet az account show --output none)) { Invoke-Native az login --output none }
Invoke-Native gh auth status

$subscription = (az account show --query id --output tsv)
$tenant = (az account show --query tenantId --output tsv)
$repo = (gh repo view --json nameWithOwner --jq .nameWithOwner)
$me = (az ad signed-in-user show --query id --output tsv)
Write-Host "Subscription $(az account show --query name --output tsv), repository $repo"

# Terraform's state: a private storage account read and written with Entra ID, not keys.
Invoke-Native az group create --name $StateResourceGroup --location $Location --output none
$account = Get-Quiet gh variable get TFSTATE_STORAGE_ACCOUNT
if (-not $account) { $account = "kickstreamtf" + -join ((48..57) + (97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ }) }
if (-not (Get-Quiet az storage account show --name $account --resource-group $StateResourceGroup --output none)) {
    Invoke-Native az storage account create --name $account --resource-group $StateResourceGroup --location $Location `
        --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false `
        --allow-shared-key-access false --output none
}
$accountId = (az storage account show --name $account --resource-group $StateResourceGroup --query id --output tsv)

# The identity GitHub Actions signs in as, trusted only for this repository's production environment.
$name = "kickstream-github-deploy"
$appId = (az ad app list --display-name $name --query "[0].appId" --output tsv)
if (-not $appId) { $appId = (az ad app create --display-name $name --query appId --output tsv) }
$spId = (Get-Quiet az ad sp show --id $appId --query id --output tsv)
if (-not $spId) { $spId = (az ad sp create --id $appId --query id --output tsv) }
$subject = "repo:${repo}:environment:production"
$existing = (az ad app federated-credential list --id $appId --query "[?subject=='$subject'] | length(@)" --output tsv)
if ($existing -eq "0") {
    $credential = @{ name = "github-production"; issuer = "https://token.actions.githubusercontent.com"; subject = $subject; audiences = @("api://AzureADTokenExchange") } | ConvertTo-Json -Compress
    $file = New-TemporaryFile
    Set-Content -Path $file -Value $credential -Encoding ascii
    Invoke-Native az ad app federated-credential create --id $appId --parameters "@$file" --output none
    Remove-Item $file
}

# Terraform creates resources and role assignments, so Owner; the state needs blob data access too.
foreach ($grant in @(@("Owner", "/subscriptions/$subscription"), @("Storage Blob Data Contributor", $accountId))) {
    if (-not (az role assignment list --assignee $spId --role $grant[0] --scope $grant[1] --query "[0].id" --output tsv)) {
        Invoke-Native az role assignment create --assignee-object-id $spId --assignee-principal-type ServicePrincipal `
            --role $grant[0] --scope $grant[1] --output none
    }
}
if (-not (Get-Quiet az storage container-rm show --name tfstate --storage-account $account --resource-group $StateResourceGroup --output none)) {
    Invoke-Native az storage container-rm create --name tfstate --storage-account $account --resource-group $StateResourceGroup --output none
}

# auth.tf registers the studio's sign-in app and assigns its users, which needs these Microsoft Graph permissions.
$graph = "00000003-0000-0000-c000-000000000000"
Invoke-Native az ad app permission add --id $appId --api $graph --api-permissions `
    "18a4783c-866b-4cc7-a460-3d5e5662c884=Role" "06b708a9-e830-4db3-a914-8e69da51d44f=Role" --output none
if (-not (Get-Quiet az ad app permission admin-consent --id $appId)) {
    Write-Warning "Admin consent could not be granted. Ask a Global Administrator to grant it for '$name' (Microsoft Graph: Application.ReadWrite.OwnedBy and AppRoleAssignment.ReadWrite.All) in Entra ID > App registrations > API permissions."
}

$ErrorActionPreference = "Continue"
gh api --method PUT "repos/$repo/environments/production" --silent
$variables = [ordered]@{
    AZURE_CLIENT_ID         = $appId
    AZURE_TENANT_ID         = $tenant
    AZURE_SUBSCRIPTION_ID   = $subscription
    TFSTATE_RESOURCE_GROUP  = $StateResourceGroup
    TFSTATE_STORAGE_ACCOUNT = $account
}
if (-not (Get-Quiet gh variable get STUDIO_USERS)) { $variables.STUDIO_USERS = $me }
foreach ($entry in $variables.GetEnumerator()) { gh variable set $entry.Key --body $entry.Value }

Write-Host ""
Write-Host "GitHub can now deploy. Every push to main deploys once CI passes; to deploy now:"
Write-Host "  gh workflow run deploy.yml"
Write-Host "Optional settings (repository variables): FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_DEPLOYMENT, FOUNDRY_RESOURCE_ID,"
Write-Host "AZURE_LOCATION, APP_NAME, AUTOLIVE, SPEECH_SKU, LOCAL_BUILD; secrets: LLM_API_KEY, API_FOOTBALL_KEY."
