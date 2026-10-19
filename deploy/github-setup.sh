#!/usr/bin/env bash
# One-time setup for deploying from GitHub: an Entra app that GitHub Actions signs in as (no secret, through
# OIDC), a storage account for Terraform's state, and the repository variables the Deploy workflow reads.
# Safe to run again: whatever already exists is reused.
#   ./deploy/github-setup.sh [location] [state resource group]
set -euo pipefail

location="${1:-centralindia}"
state_group="${2:-kickstream-tfstate}"

for tool in az gh; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed." >&2; exit 1; }
done
az account show --output none 2>/dev/null || az login --output none
gh auth status

subscription="$(az account show --query id --output tsv)"
tenant="$(az account show --query tenantId --output tsv)"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
me="$(az ad signed-in-user show --query id --output tsv)"
echo "Subscription $(az account show --query name --output tsv), repository $repo"

# Terraform's state: a private storage account read and written with Entra ID, not keys.
az group create --name "$state_group" --location "$location" --output none
account="$(gh variable get TFSTATE_STORAGE_ACCOUNT 2>/dev/null || true)"
[ -n "$account" ] || account="kickstreamtf$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8)"
if ! az storage account show --name "$account" --resource-group "$state_group" --output none 2>/dev/null; then
  az storage account create --name "$account" --resource-group "$state_group" --location "$location" \
    --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false \
    --allow-shared-key-access false --output none
fi
account_id="$(az storage account show --name "$account" --resource-group "$state_group" --query id --output tsv)"
if ! az storage container-rm show --name tfstate --storage-account "$account" --resource-group "$state_group" --output none 2>/dev/null; then
  az storage container-rm create --name tfstate --storage-account "$account" --resource-group "$state_group" --output none
fi

# The identity GitHub Actions signs in as, trusted only for this repository's production environment.
name="kickstream-github-deploy"
app_id="$(az ad app list --display-name "$name" --query "[0].appId" --output tsv)"
[ -n "$app_id" ] || app_id="$(az ad app create --display-name "$name" --query appId --output tsv)"
sp_id="$(az ad sp show --id "$app_id" --query id --output tsv 2>/dev/null || true)"
[ -n "$sp_id" ] || sp_id="$(az ad sp create --id "$app_id" --query id --output tsv)"
subject="repo:${repo}:environment:production"
if [ "$(az ad app federated-credential list --id "$app_id" --query "[?subject=='$subject'] | length(@)" --output tsv)" = "0" ]; then
  az ad app federated-credential create --id "$app_id" --output none --parameters \
    "{\"name\":\"github-production\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"$subject\",\"audiences\":[\"api://AzureADTokenExchange\"]}"
fi

# Terraform creates resources and role assignments, so Owner; the state needs blob data access too.
grant() {
  if [ -z "$(az role assignment list --assignee "$sp_id" --role "$1" --scope "$2" --query "[0].id" --output tsv)" ]; then
    az role assignment create --assignee-object-id "$sp_id" --assignee-principal-type ServicePrincipal \
      --role "$1" --scope "$2" --output none
  fi
}
grant Owner "/subscriptions/$subscription"
grant "Storage Blob Data Contributor" "$account_id"

# auth.tf registers the studio's sign-in app and assigns its users, which needs these Microsoft Graph permissions.
az ad app permission add --id "$app_id" --api 00000003-0000-0000-c000-000000000000 --output none --api-permissions \
  18a4783c-866b-4cc7-a460-3d5e5662c884=Role 06b708a9-e830-4db3-a914-8e69da51d44f=Role
if ! az ad app permission admin-consent --id "$app_id" 2>/dev/null; then
  echo "Warning: admin consent could not be granted. Ask a Global Administrator to grant it for '$name'" \
    "(Microsoft Graph: Application.ReadWrite.OwnedBy and AppRoleAssignment.ReadWrite.All)" \
    "in Entra ID > App registrations > API permissions." >&2
fi

gh api --method PUT "repos/$repo/environments/production" --silent
gh variable set AZURE_CLIENT_ID --body "$app_id"
gh variable set AZURE_TENANT_ID --body "$tenant"
gh variable set AZURE_SUBSCRIPTION_ID --body "$subscription"
gh variable set TFSTATE_RESOURCE_GROUP --body "$state_group"
gh variable set TFSTATE_STORAGE_ACCOUNT --body "$account"
gh variable get STUDIO_USERS >/dev/null 2>&1 || gh variable set STUDIO_USERS --body "$me"

echo
echo "GitHub can now deploy. Every push to main deploys once CI passes; to deploy now:"
echo "  gh workflow run deploy.yml"
echo "Optional settings (repository variables): FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_DEPLOYMENT, FOUNDRY_RESOURCE_ID,"
echo "AZURE_LOCATION, APP_NAME, AUTOLIVE, SPEECH_SKU, LOCAL_BUILD; secrets: LLM_API_KEY, API_FOOTBALL_KEY."
