#!/usr/bin/env bash
# setup-keychain.sh
#
# Fetches the Jira MCP OAuth client secret from AWS SSM and stores it in
# macOS Keychain. Run this once per machine — you never need to handle the
# secret value directly.
#
# Prerequisites:
#   - AWS CLI configured with a profile that has SSM read access
#   - macOS (uses the `security` CLI for Keychain)
#
# Usage:
#   ./scripts/setup-keychain.sh                          # uses default AWS profile
#   ./scripts/setup-keychain.sh built_dev_eks/BuiltEksDev  # explicit profile

set -euo pipefail

KEYCHAIN_ACCOUNT="jira-mcp"
KEYCHAIN_SERVICE="JIRA_OAUTH_CLIENT_SECRET"
SSM_PARAMETER="/jira-mcp/oauth-client-secret"

AWS_PROFILE="${1:-${AWS_PROFILE:-default}}"

echo "Fetching Jira MCP client secret from SSM (profile: ${AWS_PROFILE})..."

SECRET=$(AWS_PROFILE="${AWS_PROFILE}" aws ssm get-parameter \
  --name "${SSM_PARAMETER}" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text 2>&1) || {
  echo ""
  echo "ERROR: Could not fetch ${SSM_PARAMETER} from SSM."
  echo "Make sure you have SSM read access with profile '${AWS_PROFILE}'."
  echo "If using Granted: assume ${AWS_PROFILE}"
  exit 1
}

# Remove existing entry if present so the add doesn't fail
security delete-generic-password \
  -a "${KEYCHAIN_ACCOUNT}" \
  -s "${KEYCHAIN_SERVICE}" \
  2>/dev/null || true

security add-generic-password \
  -a "${KEYCHAIN_ACCOUNT}" \
  -s "${KEYCHAIN_SERVICE}" \
  -w "${SECRET}"

echo "Done. Jira MCP client secret stored in Keychain."
echo "You can now reload the jira-oauth MCP server in Cursor."
