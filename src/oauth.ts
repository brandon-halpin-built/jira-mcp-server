import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { exec, execSync } from 'child_process';

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const CALLBACK_PORT = 12345;
const CALLBACK_PATH = '/callback';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// Jira uses classic scopes; Confluence uses granular scopes (required by the API gateway).
const OAUTH_SCOPES = [
  // Jira — classic scopes
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  // Confluence — granular scopes (api.atlassian.com gateway enforces granular for Confluence)
  'read:page:confluence',
  'write:page:confluence',
  'read:space:confluence',
  'search:confluence',
  // Session
  'offline_access',
].join(' ');

const TOKEN_FILE_PATH = path.join(os.homedir(), '.config', 'jira-mcp', 'tokens.json');

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
}

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface AtlassianTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

function loadTokens(): TokenData | null {
  try {
    if (!fs.existsSync(TOKEN_FILE_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8');
    return JSON.parse(raw) as TokenData;
  } catch {
    return null;
  }
}

function saveTokens(tokens: TokenData): void {
  const dir = path.dirname(TOKEN_FILE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.error(`Could not open browser automatically. Visit this URL to authenticate:\n${url}`);
    }
  });
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  config: OAuthConfig,
): Promise<TokenData> {
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (config.clientSecret) {
    params['client_secret'] = config.clientSecret;
  }
  const body = new URLSearchParams(params);

  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = JSON.parse(text) as AtlassianTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function refreshAccessToken(tokens: TokenData, config: OAuthConfig): Promise<TokenData> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: tokens.refreshToken,
  };
  if (config.clientSecret) {
    params['client_secret'] = config.clientSecret;
  }
  const body = new URLSearchParams(params);

  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = JSON.parse(text) as AtlassianTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function startOAuthFlow(config: OAuthConfig): Promise<TokenData> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(ATLASSIAN_AUTH_URL);
  authUrl.searchParams.set('audience', 'api.atlassian.com');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return new Promise<TokenData>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>OAuth error: ${error}</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`OAuth authorization error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>State mismatch — possible CSRF. Try again.</h2></body></html>');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>No authorization code received.</h2></body></html>');
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h2>Authentication successful!</h2>' +
          '<p>You can close this tab and return to your editor.</p></body></html>',
      );
      server.close();

      try {
        const tokens = await exchangeCodeForTokens(code, codeVerifier, config);
        resolve(tokens);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.error('\nJira MCP: Opening browser for Atlassian OAuth login...');
      openBrowser(authUrl.toString());
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is in use. Close any other process using it and retry.`));
      } else {
        reject(err);
      }
    });
  });
}

const KEYCHAIN_ACCOUNT = 'jira-mcp';
const KEYCHAIN_SERVICE = 'JIRA_OAUTH_CLIENT_SECRET';

/**
 * Reads the OAuth client secret from the macOS Keychain.
 * Store it once with:
 *   security add-generic-password -a "jira-mcp" -s "JIRA_OAUTH_CLIENT_SECRET" -w "your-secret"
 * Returns null if not found or on non-macOS platforms.
 */
export function readClientSecretFromKeychain(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const result = execSync(
      `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Returns a valid Atlassian access token, refreshing or re-authenticating via browser as needed.
 * Tokens are persisted to ~/.config/jira-mcp/tokens.json between sessions.
 */
export async function getValidAccessToken(config: OAuthConfig): Promise<string> {
  let tokens = loadTokens();

  if (tokens) {
    if (Date.now() + TOKEN_EXPIRY_BUFFER_MS < tokens.expiresAt) {
      return tokens.accessToken;
    }

    if (tokens.refreshToken) {
      try {
        console.error('Jira MCP: Access token expiring soon, refreshing...');
        tokens = await refreshAccessToken(tokens, config);
        saveTokens(tokens);
        console.error('Jira MCP: Token refreshed successfully.');
        return tokens.accessToken;
      } catch (err) {
        console.error(`Jira MCP: Token refresh failed (${(err as Error).message}), re-authenticating via browser...`);
      }
    }
  }

  console.error('Jira MCP: No valid token found. Starting browser authentication...');
  tokens = await startOAuthFlow(config);
  saveTokens(tokens);
  console.error('Jira MCP: Authentication successful. Token saved to ~/.config/jira-mcp/tokens.json');
  return tokens.accessToken;
}

interface AccessibleResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

/**
 * Returns the Atlassian cloud ID for the given site host (e.g. https://getbuilt.atlassian.net).
 * OAuth 2.0 tokens must be used with the API gateway URL (api.atlassian.com/ex/jira/{cloudId})
 * rather than the site-specific URL.
 */
export async function getCloudId(accessToken: string, siteHost: string): Promise<string> {
  const response = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch accessible resources (${response.status}): ${text}`);
  }

  const resources = JSON.parse(text) as AccessibleResource[];
  const normalizedHost = siteHost.replace(/\/$/, '').toLowerCase();
  const match = resources.find((r) => r.url.replace(/\/$/, '').toLowerCase() === normalizedHost);

  if (!match) {
    const available = resources.map((r) => r.url).join(', ');
    throw new Error(
      `No Atlassian resource found for host "${siteHost}". Available sites: ${available}`,
    );
  }

  return match.id;
}

/**
 * Deletes the stored token file, forcing re-authentication on the next server start.
 */
export function clearStoredTokens(): void {
  try {
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      fs.unlinkSync(TOKEN_FILE_PATH);
      console.error('Jira MCP: Stored tokens cleared. Re-authentication required on next start.');
    } else {
      console.error('Jira MCP: No stored tokens found.');
    }
  } catch (err) {
    console.error('Jira MCP: Failed to clear tokens:', err);
  }
}
