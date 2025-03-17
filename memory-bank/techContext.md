# Technical Context

## Technology Stack

1. **Core Technologies**
   - TypeScript 5.x
   - Node.js 18+
   - Express.js for HTTP server
   - Jira REST API v3

2. **Development Tools**
   - npm for package management
   - ESLint for code quality
   - Prettier for code formatting
   - ts-node for development

3. **Testing Framework**
   - Jest for unit testing
   - Supertest for API testing

## Dependencies

1. **Production Dependencies**
   ```json
   {
     "express": "^4.x",
     "jira-client": "^8.x",
     "dotenv": "^16.x",
     "typescript": "^5.x"
   }
   ```

2. **Development Dependencies**
   ```json
   {
     "@types/express": "^4.x",
     "@types/node": "^18.x",
     "ts-node": "^10.x",
     "jest": "^29.x"
   }
   ```

## Environment Setup

1. **Required Environment Variables**
   ```
   JIRA_HOST=https://your-domain.atlassian.net
   JIRA_EMAIL=your-email@example.com
   JIRA_API_TOKEN=your-api-token
   PORT=3000
   ```

2. **Development Commands**
   ```bash
   npm run dev    # Start development server
   npm run build  # Build production version
   npm start      # Start production server
   npm test       # Run tests
   ```

## API Constraints

1. **Jira API**
   - Rate limiting: 1000 requests per hour
   - Authentication via API token
   - JQL query length limits
   - Response pagination

2. **MCP Protocol**
   - Command-based communication
   - JSON response format
   - Error handling requirements
   - Capability registration

## Development Patterns

1. **Code Organization**
   ```
   src/
   ├── commands/     # Command handlers
   ├── services/     # Business logic
   ├── types/        # TypeScript types
   ├── utils/        # Utilities
   └── server.ts     # Entry point
   ```

2. **Error Handling**
   - Custom error classes
   - Error middleware
   - Consistent error responses
   - Logging strategy

3. **Testing Strategy**
   - Unit tests for commands
   - Integration tests for API
   - Mock Jira responses
   - Test coverage requirements 