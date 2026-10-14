#!/usr/bin/env bash
# Deletes everything deploy.sh created, including the stored broadcasts and the sign-in app registration.
#   ./deploy/destroy.sh         # shows the plan and asks first
#   ./deploy/destroy.sh --yes   # no question
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
terraform_dir="$here/terraform"
approve=()
for arg in "$@"; do
  case "$arg" in
    --yes) approve=(-auto-approve) ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

for tool in az terraform; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed." >&2; exit 1; }
done

az account show --output none 2>/dev/null || az login --output none
export ARM_SUBSCRIPTION_ID="$(az account show --query id --output tsv)"

terraform -chdir="$terraform_dir" init -input=false
terraform -chdir="$terraform_dir" destroy -input=false ${approve[@]+"${approve[@]}"}
