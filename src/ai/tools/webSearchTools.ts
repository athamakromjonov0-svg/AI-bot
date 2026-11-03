import { ToolDefinition } from '../llm';
import { logger } from '../../config/logger';

export interface SearchResultItem {
  title: string;
  snippet: string;
  url: string;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * 1. Tool: google_search
 * Searches the web in real-time and returns relevant results.
 */
export const googleSearchTool: ToolDefinition = {
  name: 'google_search',
  description: 'Search Google and the web in real-time for any topic, news, weather, facts, or questions. Returns titles, snippets, and links.',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'The search keywords or question to search on the web.',
      },
      limit: {
        type: 'number',
        description: 'Number of results to return (default: 5, max: 10).',
      },
    },
  },
  handler: async (args: { query: string; limit?: number }) => {
    try {
      const maxResults = Math.min(args.limit || 5, 10);
      logger.info(`[WebSearch] Searching for: "${args.query}" (limit: ${maxResults})`);

      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'uz,ru,en;q=0.9',
        },
      });

      if (!res.ok) {
        return { success: false, error: `Search request failed with status: ${res.status}` };
      }

      const html = await res.text();

      const titles = [...html.matchAll(/class="result__a"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
        decodeHtmlEntities(m[1])
      );

      const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
        decodeHtmlEntities(m[1])
      );

      const urls = [...html.matchAll(/class="result__snippet"[^>]*href="([^"]+)"/g)].map((m) => {
        let u = m[1];
        const match = u.match(/uddg=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : u;
      });

      const items: SearchResultItem[] = [];
      const count = Math.min(titles.length, maxResults);

      for (let i = 0; i < count; i++) {
        if (titles[i]) {
          items.push({
            title: titles[i],
            snippet: snippets[i] || '',
            url: urls[i] || '',
          });
        }
      }

      if (items.length === 0) {
        return { success: true, message: `No direct search results found for: "${args.query}"`, results: [] };
      }

      return { success: true, count: items.length, results: items };
    } catch (err: any) {
      logger.error('[WebSearch] Error during web search:', err);
      return { success: false, error: err.message };
    }
  },
};

/**
 * 2. Tool: fetch_webpage
 * Fetches the readable text content of a specific webpage URL.
 */
export const fetchWebpageTool: ToolDefinition = {
  name: 'fetch_webpage',
  description: 'Fetches and extracts clean readable text content from any website URL for deeper reading.',
  parameters: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP or HTTPS URL of the webpage to fetch.',
      },
    },
  },
  handler: async (args: { url: string }) => {
    try {
      if (!args.url || !args.url.startsWith('http')) {
        return { success: false, error: 'A valid http/https URL is required.' };
      }

      logger.info(`[WebFetch] Fetching webpage: ${args.url}`);
      const res = await fetch(args.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return { success: false, error: `Failed to load page: HTTP ${res.status} ${res.statusText}` };
      }

      const html = await res.text();

      // Clean HTML to readable text
      const cleanText = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
        .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

      const truncated = cleanText.length > 4000 ? cleanText.substring(0, 4000) + '\n...[truncated]' : cleanText;

      return {
        success: true,
        url: args.url,
        contentLength: cleanText.length,
        text: truncated,
      };
    } catch (err: any) {
      logger.error(`[WebFetch] Error fetching URL ${args.url}:`, err);
      return { success: false, error: err.message };
    }
  },
};
