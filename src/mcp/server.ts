import winston from 'winston';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables before any other imports
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from '../config/logger';
import { initializeTools } from '../ai/tools';
import { globalToolRegistry } from '../ai/tools/registry';
import { initUserbot, isUserbotConnected } from '../telegram/userbot';

// CRITICAL for stdio MCP: Silence console logging to stdout so JSON-RPC is never corrupted
logger.transports.forEach((transport) => {
  if (transport instanceof winston.transports.Console) {
    transport.silent = true;
  }
});

let isLocalInitialized = false;

/**
 * True when something is already listening on port 3000 (the main bot).
 * We must never open a second GramJS client while that process owns the
 * StringSession — two clients fighting over one session is exactly what
 * knocked the userbot offline.
 */
async function isMainAppReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1200);
    await fetch('http://localhost:3000/health', { signal: controller.signal });
    clearTimeout(t);
    return true;
  } catch {
    // No response at all => nothing listening.
    return false;
  }
}

async function ensureLocalInitialized() {
  if (isLocalInitialized) return;
  initializeTools();

  // If the main app is up, it already owns the userbot session. Do not
  // create a competing client — local tools that need Telegram will report
  // "not connected" instead of silently breaking the real one.
  if (await isMainAppReachable()) {
    isLocalInitialized = true;
    process.stderr.write('[MCP] Main app reachable — reusing its session, skipping local userbot init.\n');
    return;
  }

  try {
    if (!isUserbotConnected()) {
      await initUserbot();
    }
  } catch (err: any) {
    // If userbot is not authorized, don't crash the server; individual tools report status
    process.stderr.write(`[MCP] Userbot init notice: ${err?.message || err}\n`);
  }
  isLocalInitialized = true;
}

async function executeTool(name: string, args: any): Promise<string> {
  // 1. Prefer the already-running background bot on http://localhost:3000.
  //
  // IMPORTANT: we treat *any* HTTP response as "server is alive" — including
  // 503. /health deliberately returns 503 while MongoDB is down, and checking
  // `res.ok` made us fall through to local execution, which opened a SECOND
  // GramJS client on the same StringSession and kicked the real userbot off.
  // Only a network-level failure (connection refused) means "not running".
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    await fetch('http://localhost:3000/health', { signal: controller.signal });
    clearTimeout(timeout);

    const execRes = await fetch('http://localhost:3000/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    const data = (await execRes.json()) as any;
    if (data.ok) {
      const res = data.result;
      return typeof res === 'string' ? res : JSON.stringify(res, null, 2);
    }
    return `Xato: ${data.error || 'Noma\'lum xato'}`;
  } catch {
    // Nothing listening on port 3000 — safe to run the tool in this process.
  }

  // 2. Direct local execution via globalToolRegistry
  await ensureLocalInitialized();
  const res = await globalToolRegistry.execute(name, args);
  return typeof res === 'string' ? res : JSON.stringify(res, null, 2);
}

const server = new Server(
  {
    name: 'telegram-assistant',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  initializeTools();
  const tools = globalToolRegistry.getAll().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.parameters as any) || { type: 'object', properties: {} },
  }));
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await executeTool(name, args || {});
  return {
    content: [
      {
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
});

async function main() {
  initializeTools();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Telegram Assistant MCP Server running on stdio.\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal MCP Error: ${err?.message || err}\n`);
  process.exit(1);
});
