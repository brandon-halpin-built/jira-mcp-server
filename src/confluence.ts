export interface ConfluenceSearchHit {
  id: string;
  title: string;
  spaceKey: string;
  spaceName: string;
  webUiLink: string;
}

function normalizeHost(host: string): string {
  return host.replace(/\/$/, '');
}

/**
 * Extract numeric page ID from a Confluence Cloud URL path (.../pages/12345/...).
 * Returns null if the URL host does not match the configured site (SSRF mitigation).
 */
export function extractPageIdFromConfluenceUrl(
  urlString: string,
  allowedHost: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }
  let allowed: URL;
  try {
    allowed = new URL(allowedHost);
  } catch {
    return null;
  }
  if (parsed.hostname !== allowed.hostname) {
    return null;
  }
  const match = parsed.pathname.match(/\/pages\/(\d+)/);
  if (!match) {
    return null;
  }
  return match[1];
}

// Confluence REST API v2 response (used for page fetch — accepts read:page:confluence granular scope)
interface ConfluencePageV2 {
  id?: string;
  title?: string;
  status?: string;
  spaceId?: string;
  parentId?: string;
  version?: { number?: number; createdAt?: string };
  body?: { storage?: { value?: string; representation?: string } };
  _links?: { webui?: string; base?: string };
}

// Confluence REST API v1 response (used for search — accepts search:confluence granular scope)
interface ConfluenceSearchResponse {
  results?: Array<{
    id?: string;
    type?: string;
    title?: string;
    space?: { key?: string; name?: string };
    _links?: { webui?: string };
  }>;
  size?: number;
}

function formatPageV2(data: ConfluencePageV2, gatewayBase: string): string {
  const lines: string[] = [];
  lines.push(`Title: ${data.title ?? 'Untitled'}`);
  if (data.id) lines.push(`Page ID: ${data.id}`);
  if (data.spaceId) lines.push(`Space ID: ${data.spaceId}`);
  if (data.version?.number !== undefined) {
    const when = data.version.createdAt
      ? new Date(data.version.createdAt).toLocaleString()
      : 'unknown';
    lines.push(`Version: ${data.version.number} (${when})`);
  }
  const webui = data._links?.webui;
  const linkBase = data._links?.base ?? gatewayBase;
  if (webui) {
    const absolute = webui.startsWith('http') ? webui : `${linkBase}${webui}`;
    lines.push(`URL: ${absolute}`);
  }
  lines.push('');
  lines.push('Body:');
  const storage = data.body?.storage?.value;
  if (storage && storage.trim().length > 0) {
    lines.push(storage.trim());
  } else {
    lines.push('(empty body)');
  }
  return lines.join('\n');
}

function stripHtmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Uses Confluence REST API v2 which accepts the read:page:confluence granular scope.
export async function fetchConfluencePageById(
  pageId: string,
  gatewayBase: string,
  accessToken: string,
): Promise<string> {
  const base = normalizeHost(gatewayBase);
  const url = `${base}/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Confluence API ${response.status}: ${text}`);
  }
  let data: ConfluencePageV2;
  try {
    data = JSON.parse(text) as ConfluencePageV2;
  } catch {
    throw new Error('Confluence API returned invalid JSON');
  }
  return formatPageV2(data, base);
}

// Uses Confluence REST API v1 search which accepts the search:confluence granular scope.
export async function searchConfluenceContent(
  gatewayBase: string,
  cql: string,
  limit: number,
  accessToken: string,
): Promise<{ text: string; hits: ConfluenceSearchHit[] }> {
  const base = normalizeHost(gatewayBase);
  const params = new URLSearchParams({
    cql: cql,
    limit: String(Math.min(Math.max(limit, 1), 50)),
    expand: 'space',
  });
  const url = `${base}/wiki/rest/api/content/search?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Confluence search ${response.status}: ${text}`);
  }
  let data: ConfluenceSearchResponse;
  try {
    data = JSON.parse(text) as ConfluenceSearchResponse;
  } catch {
    throw new Error('Confluence search returned invalid JSON');
  }
  const results = data.results ?? [];
  const hits: ConfluenceSearchHit[] = results.map((r) => {
    const webui = r._links?.webui ?? '';
    const absolute =
      webui.startsWith('http')
        ? webui
        : webui
          ? `${base}/wiki${webui.startsWith('/') ? '' : '/'}${webui}`
          : '';
    return {
      id: r.id ?? '',
      title: r.title ?? '(no title)',
      spaceKey: r.space?.key ?? '',
      spaceName: r.space?.name ?? '',
      webUiLink: absolute,
    };
  });
  if (hits.length === 0) {
    return {
      text: 'No pages found for this CQL query.',
      hits: [],
    };
  }
  const lines: string[] = [
    `Found ${hits.length} result(s):`,
    '',
  ];
  for (const h of hits) {
    lines.push(`- [${h.spaceKey}] ${h.title} (id: ${h.id})`);
    if (h.webUiLink) {
      lines.push(`  ${h.webUiLink}`);
    }
    lines.push('');
  }
  lines.push('Use get_confluence_page with pageId to load full body.');
  return { text: lines.join('\n'), hits: hits };
}
