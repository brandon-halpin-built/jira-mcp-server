# Jira & Confluence MCP Server

Authenticates via **Atlassian OAuth 2.0 (SSO)**. On first start the server opens your browser, you log in with your
company SSO, and the token is cached at `~/.config/jira-mcp/tokens.json` for future sessions. Tokens refresh
automatically in the background.

## Setup

### 1. Register an OAuth 2.0 app in Atlassian

1. Go to [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/) and create a new
   **OAuth 2.0 integration**.

2. Under **Authorization**, add the callback URL exactly:
   ```
   http://localhost:12345/callback
   ```

3. Under **Permissions**, add scopes across two sections:

   **Jira platform REST API — Classic scopes:**
   | Scope | Code |
   |-------|------|
   | View Jira issue data | `read:jira-work` |
   | Create and manage issues | `write:jira-work` |
   | View user profiles | `read:jira-user` |

   **Confluence API — Granular scopes** (use the Granular tab, not Classic):
   | Scope | Code |
   |-------|------|
   | Read pages | `read:page:confluence` |
   | Write pages | `write:page:confluence` |
   | Read spaces | `read:space:confluence` |
   | Search Confluence | `search:confluence` |

4. Copy the **Client ID** and **Client Secret** from the app settings page.

### 2. Store the client secret in macOS Keychain

The secret is stored in your local Keychain — it never lives in any config file.

**Option A — Pull from AWS SSM (recommended for teams):**

First, store the secret in SSM (one-time, done by the app registrant):
```bash
aws ssm put-parameter \
  --name "/jira-mcp/oauth-client-secret" \
  --value "YOUR_CLIENT_SECRET" \
  --type "SecureString" \
  --profile built_dev_eks/BuiltEksDev
```

Then each teammate runs the setup script once:
```bash
./scripts/setup-keychain.sh built_dev_eks/BuiltEksDev
```

**Option B — Manual:**
```bash
security add-generic-password -a "jira-mcp" -s "JIRA_OAUTH_CLIENT_SECRET" -w "YOUR_CLIENT_SECRET"
```

### 3. Install and build

```bash
npm ci
npm run build
```

### 4. Configure Cursor

Add to your Cursor MCP config (`~/.cursor/mcp.json`). Only the Client ID is needed here — the secret comes from
Keychain automatically:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/absolute/path/to/jira-mcp-server/dist/server.js"],
      "env": {
        "JIRA_HOST": "https://your-domain.atlassian.net",
        "JIRA_OAUTH_CLIENT_ID": "your-oauth-client-id"
      }
    }
  }
}
```

### First-time authentication

On the first server start (or after deleting the token cache), a browser window opens automatically to Atlassian's
login page. Sign in with your SSO credentials and approve the permissions. The browser shows a success message and the
server becomes available in Cursor.

**Re-authenticate:** Delete `~/.config/jira-mcp/tokens.json` and restart the MCP server.

---

## Teammate onboarding

1. Get the Client ID from your team's shared docs (it is not a secret).
2. Run the setup script to pull the client secret from SSM into your local Keychain:
   ```bash
   ./scripts/setup-keychain.sh built_dev_eks/BuiltEksDev
   ```
3. Add `JIRA_HOST` + `JIRA_OAUTH_CLIENT_ID` to your Cursor MCP config.
4. Reload the MCP server in Cursor — your browser will open for a one-time SSO login.

Teammates never need access to the Atlassian developer console or the raw client secret value.

---

## Capabilities

### Jira — Issues

| Tool | Description |
|------|-------------|
| `list_tickets` | List Jira issues (optional JQL; default: assigned to current user). |
| `get_ticket` | Get full issue details by key — includes assignee, reporter, priority, labels, components, sprint, linked issues, and dates. |
| `get_comments` | Get comments for an issue. |
| `create_ticket` | Create an issue (project, type, summary, description; optional parent/epic). |
| `add_comment` | Add a comment to an issue. |
| `update_ticket` | Edit fields on an existing issue: summary, description, assignee, priority, or labels. |
| `update_status` | Transition an issue using a transition ID (use `get_transitions` first). |
| `get_transitions` | List the valid status transitions for an issue in its current state. |
| `search_tickets` | Text search within given project keys (JQL-backed). |
| `search_users` | Find users by name or email — returns `accountId` values needed for assignment. |

### Jira — Issue Links

| Tool | Description |
|------|-------------|
| `get_link_types` | List all available link type names (e.g. Blocks, Relates, Clones). |
| `link_tickets` | Create a directional link between two issues. |
| `remove_link` | Remove a link by link ID (shown in `get_ticket`) or by source/target ticket keys. |

### Jira — Sprints & Boards

| Tool | Description |
|------|-------------|
| `get_sprints` | List sprints for a board (defaults to board 776). Filterable by `active`, `future`, or `closed`. |
| `get_sprint_tickets` | Get all tickets in a sprint with status, assignee, and priority. |
| `move_to_sprint` | Move one or more tickets into a sprint by sprint ID. |

### Confluence

| Tool | Description |
|------|-------------|
| `get_confluence_page` | Read a Confluence page by numeric page ID or full page URL on the same site. |
| `search_confluence` | Search Confluence with CQL (optional result limit, max 50). |
