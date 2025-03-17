# Jira MCP Server Project Brief

## Core Requirements

1. Provide a TypeScript-based MCP server that integrates Jira with Cursor
2. Implement full Jira API functionality through MCP protocol
3. Support both command-based and HTTP-based integration methods
4. Maintain secure handling of Jira credentials
5. Provide comprehensive JQL (Jira Query Language) support for ticket searches

## Current Goal
Add JQL/search support for project-specific text searches using the syntax:
```jql
text ~ "{{text}}" AND project IN ({{csvlistProjects}})
```

## Success Criteria

1. Users can search for tickets within specific projects using text search
2. Search functionality supports multiple projects (CSV list)
3. Integration maintains existing MCP protocol standards
4. Search results are properly formatted and returned through the MCP interface
5. Error handling for invalid project keys or malformed search queries

## Constraints

1. Must maintain backward compatibility with existing MCP endpoints
2. Must follow TypeScript best practices
3. Must handle Jira API rate limits appropriately
4. Must validate input parameters before constructing JQL queries 