import { Schema, model, Document } from 'mongoose';

export interface IAutoReplyRule extends Document {
  ruleId: string;
  name: string;
  targetType: 'direct' | 'group' | 'channel' | 'specific_chat';
  targetChatId?: string; // Specific chat ID or username
  keywords: string[]; // Triggers (e.g. ['price', 'pricing', 'order'], or ['*'] for all)
  excludeKeywords: string[]; // Inhibit triggers
  customPrompt?: string; // Instructions for AI response generator
  mode: 'draft' | 'auto'; // 'draft' sends preview to owner bot for confirmation; 'auto' sends directly
  cooldownSeconds: number; // Minimum seconds between automated replies to the same chat
  lastTriggeredAt?: Date;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AutoReplyRuleSchema = new Schema<IAutoReplyRule>(
  {
    ruleId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    targetType: {
      type: String,
      enum: ['direct', 'group', 'channel', 'specific_chat'],
      default: 'direct',
      index: true,
    },
    targetChatId: { type: String, index: true },
    keywords: { type: [String], default: ['*'] },
    excludeKeywords: { type: [String], default: [] },
    customPrompt: { type: String },
    mode: { type: String, enum: ['draft', 'auto'], default: 'draft' },
    cooldownSeconds: { type: Number, default: 60 },
    lastTriggeredAt: { type: Date },
    enabled: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

export const AutoReplyRuleModel = model<IAutoReplyRule>('AutoReplyRule', AutoReplyRuleSchema);
