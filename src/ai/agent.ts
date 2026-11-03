import { getLLMClient, ChatMessage } from './llm';
import { globalToolRegistry } from './tools/registry';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { ConversationModel } from '../database/models/Conversation';
import { MemoryModel } from '../database/models/Memory';
import { isDbConnected } from '../database';
import { extractAndStoreFacts } from './memory';

// In-memory fallback if MongoDB is not connected
const inMemoryConversations = new Map<string, ChatMessage[]>();

const SYSTEM_PROMPT = `You are Atham's personal AI Assistant and Windows Notebook Copilot.
You can execute tasks directly on his Windows notebook (laptop) and communicate through Telegram.

Capabilities & Tools:
1. Notebook & Windows Control:
   - get_pc_status: Check laptop battery, charging state, RAM usage, C: drive space, and uptime.
   - execute_terminal_command: Run PowerShell or CMD commands on the laptop.
   - open_app_or_url: Launch applications (Chrome, Notepad, VS Code, Telegram, Calculator) or web URLs.
   - manage_files: List directory files, read file contents, or write files on the laptop.
   - take_pc_screenshot: Capture the current screen of the notebook and send it to the Telegram chat.
   - lock_pc: Lock the Windows workstation immediately.

2. Real-Time Web & Google Search:
   - google_search: Search Google and the web for any real-time news, information, weather, currency rates, facts, or guides.
   - fetch_webpage: Read and extract full article/text from any website URL.

3. Telegram Management:
   - get_dialogs: View recent private chats, groups, and channels.
   - get_chat_history: Read messages from any conversation.
   - search_messages: Search for messages across chats.
   - send_message: Only send messages when explicitly commanded by the owner.

3. Long-term Memory:
   - remember_fact: Store important facts, preferences, instructions.
   - search_memory: Retrieve saved knowledge.

4. Obsidian Vault (Notes):
   - obsidian_list_notes: List notes in the Obsidian vault.
   - obsidian_read_note: Read a note by title or path.
   - obsidian_create_note: Create a new note (with optional tags).
   - obsidian_append_note: Append text to an existing note.
   - obsidian_search_notes: Full-text search across the vault.
   Use these whenever Atham asks about his notes, plans, diary or knowledge base.

5. FUTURE ACTIONS (Act Later — use proactively):
   - schedule_reminder: Schedule a reminder for a future time (use "at" for an absolute time, or inMinutes/inHours/inDays for a relative delay; optional repeatMinutes for repeating reminders). USE THIS whenever Atham says "remind me", "call me at", "tell me later", "don't let me forget", or mentions any deadline or planned event. Always confirm the exact fire time back to him.
   - list_reminders: Show all scheduled reminders.
   - cancel_reminder: Cancel a reminder by its ID.
   - add_task / list_tasks / complete_task / remove_task: A persistent task list. USE add_task when Atham gives you multi-step work or anything that must survive across conversations, and mark items done with complete_task as you finish them. Always check list_tasks first when he asks "what's on my list".

6. DESKTOP BRIDGE:
   - search_files: Recursively find files by name pattern (glob like "*.pdf" or plain text) and/or by content. Use this to LOCATE a file when you only know part of its name — manage_files only lists a folder you already know.
   - clipboard_read / clipboard_write: Read or write the Windows clipboard. Use clipboard_write to hand Atham text he can paste into any app.

7. MUTLAQ XAVFSIZLIK QOIDALARI (CRITICAL SAFETY RULES):
   - Siz HECH QACHON o'zingizcha yoki avtomatik tarzda begona kontaktlarga, odamlarga yoki guruhlarga xabar YOZMANG!
   - send_message vositasidan FAQAT VA FAQAT Athamning o'zi aniq: "Falonchiga mana bunday deb yoz", "Xabar jo'nat", "Javob qaytar" deb buyruq berganidagina foydalaning.
   - Agar Atham shunchaki "Falonchi nima debdi?", "Chatni o'qi", "Suhbatlarni ko'rsat", "Qidir" desa — faqat get_dialogs, get_chat_history yoki search_messages orqali ma'lumotni o'qib, natijani FAQAT Athamning o'ziga Telegram Botda ayting. Uchinchi shaxslarga aslo xabar yubormang!
   - Xabarlar jo'natishda doim Atham bergan ko'rsatmaga qat'iy amal qiling.
   - Tez va aniq ishlang (Be FAST and CONCISE).
   - Javoblarni doimo muloyim, tushunarli va o'zbek tilida bering.
`;

/**
 * Repairs a message sequence so it satisfies the provider contract that Gemini
 * enforces strictly: an assistant turn carrying `tool_calls` must come right
 * after a user turn or a function-response turn, and every `tool_call` must be
 * answered by exactly one `tool` message.
 *
 * History is persisted with a fixed-size slice, which can cut a tool-call group
 * in half and orphan its responses. Gemini answers that with:
 *   400 ... function call turn comes immediately after a user turn or after a
 *   function response turn.
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  // The body must begin at a user turn; anything before it that is not a
  // system message would be an orphaned fragment.
  const firstUser = messages.findIndex((m) => m.role === 'user');
  const systemPrefix =
    firstUser === -1 ? messages.filter((m) => m.role === 'system') : messages.slice(0, firstUser).filter((m) => m.role === 'system');
  const body = firstUser === -1 ? [] : messages.slice(firstUser);

  const out: ChatMessage[] = [];
  const pending = new Set<string>(); // tool_call ids still awaiting a response

  const closePending = () => {
    for (const id of pending) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        name: 'unknown',
        content: JSON.stringify({
          error: true,
          message: 'Tool response was missing from stored history.',
        }),
      });
    }
    pending.clear();
  };

  for (const m of body) {
    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (id && pending.has(id)) {
        pending.delete(id);
        out.push(m);
      }
      // Orphaned response with no matching call → drop it, Gemini rejects it.
      continue;
    }

    const hasCalls = m.role === 'assistant' && !!m.tool_calls && m.tool_calls.length > 0;
    if (hasCalls) {
      closePending(); // answer anything left dangling before a new call turn
      out.push(m);
      for (const tc of m.tool_calls || []) {
        if (tc && tc.id) pending.add(tc.id);
      }
      continue;
    }

    // user turn or plain assistant text: must not follow unanswered calls
    closePending();
    out.push(m);
  }

  // Trailing unanswered calls (loop aborted mid-turn) still need responses.
  closePending();

  return [...systemPrefix, ...out];
}

export class AgentService {
  /**
   * Main entrypoint for processing user messages through the AI ReAct loop.
   */
  public static async processMessage(
    sessionId: string,
    userId: number,
    userPrompt: string,
    chatId?: string
  ): Promise<string> {
    const client = getLLMClient();
    if (!config.LLM_API_KEY) {
      return '⚠️ LLM API Key is not configured. Please set `LLM_API_KEY` in your `.env` file to enable AI capabilities.';
    }

    // 1. Retrieve or initialize conversation history
    const history: ChatMessage[] = await this.getHistory(sessionId, userId, chatId);

    // 2. Fetch relevant memories to enrich context
    let memoryContext = '';
    if (isDbConnected()) {
      try {
        const topMemories = await MemoryModel.find()
          .sort({ importance: -1, updatedAt: -1 })
          .limit(5);
        if (topMemories.length > 0) {
          memoryContext = `\n[Known User Facts & Preferences]:\n` +
            topMemories.map((m) => `- ${m.content} (Category: ${m.category})`).join('\n');
        }
      } catch (err) {
        logger.debug('Failed to fetch memories for context:', err);
      }
    }

    // Prepare system message
    const systemMessage: ChatMessage = {
      role: 'system',
      content: `${SYSTEM_PROMPT}${memoryContext}`,
    };

    // Append user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: userPrompt,
    };
    history.push(userMessage);

    const activeMessages: ChatMessage[] = [systemMessage, ...history];
    const tools = globalToolRegistry.getOpenAITools();

    let stepCount = 0;
    const maxSteps = config.LLM_MAX_STEPS;
    let finalAnswer = '';

    // ReAct Loop with step limit & safeguards
    while (stepCount < maxSteps) {
      stepCount++;
      logger.debug(`[Agent] ReAct iteration step ${stepCount}/${maxSteps}`);

      try {
        // Repair the stored sequence before every request — Gemini validates
        // tool-call/response pairing strictly.
        const requestMessages = sanitizeMessages(activeMessages);

        const completion = await client.chat.completions.create({
          model: config.LLM_MODEL,
          messages: requestMessages as any,
          tools: tools.length > 0 ? (tools as any) : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
          temperature: 0.7,
        });

        const choice = completion.choices[0];
        const message = choice.message;

        // If the LLM requests tool execution (Function Calling)
        if (message.tool_calls && message.tool_calls.length > 0) {
          // Add assistant message with tool calls to active history
          activeMessages.push(message as any);
          history.push(message as any);

          for (const toolCall of message.tool_calls) {
            // Narrow the union first: only function calls carry .function.
            const isFunctionCall =
              toolCall.type === 'function' && !!toolCall.id && !!(toolCall as any).function;

            const toolName = isFunctionCall
              ? (toolCall as any).function.name || 'unknown'
              : 'unknown';
            let toolArgs: any = {};

            // A skipped tool call leaves an unanswered tool_call, which Gemini
            // rejects on the next request. Always answer, even for a malformed
            // or non-function call.
            if (!isFunctionCall) {
              const malformed: ChatMessage = {
                role: 'tool',
                tool_call_id: toolCall.id || `malformed_${stepCount}`,
                name: toolName,
                content: JSON.stringify({
                  error: true,
                  message: 'Malformed or unsupported tool call — it was answered but not executed.',
                }),
              };
              activeMessages.push(malformed);
              history.push(malformed);
              continue;
            }

            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch (parseErr) {
              logger.error(`Failed to parse tool arguments for ${toolName}:`, parseErr);
              toolArgs = {};
            }

            // Execute tool safely with timeout
            const toolResult = await globalToolRegistry.execute(toolName, toolArgs, {
              sessionId,
              userId,
              chatId,
            });

            // Format response as tool message
            const toolMessage: ChatMessage = {
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolName,
              content: JSON.stringify(toolResult),
            };

            activeMessages.push(toolMessage);
            history.push(toolMessage);
          }

          // Continue loop to allow LLM to inspect results
          continue;
        }

        // Final answer received
        finalAnswer = message.content || 'Done.';
        const assistantFinalMessage: ChatMessage = {
          role: 'assistant',
          content: finalAnswer,
        };
        history.push(assistantFinalMessage);
        break;
      } catch (error: any) {
        logger.error(`[Agent] Error in LLM step ${stepCount}:`, error);
        finalAnswer = `⚠️ Error during agent reasoning: ${error.message || 'Unknown error'}`;
        break;
      }
    }

    if (stepCount >= maxSteps && !finalAnswer) {
      finalAnswer = '⚠️ Agent reached maximum execution step limit without completing the task.';
    }

    // Save updated history
    await this.saveHistory(sessionId, userId, history, chatId);

    // Trigger background fact extraction
    setImmediate(() => {
      extractAndStoreFacts(userPrompt, finalAnswer).catch((e) =>
        logger.debug('Background fact extraction error:', e)
      );
    });

    return finalAnswer;
  }

  private static async getHistory(sessionId: string, userId: number, chatId?: string): Promise<ChatMessage[]> {
    if (isDbConnected()) {
      try {
        const conv = await ConversationModel.findOne({ sessionId });
        if (conv && conv.messages) {
          // Return last 30 messages to keep context window manageable
          return conv.messages.slice(-30).map((m) => ({
            role: m.role,
            content: m.content,
            name: m.name,
            tool_call_id: m.tool_call_id,
            tool_calls: m.tool_calls,
          }));
        }
      } catch (err) {
        logger.warn('Failed to load conversation from database:', err);
      }
    }

    return inMemoryConversations.get(sessionId) || [];
  }

  private static async saveHistory(
    sessionId: string,
    userId: number,
    messages: ChatMessage[],
    chatId?: string
  ): Promise<void> {
    const trimmed = messages.slice(-40);

    if (isDbConnected()) {
      try {
        await ConversationModel.findOneAndUpdate(
          { sessionId },
          {
            userId,
            chatId,
            messages: trimmed.map((m) => ({
              role: m.role,
              content: m.content || '',
              name: m.name,
              tool_call_id: m.tool_call_id,
              tool_calls: m.tool_calls,
              timestamp: new Date(),
            })),
          },
          { upsert: true, new: true }
        );
        return;
      } catch (err) {
        logger.warn('Failed to save conversation to database:', err);
      }
    }

    inMemoryConversations.set(sessionId, trimmed);
  }
}
