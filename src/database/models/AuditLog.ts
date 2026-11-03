import { Schema, model, Document } from 'mongoose';

export interface IAuditLog extends Document {
  action: string; // e.g. "send_message", "auto_reply", "execute_tool", "search_history"
  actor: 'owner' | 'ai_agent' | 'userbot_auto';
  targetChatId?: string;
  targetChatTitle?: string;
  status: 'success' | 'failed' | 'pending_approval' | 'rejected';
  details?: Record<string, any>;
  errorMessage?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    action: { type: String, required: true, index: true },
    actor: {
      type: String,
      enum: ['owner', 'ai_agent', 'userbot_auto'],
      required: true,
      index: true,
    },
    targetChatId: { type: String, index: true },
    targetChatTitle: { type: String },
    status: {
      type: String,
      enum: ['success', 'failed', 'pending_approval', 'rejected'],
      required: true,
      index: true,
    },
    details: { type: Schema.Types.Mixed },
    errorMessage: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const AuditLogModel = model<IAuditLog>('AuditLog', AuditLogSchema);
