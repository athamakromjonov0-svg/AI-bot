import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../config/logger';

let openaiClient: OpenAI | null = null;

export function getLLMClient(): OpenAI {
  if (!openaiClient) {
    if (!config.LLM_API_KEY) {
      logger.warn('LLM_API_KEY is not set. AI Agent calls will fail until configured.');
    }
    openaiClient = new OpenAI({
      apiKey: config.LLM_API_KEY || 'dummy_key',
      baseURL: config.LLM_BASE_URL,
      timeout: 60000,
    });
  }
  return openaiClient;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  handler: (args: any, context?: any) => Promise<any>;
}

export function formatToolsForOpenAI(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
