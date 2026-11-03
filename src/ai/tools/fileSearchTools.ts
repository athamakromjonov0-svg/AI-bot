import fs from 'fs';
import path from 'path';
import { ToolDefinition } from '../llm';
import { logger } from '../../config/logger';

/**
 * Directories that are never worth searching: huge, generated, or sensitive.
 * Keeping this list tight matters — a naive walk of the project root would
 * happily descend into node_modules and return thousands of useless hits.
 */
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'logs',
  'sessions',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
]);

const MAX_RESULTS = 50;
const MAX_DEPTH = 12;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // skip giant files when grepping

/**
 * Converts a simple glob (`*.log`, `report-*.txt`) into a RegExp.
 * Only `*` and `?` are treated as wildcards — enough for interactive use
 * without the complexity (and ReDoS risk) of a full glob engine.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Returns true when a file name matches the pattern (exact or glob). */
export function matchesPattern(fileName: string, pattern: string): boolean {
  if (!pattern) return true;
  if (pattern.includes('*') || pattern.includes('?')) {
    return globToRegExp(pattern).test(fileName);
  }
  // Bare text = substring match, which is what users actually expect.
  return fileName.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Recursively walks `rootDir` collecting files whose names match `pattern`.
 * Iterative (explicit stack) so a deep tree cannot blow the JS call stack.
 */
export function findFiles(
  rootDir: string,
  pattern: string,
  limit: number,
  ignoreDirs: Set<string> = DEFAULT_IGNORE_DIRS
): string[] {
  const results: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0 && results.length < limit) {
    const { dir, depth } = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Permission denied, vanished, etc. — skip silently, this is expected.
      continue;
    }

    for (const entry of entries) {
      if (results.length >= limit) break;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && matchesPattern(entry.name, pattern)) {
        results.push(full);
      }
    }
  }

  return results;
}

/** Searches file contents for a literal string (case-insensitive). */
export function grepFile(filePath: string, needle: string): { matches: number; samples: string[] } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) return { matches: 0, samples: [] };

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const lowerNeedle = needle.toLowerCase();

    let matches = 0;
    const samples: string[] = [];
    for (const line of lines) {
      if (line.toLowerCase().includes(lowerNeedle)) {
        matches++;
        if (samples.length < 3) samples.push(line.trim().slice(0, 200));
      }
    }
    return { matches, samples };
  } catch {
    return { matches: 0, samples: [] };
  }
}

export const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description:
    'Recursively search the computer for files by name pattern (glob like "*.log" or plain text), optionally filtering by file content. Use this to LOCATE a file when you only know part of its name — unlike manage_files, which only lists a folder you already know.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description:
          'File name pattern. Supports * and ? wildcards (e.g. "*.pdf", "budget-*"). Plain text matches any file containing it.',
      },
      rootDir: {
        type: 'string',
        description:
          'Directory to search from. Defaults to the user home directory. Narrow this for speed.',
      },
      content: {
        type: 'string',
        description:
          'Optional: only return files whose CONTENT contains this text (case-insensitive). Slower — use when name search is not enough.',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default 25, max 50).',
      },
    },
  },
  handler: async (args: {
    query: string;
    rootDir?: string;
    content?: string;
    limit?: number;
  }) => {
    try {
      if (!args.query || !args.query.trim()) {
        return { success: false, error: 'query is required.' };
      }

      const homeDir = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\user';
      const rootDir = path.resolve(args.rootDir || homeDir);

      if (!fs.existsSync(rootDir)) {
        return { success: false, error: `Root directory does not exist: ${rootDir}` };
      }

      const limit = Math.min(Math.max(args.limit || 25, 1), MAX_RESULTS);
      const started = Date.now();

      let found = findFiles(rootDir, args.query.trim(), limit * 3);

      // Optional content filter
      if (args.content && args.content.trim()) {
        const needle = args.content.trim();
        found = found
          .map((f) => ({ file: f, ...grepFile(f, needle) }))
          .filter((r) => r.matches > 0)
          .slice(0, limit)
          .map((r) => r.file);
      }

      found = found.slice(0, limit);
      const elapsedMs = Date.now() - started;

      if (found.length === 0) {
        return {
          success: true,
          count: 0,
          rootDir,
          elapsedMs,
          message: `No files matching "${args.query}" found under ${rootDir}. Try a broader pattern or a different rootDir.`,
        };
      }

      return {
        success: true,
        count: found.length,
        rootDir,
        elapsedMs,
        results: found.map((f) => {
          const stat = fs.statSync(f);
          return {
            path: f,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        }),
      };
    } catch (err: any) {
      logger.error('search_files failed:', err);
      return { success: false, error: err.message };
    }
  },
};
