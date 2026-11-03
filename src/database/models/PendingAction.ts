import { Schema, model, Document } from 'mongoose';

export interface IPendingAction extends Document {
  actionId: string;
  type: 'send_message' | 'reply' | 'custom';
  targetChatId: string;
  targetChatTitle?: string;
  text: string;
  proposedBy: 'agent' | 'userbot';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: Date;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const PendingActionSchema = new Schema<IPendingAction>(
  {
    actionId: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ['send_message', 'reply', 'custom'], required: true },
    targetChatId: { type: String, required: true },
    targetChatTitle: { type: String },
    text: { type: String, required: true },
    proposedBy: { type: String, enum: ['agent', 'userbot'], default: 'agent' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'expired'],
      default: 'pending',
      index: true,
    },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL index
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const PendingActionModel = model<IPendingAction>('PendingAction', PendingActionSchema);
