import { ToolDefinition, formatToolsForOpenAI } from '../llm';
import { logger } from '../../config/logger';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  public register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Overwriting already registered tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    logger.debug(`Registered AI tool: ${tool.name}`);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public getOpenAITools() {
    return formatToolsForOpenAI(this.getAll());
  }

  public async execute(name: string, args: any, context?: any, timeoutMs: number = 25000): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      // The LLM occasionally invents a tool name: return an error payload so the
      // model can recover with a valid tool instead of aborting the whole reply.
      logger.warn(`Tool "${name}" not found in ToolRegistry. Returning error to LLM.`);
      return {
        error: true,
        message: `Tool "${name}" does not exist. Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
      };
    }

    logger.info(`[ToolRegistry] Executing tool "${name}"`, { args });

    // Enforce timeout
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    try {
      const result = await Promise.race([tool.handler(args, context), timeoutPromise]);
      return result;
    } catch (error: any) {
      logger.error(`[ToolRegistry] Tool "${name}" execution failed:`, error);
      return {
        error: true,
        message: error.message || 'Tool execution failed',
      };
    }
  }
}

export const globalToolRegistry = new ToolRegistry();
