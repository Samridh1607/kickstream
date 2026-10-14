#!/usr/bin/env bash
# Deploys Kickstream to Azure: infrastructure with Terraform, the image built in Azure Container Registry.
#   ./deploy/deploy.sh                 # build the image in the registry
#   ./deploy/deploy.sh --local-build   # build with Docker on this machine
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
terraform_dir="$here/terraform"
tag="$(date +%Y%m%d-%H%M%S)"
local_build=false
for arg in "$@"; do
  case "$arg" in
    --local-build) local_build=true ;;
    --tag=*) tag="${arg#--tag=}" ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

tools=(az terraform)
$local_build && tools+=(docker)
for tool in "${tools[@]}"; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed." >&2; exit 1; }
done

az account show --output none 2>/dev/null || az login --output none
export ARM_SUBSCRIPTION_ID="$(az account show --query id --output tsv)"
echo "Deploying to subscription $(az account show --query name --output tsv)"

terraform -chdir="$terraform_dir" init -input=false
# The registry first: the app cannot start until its image is in it.
terraform -chdir="$terraform_dir" apply -input=false -auto-approve -target=azurerm_container_registry.main
registry="$(terraform -chdir="$terraform_dir" output -raw registry_name)"
image="kickstream:$tag"

if $local_build; then
  server="$(az acr show --name "$registry" --query loginServer --output tsv)"
  az acr login --name "$registry"
  docker build --file "$root/deploy/docker/Dockerfile" --tag "$server/$image" "$root"
  docker push "$server/$image"
else
  az acr build --registry "$registry" --image "$image" --file "$root/deploy/docker/Dockerfile" "$root"
fi

terraform -chdir="$terraform_dir" apply -input=false -auto-approve -var="image_tag=$tag"
echo
echo "Kickstream is at $(terraform -chdir="$terraform_dir" output -raw url)"
