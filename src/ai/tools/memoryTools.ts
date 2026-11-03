import { ToolDefinition } from '../llm';
import { MemoryModel } from '../../database/models/Memory';
import { isDbConnected } from '../../database';
import { logger } from '../../config/logger';

export const rememberFactTool: ToolDefinition = {
  name: 'remember_fact',
  description: 'Save a key fact, user preference, instruction, or detail into long-term memory for future reference.',
  parameters: {
    type: 'object',
    required: ['content', 'category'],
    properties: {
      content: {
        type: 'string',
        description: 'The concise fact or piece of information to remember',
      },
      category: {
        type: 'string',
        enum: ['preference', 'fact', 'instruction', 'contact', 'general'],
        description: 'Category of the memory',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keywords or tags associated with this fact',
      },
      importance: {
        type: 'number',
        description: 'Importance rating from 1 (low) to 5 (critical)',
      },
    },
  },
  handler: async (args: { content: string; category?: any; tags?: string[]; importance?: number }) => {
    if (!isDbConnected()) {
      return { success: false, error: 'Database is not connected. Memory cannot be persisted.' };
    }

    try {
      const memory = await MemoryModel.create({
        content: args.content,
        category: args.category || 'general',
        tags: args.tags || [],
        importance: args.importance || 3,
      });

      logger.info(`Saved new fact into long-term memory: "${args.content.substring(0, 50)}..."`);
      return { success: true, memoryId: memory._id.toString(), message: 'Fact remembered successfully.' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const searchMemoryTool: ToolDefinition = {
  name: 'search_memory',
  description: 'Search long-term memory for saved facts, preferences, contacts, or instructions.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Search query or keyword',
      },
      category: {
        type: 'string',
        enum: ['preference', 'fact', 'instruction', 'contact', 'general'],
        description: 'Optional category filter',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of memories to return (default: 10)',
      },
    },
  },
  handler: async (args: { query: string; category?: string; limit?: number }) => {
    if (!isDbConnected()) {
      return { success: false, error: 'Database is not connected.' };
    }

    try {
      const filter: any = {};
      if (args.category) {
        filter.category = args.category;
      }

      // Text search or regex fallback
      const regex = new RegExp(args.query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ content: regex }, { tags: regex }];

      const results = await MemoryModel.find(filter)
        .sort({ importance: -1, updatedAt: -1 })
        .limit(args.limit || 10);

      return {
        success: true,
        count: results.length,
        memories: results.map((m) => ({
          id: m._id.toString(),
          content: m.content,
          category: m.category,
          tags: m.tags,
          importance: m.importance,
          createdAt: m.createdAt,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const deleteMemoryTool: ToolDefinition = {
  name: 'delete_memory',
  description: 'Delete a specific memory by its memory ID.',
  parameters: {
    type: 'object',
    required: ['memoryId'],
    properties: {
      memoryId: {
        type: 'string',
        description: 'The ID of the memory to remove',
      },
    },
  },
  handler: async (args: { memoryId: string }) => {
    if (!isDbConnected()) {
      return { success: false, error: 'Database is not connected.' };
    }

    try {
      const res = await MemoryModel.findByIdAndDelete(args.memoryId);
      if (!res) {
        return { success: false, error: 'Memory not found.' };
      }
      return { success: true, message: 'Memory deleted successfully.' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};
