import crypto from 'crypto';
import { ToolDefinition } from '../llm';
import { config } from '../../config/env';
import { isDbConnected } from '../../database';
import { TaskModel, ITask } from '../../database/models/Task';

/**
 * In-memory fallback when MongoDB is down, so the agent keeps a working
 * checklist even offline (mirrors the scheduler's approach).
 */
const localTasks = new Map<string, ITask>();

function resolveOwner(): number {
  return config.OWNER_TELEGRAM_ID || 0;
}

function normalizeStatusFilter(status?: string): 'pending' | 'done' | undefined {
  if (status === 'pending' || status === 'done') return status;
  return undefined;
}

export const addTaskTool: ToolDefinition = {
  name: 'add_task',
  description:
    'Add an item to the persistent task list. Use this to track multi-step work or anything the owner asked to be reminded to do, so progress survives across conversations.',
  parameters: {
    type: 'object',
    required: ['title'],
    properties: {
      title: {
        type: 'string',
        description: 'Short task title (what needs to be done).',
      },
      details: {
        type: 'string',
        description: 'Optional longer description or steps.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'Priority level (default: normal).',
      },
      dueAt: {
        type: 'string',
        description: 'Optional due date as ISO 8601.',
      },
    },
  },
  handler: async (args: any) => {
    try {
      if (!args.title || !String(args.title).trim()) {
        return { success: false, error: 'title is required.' };
      }

      const taskId = crypto.randomUUID().slice(0, 8);
      const record: Partial<ITask> = {
        taskId,
        title: String(args.title).trim(),
        details: args.details ? String(args.details) : undefined,
        priority: ['low', 'normal', 'high'].includes(args.priority) ? args.priority : 'normal',
        status: 'pending',
        createdBy: resolveOwner(),
      };

      if (args.dueAt) {
        const due = new Date(args.dueAt);
        if (Number.isNaN(due.getTime())) {
          return { success: false, error: `Invalid dueAt: ${args.dueAt}` };
        }
        record.dueAt = due;
      }

      if (isDbConnected()) {
        await TaskModel.create(record);
      } else {
        localTasks.set(taskId, record as ITask);
      }

      return {
        success: true,
        taskId,
        persistent: isDbConnected(),
        message: `Added task: ${record.title}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const listTasksTool: ToolDefinition = {
  name: 'list_tasks',
  description: 'List tasks from the persistent task list, optionally filtered by status.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'done'],
        description: 'Filter by status (default: pending).',
      },
    },
  },
  handler: async (args: { status?: string }) => {
    try {
      const status = normalizeStatusFilter(args?.status) || 'pending';
      let items: ITask[];

      if (isDbConnected()) {
        items = await TaskModel.find({ status }).sort({ priority: -1, dueAt: 1, createdAt: 1 }).limit(50);
      } else {
        items = Array.from(localTasks.values()).filter((t) => t.status === status);
      }

      if (items.length === 0) return { success: true, count: 0, tasks: [] };

      return {
        success: true,
        count: items.length,
        tasks: items.map((t) => ({
          id: t.taskId,
          title: t.title,
          details: t.details || null,
          priority: t.priority,
          dueAt: t.dueAt ? t.dueAt.toISOString() : null,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const completeTaskTool: ToolDefinition = {
  name: 'complete_task',
  description: 'Mark a task as done by its ID. Use list_tasks to find the ID.',
  parameters: {
    type: 'object',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', description: 'The ID of the task to mark done.' },
    },
  },
  handler: async (args: { taskId: string }) => {
    try {
      const id = args.taskId;

      if (isDbConnected()) {
        const res = await TaskModel.updateOne(
          { taskId: id, status: 'pending' },
          { status: 'done', completedAt: new Date() }
        );
        if (res.modifiedCount > 0) return { success: true, message: `Completed task ${id}.` };
      } else {
        const t = localTasks.get(id);
        if (t) {
          t.status = 'done';
          t.completedAt = new Date();
          localTasks.delete(id);
          return { success: true, message: `Completed task ${id}.` };
        }
      }

      return { success: false, error: `No pending task found with id ${id}.` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

export const removeTaskTool: ToolDefinition = {
  name: 'remove_task',
  description: 'Delete a task permanently by its ID without marking it done.',
  parameters: {
    type: 'object',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', description: 'The ID of the task to delete.' },
    },
  },
  handler: async (args: { taskId: string }) => {
    try {
      const id = args.taskId;

      if (isDbConnected()) {
        const res = await TaskModel.deleteOne({ taskId: id });
        if (res.deletedCount > 0) return { success: true, message: `Removed task ${id}.` };
      } else if (localTasks.delete(id)) {
        return { success: true, message: `Removed task ${id}.` };
      }

      return { success: false, error: `No task found with id ${id}.` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};
