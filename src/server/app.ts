import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { logger } from '../config/logger';
import { isDbConnected } from '../database';
import { AuditLogModel } from '../database/models/AuditLog';
import { PendingActionModel } from '../database/models/PendingAction';
import { globalToolRegistry } from '../ai/tools/registry';

export function createExpressApp(
  isBotRunning: () => boolean,
  isUserbotRunning: () => boolean,
  isQueueRunning: () => boolean
): express.Application {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Request logger
  app.use((req: Request, res: Response, next: NextFunction) => {
    logger.debug(`[HTTP] ${req.method} ${req.url}`);
    next();
  });

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    const dbStatus = isDbConnected();
    const botStatus = isBotRunning();
    const userbotStatus = isUserbotRunning();
    const queueStatus = isQueueRunning();

    const isHealthy = dbStatus || (!process.env.MONGODB_URI && (botStatus || userbotStatus));

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: dbStatus ? 'connected' : 'disconnected',
        telegramBot: botStatus ? 'active' : 'inactive',
        telegramUserbot: userbotStatus ? 'active' : 'inactive',
        queue: queueStatus ? 'active' : 'inactive',
      },
    });
  });

  // System Status
  app.get('/api/status', async (req: Request, res: Response) => {
    try {
      const pendingCount = isDbConnected() ? await PendingActionModel.countDocuments({ status: 'pending' }) : 0;
      const auditCount = isDbConnected() ? await AuditLogModel.countDocuments() : 0;

      res.json({
        ok: true,
        nodeVersion: process.version,
        memoryUsage: process.memoryUsage(),
        pendingActionsCount: pendingCount,
        totalAuditLogs: auditCount,
      });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Execute registered AI tool via HTTP (for MCP server integration)
  app.post('/api/tools/execute', async (req: Request, res: Response) => {
    try {
      const { name, args } = req.body;
      if (!name) {
        return res.status(400).json({ ok: false, error: 'Tool name is required' });
      }
      const result = await globalToolRegistry.execute(name, args || {});
      res.json({ ok: true, result });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Audit Logs (recent 50)
  app.get('/api/audit', async (req: Request, res: Response) => {
    try {
      if (!isDbConnected()) {
        return res.status(503).json({ ok: false, error: 'Database disconnected' });
      }
      const logs = await AuditLogModel.find().sort({ createdAt: -1 }).limit(50);
      res.json({ ok: true, logs });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 404 Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Route not found' });
  });

  // Error Handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error('Unhandled HTTP error:', err);
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
  });

  return app;
}
