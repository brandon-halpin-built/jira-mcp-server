import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Version3Client, AgileClient } from 'jira.js';
import { z } from 'zod';
import {
  extractPageIdFromConfluenceUrl,
  fetchConfluencePageById,
  searchConfluenceContent,
} from './confluence.js';
import { getValidAccessToken, getCloudId, readClientSecretFromKeychain, OAuthConfig } from './oauth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from both locations
dotenv.config();
try {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
} catch (e) {
  console.error("Error loading .env file:", e);
}

// Initialized in main() after OAuth authentication; guarded at runtime by validateJiraConfig()
let jira!: Version3Client;
let agile!: AgileClient;
let currentAccessToken = '';
let confluenceBaseUrl = '';
let oauthConfig: OAuthConfig | undefined;

// OAuth tokens must be used with the Atlassian API gateway URL, not the site-specific URL.
function createJiraClients(accessToken: string, cloudId: string): void {
  const gatewayBase = `https://api.atlassian.com/ex/jira/${cloudId}`;
  jira = new Version3Client({
    host: gatewayBase,
    authentication: { oauth2: { accessToken: accessToken } },
  });
  agile = new AgileClient({
    host: gatewayBase,
    authentication: { oauth2: { accessToken: accessToken } },
  });
  currentAccessToken = accessToken;
  confluenceBaseUrl = `https://api.atlassian.com/ex/confluence/${cloudId}`;
}

// Type definitions
interface JiraTicket {
  summary: string;
  description: string;
  projectKey: string;
  issueType: string;
  parent?: string; // Optional parent/epic key for next-gen projects
}

interface JiraComment {
  body: string;
}

interface StatusUpdate {
  transitionId: string;
}

// Validation schemas
const TicketSchema = z.object({
  summary: z.string().describe("The ticket summary"),
  description: z.string().describe("The ticket description"),
  projectKey: z.string().describe("The project key (e.g., PROJECT)"),
  issueType: z.string().describe("The type of issue (e.g., Task, Bug)"),
  parent: z.string().optional().describe("The parent/epic key (for next-gen projects)"),
});

const CommentSchema = z.object({
  body: z.string().describe("The comment text"),
});

const StatusUpdateSchema = z.object({
  transitionId: z.string().describe("The ID of the transition to perform"),
});

// Helper function to recursively extract text from ADF nodes
function extractTextFromADF(node: any): string {
  if (!node) {
    return '';
  }

  // Handle text nodes directly
  if (node.type === 'text' && node.text) {
    return node.text;
  }

  let text = '';
  // Handle block nodes like paragraph, heading, etc.
  if (node.content && Array.isArray(node.content)) {
    text = node.content.map(extractTextFromADF).join('');
    // Add a newline after paragraphs for better formatting
    if (node.type === 'paragraph') {
      text += '\n';
    }
  }

  return text;
}

// Helper function to wrap plain text in Atlassian Document Format for API writes
function plainTextToADF(text: string): object {
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map(paragraph => ({
      type: 'paragraph',
      content: [{ type: 'text', text: paragraph }],
    })),
  };
}

// Helper function to validate Jira configuration
function validateJiraConfig(): string | null {
  if (!process.env.JIRA_HOST) return "JIRA_HOST environment variable is not set";
  if (!process.env.JIRA_OAUTH_CLIENT_ID) return "JIRA_OAUTH_CLIENT_ID environment variable is not set";
  if (!jira || !agile) return "Jira clients not initialized — authentication may have failed at startup. Check credentials and restart.";
  return null;
}

// Helper function to validate and format project keys
function validateAndFormatProjectKeys(projectKeys: string): string[] {
  return projectKeys
    .split(',')
    .map(key => key.trim().toUpperCase())
    .filter(key => key.length > 0);
}

// Helper function to escape special characters in JQL text search
function escapeJQLText(text: string): string {
  // Escape special characters: + - & | ! ( ) { } [ ] ^ ~ * ? \ /
  return text.replace(/[+\-&|!(){}[\]^~*?\\\/]/g, '\\$&');
}

// Create server instance
const server = new McpServer({
  name: "jira",
  version: "1.0.0"
});

// Register tools
server.tool(
  "list_tickets",
  "List Jira tickets assigned to you",
  {
    jql: z.string().optional().describe("Optional JQL query to filter tickets"),
  },
  async ({ jql }: { jql?: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const query = jql || 'assignee = currentUser() ORDER BY updated DESC';
      const tickets = await jira.issueSearch.searchForIssuesUsingJql({ jql: query });
      
      if (!tickets.issues || tickets.issues.length === 0) {
        return {
          content: [{ type: "text", text: "No tickets found" }],
        };
      }

      const formattedTickets = tickets.issues.map((issue) => {
        const summary = issue.fields?.summary || 'No summary';
        const status = issue.fields?.status?.name || 'Unknown status';
        return `${issue.key}: ${summary} (${status})`;
      }).join('\n');

      return {
        content: [{ type: "text", text: formattedTickets }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch tickets: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_ticket",
  "Get details of a specific Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID (e.g., PROJECT-123)"),
  },
  async ({ ticketId }: { ticketId: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const ticket = await jira.issues.getIssue({
        issueIdOrKey: ticketId,
        fields: [
          'summary', 'status', 'issuetype', 'description', 'parent', 'issuelinks',
          'assignee', 'reporter', 'priority', 'labels', 'components',
          'created', 'updated', 'customfield_10020',
        ],
      });

      const fields = ticket.fields as any;

      const assignee = fields?.assignee?.displayName ?? 'Unassigned';
      const reporter = fields?.reporter?.displayName ?? 'Unknown';
      const priority = fields?.priority?.name ?? 'None';
      const labels: string[] = fields?.labels ?? [];
      const components: string[] = (fields?.components ?? []).map((c: any) => c.name);
      const created = fields?.created ? new Date(fields.created).toLocaleString() : 'Unknown';
      const updated = fields?.updated ? new Date(fields.updated).toLocaleString() : 'Unknown';

      // Sprint — customfield_10020 is an array of sprint objects
      const sprints: any[] = fields?.customfield_10020 ?? [];
      const activeSprint = sprints.find((s: any) => s.state === 'active') ?? sprints[sprints.length - 1];
      const sprintText = activeSprint ? `${activeSprint.name} (${activeSprint.state}, id: ${activeSprint.id})` : 'None';

      const formattedTicket = [
        `Key: ${ticket.key}`,
        `Summary: ${fields?.summary ?? 'No summary'}`,
        `Status: ${fields?.status?.name ?? 'Unknown status'}`,
        `Type: ${fields?.issuetype?.name ?? 'Unknown type'}`,
        `Priority: ${priority}`,
        `Assignee: ${assignee}`,
        `Reporter: ${reporter}`,
        `Labels: ${labels.length > 0 ? labels.join(', ') : 'None'}`,
        `Components: ${components.length > 0 ? components.join(', ') : 'None'}`,
        `Sprint: ${sprintText}`,
        `Parent: ${fields?.parent?.key ?? 'None'}`,
        `Created: ${created}`,
        `Updated: ${updated}`,
        `Description:\n${extractTextFromADF(fields?.description) || 'No description'}`,
      ];

      // Linked Issues Section
      const links = fields?.issuelinks ?? [];
      if (Array.isArray(links) && links.length > 0) {
        formattedTicket.push('\nLinked Issues:');
        for (const link of links) {
          // Outward (this issue is the source)
          if (link.outwardIssue) {
            const key = link.outwardIssue.key;
            const summary = link.outwardIssue.fields?.summary ?? 'No summary';
            const type = link.type?.outward ?? link.type?.name ?? 'Related';
            formattedTicket.push(`- [${type}] ${key}: ${summary} (link id: ${link.id})`);
          }
          // Inward (this issue is the target)
          if (link.inwardIssue) {
            const key = link.inwardIssue.key;
            const summary = link.inwardIssue.fields?.summary ?? 'No summary';
            const type = link.type?.inward ?? link.type?.name ?? 'Related';
            formattedTicket.push(`- [${type}] ${key}: ${summary} (link id: ${link.id})`);
          }
        }
      } else {
        formattedTicket.push('\nLinked Issues: None');
      }

      return {
        content: [{ type: "text", text: formattedTicket.join('\n') }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch ticket: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_comments",
  "Get comments for a specific Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID (e.g., PROJECT-123)"),
  },
  async ({ ticketId }: { ticketId: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const commentsResult = await jira.issueComments.getComments({ issueIdOrKey: ticketId });
      
      if (!commentsResult.comments || commentsResult.comments.length === 0) {
        return {
          content: [{ type: "text", text: "No comments found for this ticket." }],
        };
      }

      const formattedComments = commentsResult.comments.map(comment => {
        const author = comment.author?.displayName || 'Unknown Author';
        // Comments also use ADF, so we need to parse them
        const body = extractTextFromADF(comment.body) || 'No comment body'; 
        const createdDate = comment.created ? new Date(comment.created).toLocaleString() : 'Unknown date';
        return `[${createdDate}] ${author}:\n${body.trim()}\n---`; // Added trim() and separator
      }).join('\n\n'); // Separate comments with double newline

      return {
        content: [{ type: "text", text: formattedComments }],
      };
    } catch (error) {
      // Handle cases where the ticket might not exist or other API errors
      if ((error as any).response?.status === 404) {
          return {
              content: [{ type: "text", text: `Ticket ${ticketId} not found.` }],
          };
      }
      return {
        content: [{ type: "text", text: `Failed to fetch comments: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "create_ticket",
  "Create a new Jira ticket",
  {
    ticket: TicketSchema,
  },
  async ({ ticket }: { ticket: JiraTicket }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const fields: any = {
        project: { key: ticket.projectKey },
        summary: ticket.summary,
        description: ticket.description,
        issuetype: { name: ticket.issueType },
      };

      // Add parent/epic link if specified
      if (ticket.parent) {
        fields.parent = { key: ticket.parent };
      }

      const newTicket = await jira.issues.createIssue({
        fields: fields,
      });

      return {
        content: [{ type: "text", text: `Created ticket: ${newTicket.key}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to create ticket: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "add_comment",
  "Add a comment to a Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID"),
    comment: CommentSchema,
  },
  async ({ ticketId, comment }: { ticketId: string; comment: JiraComment }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      await jira.issueComments.addComment({
        issueIdOrKey: ticketId,
        comment: comment.body,
      });

      return {
        content: [{ type: "text", text: `Added comment to ${ticketId}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to add comment: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "update_status",
  "Update the status of a Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID"),
    status: StatusUpdateSchema,
  },
  async ({ ticketId, status }: { ticketId: string; status: StatusUpdate }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      await jira.issues.doTransition({
        issueIdOrKey: ticketId,
        transition: { id: status.transitionId },
      });

      return {
        content: [{ type: "text", text: `Updated status of ${ticketId}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to update status: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "search_tickets",
  "Search for tickets in specific projects using text search",
  {
    searchText: z.string().describe("The text to search for in tickets"),
    projectKeys: z.string().describe("Comma-separated list of project keys"),
    maxResults: z.number().optional().describe("Maximum number of results to return"),
  },
  async ({ searchText, projectKeys, maxResults = 50 }: { searchText: string; projectKeys: string; maxResults?: number }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      // Validate and format project keys
      const projects = validateAndFormatProjectKeys(projectKeys);
      if (projects.length === 0) {
        return {
          content: [{ type: "text", text: "No valid project keys provided. Please provide at least one project key." }],
        };
      }

      // Escape the search text for JQL
      const escapedText = escapeJQLText(searchText);

      // Construct the JQL query
      const jql = `text ~ "${escapedText}" AND project IN (${projects.join(',')}) ORDER BY updated DESC`;

      // Execute the search with description field included
      const searchResults = await jira.issueSearch.searchForIssuesUsingJql({
        jql,
        maxResults,
        fields: ['summary', 'status', 'updated', 'project', 'description'],
      });

      if (!searchResults.issues || searchResults.issues.length === 0) {
        return {
          content: [{ type: "text", text: `No tickets found matching "${searchText}" in projects: ${projects.join(', ')}` }],
        };
      }

      // Format the results with descriptions
      const formattedResults = searchResults.issues.map(issue => {
        const summary = issue.fields?.summary || 'No summary';
        const status = issue.fields?.status?.name || 'Unknown status';
        const project = issue.fields?.project?.key || 'Unknown project';
        const updated = issue.fields?.updated ? 
          new Date(issue.fields.updated).toLocaleString() :
          'Unknown date';
        const description = issue.fields?.description ? 
          extractTextFromADF(issue.fields.description) : 
          'No description';
        
        return `[${project}] ${issue.key}: ${summary}
Status: ${status} (Updated: ${updated})
Description:
${description.trim()}
----------------------------------------\n`;
      }).join('\n');

      const totalResults = searchResults.total || 0;
      const headerText = `Found ${totalResults} ticket${totalResults !== 1 ? 's' : ''} matching "${searchText}"\n\n`;

      return {
        content: [{ type: "text", text: headerText + formattedResults }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        content: [{ type: "text", text: `Failed to search tickets: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "get_transitions",
  "List the available status transitions for a Jira ticket in its current state. Use the returned transition IDs with update_status.",
  {
    ticketId: z.string().describe("The Jira ticket ID (e.g., PDE-123)"),
  },
  async ({ ticketId }: { ticketId: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const result = await jira.issues.getTransitions({ issueIdOrKey: ticketId });
      const transitions = result.transitions ?? [];

      if (transitions.length === 0) {
        return {
          content: [{ type: "text", text: `No transitions available for ${ticketId}.` }],
        };
      }

      const formatted = transitions.map(t => `- ${t.name} (id: ${t.id})`).join('\n');
      return {
        content: [{ type: "text", text: `Available transitions for ${ticketId}:\n\n${formatted}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch transitions: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "update_ticket",
  "Update fields on an existing Jira ticket. All fields are optional — only provided fields are changed. Use search_users to find an accountId for assignee.",
  {
    ticketId: z.string().describe("The Jira ticket ID (e.g., PDE-123)"),
    summary: z.string().optional().describe("New summary/title"),
    description: z.string().optional().describe("New description (plain text)"),
    assigneeAccountId: z.string().optional().describe("Assignee's Jira account ID. Use search_users to find it. Pass empty string to unassign."),
    priority: z.string().optional().describe("Priority name (e.g., 'High', 'Medium', 'Low', 'Highest', 'Lowest')"),
    labels: z.array(z.string()).optional().describe("Replacement labels array. Replaces all existing labels."),
  },
  async ({ ticketId, summary, description, assigneeAccountId, priority, labels }: {
    ticketId: string;
    summary?: string;
    description?: string;
    assigneeAccountId?: string;
    priority?: string;
    labels?: string[];
  }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    const fields: Record<string, unknown> = {};
    if (summary !== undefined) fields['summary'] = summary;
    if (description !== undefined) fields['description'] = plainTextToADF(description);
    if (assigneeAccountId !== undefined) {
      fields['assignee'] = assigneeAccountId.length > 0 ? { accountId: assigneeAccountId } : null;
    }
    if (priority !== undefined) fields['priority'] = { name: priority };
    if (labels !== undefined) fields['labels'] = labels;

    if (Object.keys(fields).length === 0) {
      return {
        content: [{ type: "text", text: "No fields provided to update." }],
      };
    }

    try {
      await jira.issues.editIssue({ issueIdOrKey: ticketId, fields: fields });
      const updated = Object.keys(fields).join(', ');
      return {
        content: [{ type: "text", text: `Updated ${ticketId}: ${updated}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to update ticket: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "search_users",
  "Search for Jira users by name or email. Returns display names and account IDs needed for ticket assignment.",
  {
    query: z.string().describe("Name or email to search for"),
    maxResults: z.number().optional().describe("Max results to return (default 10)"),
  },
  async ({ query, maxResults = 10 }: { query: string; maxResults?: number }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const results = await jira.userSearch.findUsers({ query: query, maxResults: maxResults });

      if (!results || results.length === 0) {
        return {
          content: [{ type: "text", text: `No users found matching "${query}".` }],
        };
      }

      const formatted = results.map(u =>
        `- ${u.displayName ?? 'Unknown'} (${u.emailAddress ?? 'no email'})\n  accountId: ${u.accountId}`
      ).join('\n');

      return {
        content: [{ type: "text", text: `Users matching "${query}":\n\n${formatted}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to search users: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_link_types",
  "List all available Jira issue link types (e.g. Blocks, Relates, Clones). Use the name values with link_tickets.",
  {},
  async () => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const result = await jira.issueLinkTypes.getIssueLinkTypes();
      const types = result.issueLinkTypes ?? [];

      if (types.length === 0) {
        return {
          content: [{ type: "text", text: "No issue link types found." }],
        };
      }

      const formatted = types.map(t =>
        `- ${t.name}\n  Outward: "${t.outward}"\n  Inward: "${t.inward}"`
      ).join('\n');

      return {
        content: [{ type: "text", text: `Available link types:\n\n${formatted}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch link types: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "link_tickets",
  "Create a link between two Jira tickets (e.g. 'Blocks', 'Relates', 'Clones'). Use get_link_types to see valid link type names.",
  {
    outwardTicketId: z.string().describe("The ticket that is the source of the relationship (e.g. the one that blocks)"),
    inwardTicketId: z.string().describe("The ticket that is the target of the relationship (e.g. the one that is blocked)"),
    linkTypeName: z.string().describe("The link type name (e.g. 'Blocks', 'Relates', 'Clones'). Use get_link_types for valid values."),
  },
  async ({ outwardTicketId, inwardTicketId, linkTypeName }: { outwardTicketId: string; inwardTicketId: string; linkTypeName: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      await jira.issueLinks.linkIssues({
        type: { name: linkTypeName },
        outwardIssue: { key: outwardTicketId },
        inwardIssue: { key: inwardTicketId },
      });

      return {
        content: [{ type: "text", text: `Linked ${outwardTicketId} → ${inwardTicketId} as "${linkTypeName}".` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to link tickets: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "remove_link",
  "Remove a link between two Jira tickets. Provide the link ID shown in get_ticket output, or provide both ticket keys and an optional link type name to find and remove the matching link.",
  {
    linkId: z.string().optional().describe("The link ID (shown in get_ticket output). If provided, the link is deleted directly."),
    sourceTicketId: z.string().optional().describe("Source ticket key — used to look up the link ID when linkId is not provided"),
    linkedTicketId: z.string().optional().describe("The other ticket key in the link"),
    linkTypeName: z.string().optional().describe("Link type name to disambiguate when multiple links exist between the same two tickets"),
  },
  async ({ linkId, sourceTicketId, linkedTicketId, linkTypeName }: {
    linkId?: string;
    sourceTicketId?: string;
    linkedTicketId?: string;
    linkTypeName?: string;
  }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      let resolvedLinkId = linkId;

      if (!resolvedLinkId) {
        if (!sourceTicketId || !linkedTicketId) {
          return {
            content: [{ type: "text", text: "Provide either linkId, or both sourceTicketId and linkedTicketId." }],
          };
        }

        const ticket = await jira.issues.getIssue({
          issueIdOrKey: sourceTicketId,
          fields: ['issuelinks'],
        });

        const links: any[] = (ticket.fields as any)?.issuelinks ?? [];
        const match = links.find(l => {
          const matchesTarget =
            l.outwardIssue?.key === linkedTicketId || l.inwardIssue?.key === linkedTicketId;
          if (!matchesTarget) return false;
          if (linkTypeName) {
            return l.type?.name === linkTypeName || l.type?.outward === linkTypeName || l.type?.inward === linkTypeName;
          }
          return true;
        });

        if (!match) {
          return {
            content: [{ type: "text", text: `No matching link found between ${sourceTicketId} and ${linkedTicketId}.` }],
          };
        }

        resolvedLinkId = match.id;
      }

      await jira.issueLinks.deleteIssueLink({ linkId: resolvedLinkId! });
      return {
        content: [{ type: "text", text: `Removed link (id: ${resolvedLinkId}).` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to remove link: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_sprints",
  "List sprints for a Jira board. Defaults to board 776 (CRE board). Filter by state: active, future, closed.",
  {
    boardId: z.number().optional().describe("Board ID (default: 776 — CRE board)"),
    state: z.enum(['active', 'future', 'closed']).optional().describe("Filter by sprint state (default: active and future)"),
  },
  async ({ boardId = 776, state }: { boardId?: number; state?: 'active' | 'future' | 'closed' }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const result = await agile.board.getAllSprints({
        boardId: boardId,
        state: state,
      });

      const sprints = result.values ?? [];
      if (sprints.length === 0) {
        return {
          content: [{ type: "text", text: `No sprints found for board ${boardId}.` }],
        };
      }

      const formatted = sprints.map(s =>
        `- [${s.state}] ${s.name} (id: ${s.id})${s.startDate ? ` | ${s.startDate} → ${s.endDate}` : ''}`
      ).join('\n');

      return {
        content: [{ type: "text", text: `Sprints for board ${boardId}:\n\n${formatted}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch sprints: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_sprint_tickets",
  "Get all tickets in a sprint. Use get_sprints to find the sprint ID.",
  {
    sprintId: z.number().describe("The sprint ID (from get_sprints)"),
    maxResults: z.number().optional().describe("Max tickets to return (default 50)"),
  },
  async ({ sprintId, maxResults = 50 }: { sprintId: number; maxResults?: number }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const result = await agile.sprint.getIssuesForSprint({
        sprintId: sprintId,
        maxResults: maxResults,
        fields: ['summary', 'status', 'assignee', 'priority', 'issuetype'],
      });

      const issues = result.issues ?? [];
      if (issues.length === 0) {
        return {
          content: [{ type: "text", text: `No tickets found in sprint ${sprintId}.` }],
        };
      }

      const formatted = issues.map(issue => {
        const fields = issue.fields as any;
        const summary = fields?.summary ?? 'No summary';
        const status = fields?.status?.name ?? 'Unknown';
        const assignee = fields?.assignee?.displayName ?? 'Unassigned';
        const priority = fields?.priority?.name ?? 'None';
        const type = fields?.issuetype?.name ?? 'Unknown';
        return `${issue.key} [${type}] ${summary}\n  Status: ${status} | Assignee: ${assignee} | Priority: ${priority}`;
      }).join('\n\n');

      const total = result.total ?? issues.length;
      return {
        content: [{ type: "text", text: `Sprint ${sprintId} — ${total} ticket(s):\n\n${formatted}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch sprint tickets: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "move_to_sprint",
  "Move one or more Jira tickets into a sprint. Use get_sprints to find the sprint ID.",
  {
    sprintId: z.number().describe("The target sprint ID (from get_sprints)"),
    ticketIds: z.array(z.string()).describe("One or more ticket keys to move (e.g. ['PDE-123', 'PDE-456'])"),
  },
  async ({ sprintId, ticketIds }: { sprintId: number; ticketIds: string[] }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      await agile.sprint.moveIssuesToSprintAndRank({
        sprintId: sprintId,
        issues: ticketIds,
      });

      return {
        content: [{ type: "text", text: `Moved ${ticketIds.join(', ')} to sprint ${sprintId}.` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to move tickets to sprint: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_confluence_page",
  "Read a Confluence wiki page by numeric page ID or by a Confluence Cloud page URL (same site as JIRA_HOST). Returns title, metadata, and body (storage format). Uses JIRA_EMAIL and JIRA_API_TOKEN.",
  {
    pageIdOrUrl: z
      .string()
      .describe(
        "Numeric page ID (e.g. 123456789) or full Confluence page URL under your Atlassian site",
      ),
  },
  async ({ pageIdOrUrl }: { pageIdOrUrl: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }
    const siteHost = process.env.JIRA_HOST!;
    let pageId = pageIdOrUrl.trim();
    if (/^https?:\/\//i.test(pageId)) {
      const extracted = extractPageIdFromConfluenceUrl(pageId, siteHost);
      if (!extracted) {
        return {
          content: [
            {
              type: "text",
              text:
                "Could not parse a page ID from this URL, or the host does not match JIRA_HOST.",
            },
          ],
        };
      }
      pageId = extracted;
    }
    try {
      const text = await fetchConfluencePageById(pageId, confluenceBaseUrl, currentAccessToken);
      return {
        content: [{ type: "text", text: text }],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Failed to fetch Confluence page: ${(error as Error).message}` },
        ],
      };
    }
  }
);

server.tool(
  "search_confluence",
  "Search Confluence content using CQL (Confluence Query Language). Example: type=page AND space = \"DEV\" AND text ~ \"runbook\". Max 50 results.",
  {
    cql: z
      .string()
      .describe("CQL query, e.g. type=page AND text ~ \"my topic\""),
    limit: z
      .number()
      .optional()
      .describe("Max results (1–50, default 25)"),
  },
  async ({ cql, limit }: { cql: string; limit?: number }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }
    const max = limit ?? 25;
    try {
      const result = await searchConfluenceContent(confluenceBaseUrl, cql, max, currentAccessToken);
      return {
        content: [{ type: "text", text: result.text }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to search Confluence: ${(error as Error).message}`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    // Connect transport first so Cursor doesn't time out waiting for a response
    // while the OAuth browser flow is in progress.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Jira MCP Server running on stdio');

    const host = process.env.JIRA_HOST;
    const clientId = process.env.JIRA_OAUTH_CLIENT_ID;

    if (!host || !clientId) {
      console.error('Jira MCP: JIRA_HOST and JIRA_OAUTH_CLIENT_ID are required. Tools will return configuration errors.');
      return;
    }

    // Client secret is optional for PKCE public client flows.
    // Check Keychain first, then fall back to env var, then omit entirely.
    const clientSecret = readClientSecretFromKeychain() ?? process.env.JIRA_OAUTH_CLIENT_SECRET ?? undefined;

    // Authenticate in the background — tools check jira/agile are initialized before use.
    try {
      oauthConfig = { clientId: clientId, clientSecret: clientSecret };
      const accessToken = await getValidAccessToken(oauthConfig);
      const cloudId = await getCloudId(accessToken, host);
      createJiraClients(accessToken, cloudId);
      console.error(`Jira MCP: Authenticated successfully (cloud: ${cloudId}).`);
    } catch (authError) {
      console.error('Jira MCP: Authentication failed. Tools will return errors until the server is restarted and auth succeeds.');
      console.error(authError);
    }
  } catch (error) {
    console.error('Fatal error starting Jira MCP server:', error);
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGINT', () => {
  console.error('Received SIGINT signal, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM signal, shutting down...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
}); 