import { ToolDefinition } from '../llm';

export const getCurrentTimeTool: ToolDefinition = {
  name: 'get_current_time',
  description: 'Returns the current server date and time, ISO format, and day of the week.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      formatted: now.toLocaleString('en-US', { timeZoneName: 'short' }),
      dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
      timestamp: now.getTime(),
    };
  },
};

export const calculateTool: ToolDefinition = {
  name: 'calculate',
  description: 'Evaluate a mathematical expression safely.',
  parameters: {
    type: 'object',
    required: ['expression'],
    properties: {
      expression: {
        type: 'string',
        description: 'The math expression to calculate (e.g. "45 * 12 + 100")',
      },
    },
  },
  handler: async (args: { expression: string }) => {
    try {
      // Safe math evaluator: only digits, spaces, parentheses, and standard operators
      const sanitized = args.expression.replace(/[^0-9+\-*/().%^ ]/g, '');
      // eslint-disable-next-line no-new-func
      const result = Function(`'use strict'; return (${sanitized})`)();
      return { success: true, expression: sanitized, result };
    } catch (err: any) {
      return { success: false, error: 'Invalid mathematical expression' };
    }
  },
};
