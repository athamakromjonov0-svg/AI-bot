import { globalToolRegistry } from './registry';
import {
  getAccountStatusTool,
  findRecipientTool,
  getDialogsTool,
  getChatHistoryTool,
  searchMessagesTool,
  sendMessageTool,
} from './telegramTools';
import { rememberFactTool, searchMemoryTool, deleteMemoryTool } from './memoryTools';
import { getCurrentTimeTool, calculateTool } from './utilityTools';
import {
  getPcStatusTool,
  executeTerminalCommandTool,
  openAppOrUrlTool,
  manageFilesTool,
  takePcScreenshotTool,
  lockPcTool,
} from './systemTools';
import { googleSearchTool, fetchWebpageTool } from './webSearchTools';
import {
  obsidianListNotesTool,
  obsidianReadNoteTool,
  obsidianCreateNoteTool,
  obsidianAppendNoteTool,
  obsidianSearchNotesTool,
} from './obsidianTools';
import {
  clipboardReadTool,
  clipboardWriteTool,
} from './systemTools';
import { searchFilesTool } from './fileSearchTools';
import {
  scheduleReminderTool,
  listRemindersTool,
  cancelReminderTool,
} from './schedulerTools';
import {
  addTaskTool,
  listTasksTool,
  completeTaskTool,
  removeTaskTool,
} from './taskTools';
import { logger } from '../../config/logger';

/**
 * Registration is idempotent: MCP's ListTools handler and the bootstrap both
 * call this, and re-registering produced an "Overwriting already registered"
 * warning for every tool on each call.
 */
let toolsInitialized = false;

export function initializeTools() {
  if (toolsInitialized) {
    logger.debug('initializeTools() called again — already initialized, skipping.');
    return;
  }
  toolsInitialized = true;

  // Telegram Tools
  globalToolRegistry.register(getAccountStatusTool);
  globalToolRegistry.register(findRecipientTool);
  globalToolRegistry.register(getDialogsTool);
  globalToolRegistry.register(getChatHistoryTool);
  globalToolRegistry.register(searchMessagesTool);
  globalToolRegistry.register(sendMessageTool);

  // Memory Tools
  globalToolRegistry.register(rememberFactTool);
  globalToolRegistry.register(searchMemoryTool);
  globalToolRegistry.register(deleteMemoryTool);

  // Utility Tools
  globalToolRegistry.register(getCurrentTimeTool);
  globalToolRegistry.register(calculateTool);

  // Laptop / PC Control Tools
  globalToolRegistry.register(getPcStatusTool);
  globalToolRegistry.register(executeTerminalCommandTool);
  globalToolRegistry.register(openAppOrUrlTool);
  globalToolRegistry.register(manageFilesTool);
  globalToolRegistry.register(takePcScreenshotTool);
  globalToolRegistry.register(lockPcTool);

  // Web & Google Search Tools
  globalToolRegistry.register(googleSearchTool);
  globalToolRegistry.register(fetchWebpageTool);

  // Obsidian Vault Tools
  globalToolRegistry.register(obsidianListNotesTool);
  globalToolRegistry.register(obsidianReadNoteTool);
  globalToolRegistry.register(obsidianCreateNoteTool);
  globalToolRegistry.register(obsidianAppendNoteTool);
  globalToolRegistry.register(obsidianSearchNotesTool);

  // Clipboard (bridge to whatever app the owner is using)
  globalToolRegistry.register(clipboardReadTool);
  globalToolRegistry.register(clipboardWriteTool);

  // File discovery
  globalToolRegistry.register(searchFilesTool);

  // Future actions (scheduler)
  globalToolRegistry.register(scheduleReminderTool);
  globalToolRegistry.register(listRemindersTool);
  globalToolRegistry.register(cancelReminderTool);

  // Persistent task list
  globalToolRegistry.register(addTaskTool);
  globalToolRegistry.register(listTasksTool);
  globalToolRegistry.register(completeTaskTool);
  globalToolRegistry.register(removeTaskTool);

  logger.info(`Initialized ToolRegistry with ${globalToolRegistry.getAll().length} tools.`);
}
