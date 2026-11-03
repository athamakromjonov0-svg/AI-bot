import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ToolDefinition } from '../llm';
import { logger } from '../../config/logger';
import { getBot } from '../../telegram/bot';
import { InputFile } from 'grammy';

const execAsync = util.promisify(exec);

/**
 * Executes a multi-line PowerShell script safely using UTF-16LE Base64 encoding.
 */
async function runPowerShell(script: string, timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execAsync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`, {
    timeout: timeoutMs,
  });
}

/**
 * 1. Tool: get_pc_status
 * Checks battery, RAM, CPU, disk, uptime on the notebook.
 */
export const getPcStatusTool: ToolDefinition = {
  name: 'get_pc_status',
  description: 'Gets current Windows laptop status: battery percentage, charging state, RAM usage, C: drive space, and uptime.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const psScript = `
        $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
        $os = Get-CimInstance Win32_OperatingSystem
        $drive = Get-PSDrive C
        
        # NOTE: Windows PowerShell 5.1 rejects \`if\` used as a value inside a
        # hashtable literal, so resolve the values into variables first.
        if ($battery) {
          $batteryPercentage = $battery.EstimatedChargeRemaining
          if ($battery.BatteryStatus -eq 2) {
            $batteryStatus = 'Charging / Plugged in'
          } else {
            $batteryStatus = 'On Battery'
          }
        } else {
          $batteryPercentage = 'N/A'
          $batteryStatus = 'Desktop or Battery not detected'
        }

        $batteryInfo = @{
          Percentage = $batteryPercentage
          Status = $batteryStatus
        }

        $totalRamGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
        $freeRamGB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
        $usedRamGB = [math]::Round($totalRamGB - $freeRamGB, 2)
        
        $driveFreeGB = [math]::Round($drive.Free / 1GB, 2)
        $driveTotalGB = [math]::Round(($drive.Used + $drive.Free) / 1GB, 2)

        $uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)

        [PSCustomObject]@{
          ComputerName = $env:COMPUTERNAME
          User = $env:USERNAME
          Battery = $batteryInfo
          RAM_Total_GB = $totalRamGB
          RAM_Used_GB = $usedRamGB
          RAM_Free_GB = $freeRamGB
          Drive_C_Free_GB = $driveFreeGB
          Drive_C_Total_GB = $driveTotalGB
          Uptime_Hours = $uptimeHours
        } | ConvertTo-Json -Compress
      `;

      const { stdout } = await runPowerShell(psScript);
      const result = JSON.parse(stdout.trim());
      return { success: true, status: result };
    } catch (err: any) {
      logger.error('Failed to get PC status:', err);
      return {
        success: false,
        error: err.message,
        fallback: {
          platform: os.platform(),
          freeMemGB: (os.freemem() / (1024 * 1024 * 1024)).toFixed(2),
          totalMemGB: (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2),
          uptimeHours: (os.uptime() / 3600).toFixed(1),
        },
      };
    }
  },
};

/**
 * 2. Tool: execute_terminal_command
 * Runs a PowerShell or CMD command on the notebook.
 */
export const executeTerminalCommandTool: ToolDefinition = {
  name: 'execute_terminal_command',
  description: 'Runs a shell or PowerShell command on the Windows notebook and returns standard output and error.',
  parameters: {
    type: 'object',
    required: ['command'],
    properties: {
      command: {
        type: 'string',
        description: 'The PowerShell or CMD command to execute on the laptop.',
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Execution timeout in seconds (default: 20 seconds).',
      },
    },
  },
  handler: async (args: { command: string; timeoutSeconds?: number }) => {
    try {
      const timeout = (args.timeoutSeconds || 20) * 1000;
      logger.info(`[PC Control] Executing command: ${args.command}`);
      const { stdout, stderr } = await execAsync(args.command, {
        timeout,
        shell: 'powershell.exe',
      });

      return {
        success: true,
        stdout: stdout.length > 3000 ? stdout.substring(0, 3000) + '\n...[truncated]' : stdout,
        stderr: stderr.length > 1000 ? stderr.substring(0, 1000) + '\n...[truncated]' : stderr,
      };
    } catch (err: any) {
      logger.error(`[PC Control] Command error: ${err.message}`);
      return {
        success: false,
        error: err.message,
        stdout: err.stdout?.substring?.(0, 1000) || '',
        stderr: err.stderr?.substring?.(0, 1000) || '',
      };
    }
  },
};

/**
 * 3. Tool: open_app_or_url
 * Opens an app, folder, file, or website on the notebook.
 */
export const openAppOrUrlTool: ToolDefinition = {
  name: 'open_app_or_url',
  description: 'Opens an application (e.g. chrome, notepad, telegram, calc), file, folder, or website URL on the notebook.',
  parameters: {
    type: 'object',
    required: ['target'],
    properties: {
      target: {
        type: 'string',
        description: 'The application name (e.g. notepad, chrome, code), file path, or URL (e.g. https://google.com).',
      },
    },
  },
  handler: async (args: { target: string }) => {
    try {
      logger.info(`[PC Control] Opening target: ${args.target}`);
      // Use -EncodedCommand so the target is never interpolated into a shell
      // string (avoids quoting breakage and command injection).
      const openScript = `Start-Process -FilePath '${String(args.target).replace(/'/g, "''")}'`;
      await runPowerShell(openScript, 15000);
      return { success: true, message: `Successfully opened "${args.target}" on notebook.` };
    } catch (err: any) {
      logger.error(`[PC Control] Failed to open target: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

/**
 * 4. Tool: manage_files
 * Reads, lists, or writes files on the notebook.
 */
export const manageFilesTool: ToolDefinition = {
  name: 'manage_files',
  description: 'Manage files on the notebook: list files in a folder, read a file, or write to a file.',
  parameters: {
    type: 'object',
    required: ['action', 'filePath'],
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'write'],
        description: 'The file action to perform: list directory, read file, or write file.',
      },
      filePath: {
        type: 'string',
        description: 'Absolute or relative path to the directory or file.',
      },
      content: {
        type: 'string',
        description: 'Text content to write (required if action is "write").',
      },
    },
  },
  handler: async (args: { action: 'list' | 'read' | 'write'; filePath: string; content?: string }) => {
    try {
      const targetPath = path.resolve(args.filePath);

      if (args.action === 'list') {
        if (!fs.existsSync(targetPath)) {
          return { success: false, error: `Path does not exist: ${targetPath}` };
        }
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        const list = entries.slice(0, 50).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }));
        return { success: true, path: targetPath, count: list.length, items: list };
      }

      if (args.action === 'read') {
        if (!fs.existsSync(targetPath)) {
          return { success: false, error: `File not found: ${targetPath}` };
        }
        const content = fs.readFileSync(targetPath, 'utf8');
        return {
          success: true,
          path: targetPath,
          content: content.length > 4000 ? content.substring(0, 4000) + '\n...[truncated]' : content,
        };
      }

      if (args.action === 'write') {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, args.content || '', 'utf8');
        return { success: true, message: `File written successfully to ${targetPath}` };
      }

      return { success: false, error: `Unknown action: ${args.action}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

/**
 * 5. Tool: take_pc_screenshot
 * Takes a screenshot of the notebook screen and sends it to the owner on Telegram!
 */
export const takePcScreenshotTool: ToolDefinition = {
  name: 'take_pc_screenshot',
  description: 'Takes a screenshot of the notebook screen and sends it directly as a photo to the Telegram chat.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args: any, context?: any) => {
    try {
      const tempDir = os.tmpdir();
      const filename = `screenshot_${Date.now()}.png`;
      const screenshotPath = path.join(tempDir, filename);

      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
      `;

      await runPowerShell(psScript);

      if (!fs.existsSync(screenshotPath)) {
        return { success: false, error: 'Screenshot file was not generated.' };
      }

      const bot = getBot();
      const targetChatId = context?.chatId;

      if (bot && targetChatId) {
        await bot.api.sendPhoto(targetChatId, new InputFile(screenshotPath), {
          caption: `📸 Notebook ekrani holati (${new Date().toLocaleTimeString()})`,
        });

        // Clean up file after a short delay
        setTimeout(() => {
          try {
            if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
          } catch (_) {}
        }, 5000);

        return { success: true, message: 'Screenshot captured and sent to Telegram.' };
      }

      return {
        success: true,
        message: `Screenshot saved at ${screenshotPath}, but could not send to Telegram (bot or chatId missing).`,
        path: screenshotPath,
      };
    } catch (err: any) {
      logger.error('Failed to take screenshot:', err);
      return { success: false, error: err.message };
    }
  },
};

/**
 * 6. Tool: lock_pc
 * Locks the notebook screen (Lock Workstation).
 */
export const lockPcTool: ToolDefinition = {
  name: 'lock_pc',
  description: 'Locks the Windows laptop session screen immediately.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      await execAsync('rundll32.exe user32.dll,LockWorkStation');
      return { success: true, message: 'Notebook ekrani muvaffaqiyatli bloklandi (Lock Workstation).' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
};

/**
 * 7. Tool: clipboard_read / clipboard_write
 * The agent can already move files and run commands, but it had no way to
 * hand text to/from whatever app the owner is using. The Windows clipboard is
 * the natural bridge for that.
 */
export const clipboardReadTool: ToolDefinition = {
  name: 'clipboard_read',
  description: 'Reads the current Windows clipboard text content.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const { stdout } = await runPowerShell('Get-Clipboard -Raw', 10000);
      const text = stdout.replace(/\r?\n$/, '');
      return {
        success: true,
        empty: text.length === 0,
        length: text.length,
        content: text.length > 4000 ? text.substring(0, 4000) + '\n...[truncated]' : text,
      };
    } catch (err: any) {
      logger.error('Failed to read clipboard:', err);
      return { success: false, error: err.message };
    }
  },
};

export const clipboardWriteTool: ToolDefinition = {
  name: 'clipboard_write',
  description: 'Writes text to the Windows clipboard, so the owner can paste it into any application.',
  parameters: {
    type: 'object',
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        description: 'The text to place on the clipboard.',
      },
    },
  },
  handler: async (args: { text: string }) => {
    try {
      if (typeof args.text !== 'string') {
        return { success: false, error: 'text must be a string.' };
      }
      // Base64 keeps the payload out of the PowerShell source, so quotes,
      // backticks and newlines in the caller's text cannot break the script.
      const b64 = Buffer.from(args.text, 'utf8').toString('base64');
      const script = `$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t`;
      await runPowerShell(script, 10000);
      return { success: true, length: args.text.length, message: 'Text copied to clipboard.' };
    } catch (err: any) {
      logger.error('Failed to write clipboard:', err);
      return { success: false, error: err.message };
    }
  },
};
