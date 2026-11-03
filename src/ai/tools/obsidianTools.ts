import fs from 'fs';
import path from 'path';
import { ToolDefinition } from '../llm';
import { config } from '../../config/env';
import { logger } from '../../config/logger';

function getVaultPath(): string {
  return path.resolve(config.OBSIDIAN_VAULT_PATH || path.join(process.env.USERPROFILE || 'C:\\Users\\user', 'Documents', 'Obsidian'));
}

/**
 * Helper to recursively list all markdown files in the vault.
 */
function getAllMarkdownFiles(dir: string, baseDir: string = dir): { relativePath: string; absolutePath: string; size: number; mtime: Date }[] {
  let results: { relativePath: string; absolutePath: string; size: number; mtime: Date }[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Ignore Obsidian internal config folder
    if (entry.name.startsWith('.obsidian')) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getAllMarkdownFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(fullPath);
      results.push({
        relativePath: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
        absolutePath: fullPath,
        size: stat.size,
        mtime: stat.mtime,
      });
    }
  }
  return results;
}

/**
 * 1. Tool: obsidian_list_notes
 */
export const obsidianListNotesTool: ToolDefinition = {
  name: 'obsidian_list_notes',
  description: 'Lists all markdown notes (.md) in your Obsidian vault with their relative paths, file size, and last modified date.',
  parameters: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: 'Optional subfolder inside vault to filter by (e.g. "Daily" or "Work").',
      },
    },
  },
  handler: async (args: { folder?: string }) => {
    try {
      const vault = getVaultPath();
      if (!fs.existsSync(vault)) {
        return { success: false, error: `Obsidian vault directory not found at: ${vault}` };
      }

      const targetDir = args.folder ? path.join(vault, args.folder) : vault;
      const notes = getAllMarkdownFiles(targetDir, vault);

      return {
        success: true,
        vaultPath: vault,
        count: notes.length,
        notes: notes.slice(0, 50).map((n) => ({
          path: n.relativePath,
          sizeBytes: n.size,
          lastModified: n.mtime.toLocaleString(),
        })),
      };
    } catch (err: any) {
      logger.error('[Obsidian] Failed to list notes:', err);
      return { success: false, error: err.message };
    }
  },
};

/**
 * 2. Tool: obsidian_read_note
 */
export const obsidianReadNoteTool: ToolDefinition = {
  name: 'obsidian_read_note',
  description: 'Reads the full content of a specific note in your Obsidian vault.',
  parameters: {
    type: 'object',
    required: ['notePath'],
    properties: {
      notePath: {
        type: 'string',
        description: 'The title or relative path of the note (e.g. "Reja", "Reja.md", or "Projects/Work.md").',
      },
    },
  },
  handler: async (args: { notePath: string }) => {
    try {
      const vault = getVaultPath();
      let normalized = args.notePath.endsWith('.md') ? args.notePath : `${args.notePath}.md`;
      let fullPath = path.join(vault, normalized);

      // If not directly found, search vault recursively for filename match
      if (!fs.existsSync(fullPath)) {
        const all = getAllMarkdownFiles(vault);
        const found = all.find((f) => path.basename(f.relativePath).toLowerCase() === path.basename(normalized).toLowerCase());
        if (found) {
          fullPath = found.absolutePath;
          normalized = found.relativePath;
        } else {
          return { success: false, error: `Note "${args.notePath}" not found in vault: ${vault}` };
        }
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      return {
        success: true,
        notePath: normalized,
        characterCount: content.length,
        content: content.length > 5000 ? content.substring(0, 5000) + '\n...[truncated]' : content,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

/**
 * 3. Tool: obsidian_create_note
 */
export const obsidianCreateNoteTool: ToolDefinition = {
  name: 'obsidian_create_note',
  description: 'Creates a new markdown note in your Obsidian vault. Automatically creates folders if needed.',
  parameters: {
    type: 'object',
    required: ['title', 'content'],
    properties: {
      title: {
        type: 'string',
        description: 'Title or relative path of the new note (e.g. "Goyalar/YangiReja.md" or "Kun tartibi").',
      },
      content: {
        type: 'string',
        description: 'The markdown text content of the note.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags to append in YAML frontmatter or content (e.g. ["reja", "muhim"]).',
      },
    },
  },
  handler: async (args: { title: string; content: string; tags?: string[] }) => {
    try {
      const vault = getVaultPath();
      if (!fs.existsSync(vault)) {
        fs.mkdirSync(vault, { recursive: true });
      }

      let filename = args.title.trim();
      if (!filename.endsWith('.md')) filename += '.md';
      const targetPath = path.join(vault, filename);

      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      let finalContent = args.content;
      if (args.tags && args.tags.length > 0) {
        const tagLine = '\n\n' + args.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
        finalContent += tagLine;
      }

      fs.writeFileSync(targetPath, finalContent, 'utf8');
      logger.info(`[Obsidian] Created note at: ${targetPath}`);

      return {
        success: true,
        message: `Obsidian-da "${filename}" eslatmasi muvaffaqiyatli yaratildi.`,
        notePath: filename,
        fullPath: targetPath,
      };
    } catch (err: any) {
      logger.error('[Obsidian] Failed to create note:', err);
      return { success: false, error: err.message };
    }
  },
};

/**
 * 4. Tool: obsidian_append_note
 */
export const obsidianAppendNoteTool: ToolDefinition = {
  name: 'obsidian_append_note',
  description: 'Appends text, checklists, or notes to an existing Obsidian note.',
  parameters: {
    type: 'object',
    required: ['notePath', 'content'],
    properties: {
      notePath: {
        type: 'string',
        description: 'The note title or path to append to.',
      },
      content: {
        type: 'string',
        description: 'Content to append at the end of the note.',
      },
      addTimestamp: {
        type: 'boolean',
        description: 'Whether to prepend current timestamp before the content (default: true).',
      },
    },
  },
  handler: async (args: { notePath: string; content: string; addTimestamp?: boolean }) => {
    try {
      const vault = getVaultPath();
      let normalized = args.notePath.endsWith('.md') ? args.notePath : `${args.notePath}.md`;
      let fullPath = path.join(vault, normalized);

      if (!fs.existsSync(fullPath)) {
        const all = getAllMarkdownFiles(vault);
        const found = all.find((f) => path.basename(f.relativePath).toLowerCase() === path.basename(normalized).toLowerCase());
        if (found) {
          fullPath = found.absolutePath;
        } else {
          // If not found, create new
          const targetDir = path.dirname(fullPath);
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(fullPath, '', 'utf8');
        }
      }

      const timestamp = (args.addTimestamp ?? true) ? `\n\n> *[${new Date().toLocaleString()}]*\n` : '\n\n';
      fs.appendFileSync(fullPath, `${timestamp}${args.content}`, 'utf8');

      return {
        success: true,
        message: `Obsidian "${normalized}" eslatmasiga yangi ma'lumot qo'shildi.`,
        notePath: normalized,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

/**
 * 5. Tool: obsidian_search_notes
 */
export const obsidianSearchNotesTool: ToolDefinition = {
  name: 'obsidian_search_notes',
  description: 'Searches all notes in your Obsidian vault for specific keywords or phrases.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'The keyword, tag, or phrase to search for inside Obsidian notes.',
      },
    },
  },
  handler: async (args: { query: string }) => {
    try {
      const vault = getVaultPath();
      const all = getAllMarkdownFiles(vault);
      const q = args.query.toLowerCase();

      const matches: { notePath: string; snippet: string }[] = [];

      for (const note of all) {
        try {
          const content = fs.readFileSync(note.absolutePath, 'utf8');
          const lower = content.toLowerCase();
          const idx = lower.indexOf(q);

          if (idx !== -1 || note.relativePath.toLowerCase().includes(q)) {
            const start = Math.max(0, idx - 50);
            const end = Math.min(content.length, idx + 100);
            const snippet = idx !== -1 ? `...${content.substring(start, end).replace(/\n/g, ' ')}...` : '(Sarlavhada topildi)';

            matches.push({
              notePath: note.relativePath,
              snippet,
            });
          }
        } catch (_) {}
      }

      return {
        success: true,
        query: args.query,
        count: matches.length,
        results: matches.slice(0, 10),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};
