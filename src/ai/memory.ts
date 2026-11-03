import { getLLMClient } from './llm';
import { MemoryModel } from '../database/models/Memory';
import { isDbConnected } from '../database';
import { logger } from '../config/logger';
import { config } from '../config/env';

export async function extractAndStoreFacts(userMessage: string, assistantReply: string): Promise<void> {
  if (!isDbConnected() || !config.LLM_API_KEY) return;

  // Simple heuristic: only trigger if message contains potential key facts/preferences
  const indicators = ['my name is', 'i prefer', 'remember that', 'important', 'contact', 'phone', 'email', 'я люблю', 'помни', 'мое имя', 'мени исмим'];
  const hasIndicator = indicators.some((ind) => userMessage.toLowerCase().includes(ind));

  if (!hasIndicator && userMessage.length < 20) return;

  try {
    const client = getLLMClient();
    const prompt = `Analyze this user message and determine if there is any permanent personal preference, contact information, project instruction, or important fact worth remembering for future conversations.
User: "${userMessage}"
Assistant: "${assistantReply}"

If there is a valuable fact, return JSON in this exact format:
{
  "hasFact": true,
  "content": "concise factual summary to remember",
  "category": "preference" | "fact" | "instruction" | "contact" | "general",
  "tags": ["tag1", "tag2"],
  "importance": 1-5
}
If there is nothing important to remember, return:
{ "hasFact": false }
Return ONLY valid JSON.`;

    const response = await client.chat.completions.create({
      model: config.LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const text = response.choices[0]?.message?.content;
    if (!text) return;

    const parsed = JSON.parse(text);
    if (parsed.hasFact && parsed.content) {
      await MemoryModel.create({
        content: parsed.content,
        category: parsed.category || 'general',
        tags: parsed.tags || [],
        importance: parsed.importance || 3,
      });
      logger.info(`Auto-extracted memory fact: "${parsed.content}"`);
    }
  } catch (err) {
    logger.debug('Memory auto-extraction skipped or failed:', err);
  }
}
