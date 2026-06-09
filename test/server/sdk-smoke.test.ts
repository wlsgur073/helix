import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

describe('MCP SDK imports', () => {
  it('McpServer constructs and zod is available', () => {
    const server = new McpServer({ name: 'helix', version: '0.1.0' });
    expect(server).toBeDefined();
    expect(typeof z.string).toBe('function');
    expect(typeof StdioServerTransport).toBe('function');
  });
});
