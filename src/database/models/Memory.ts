import { Schema, model, Document } from 'mongoose';

export interface IMemory extends Document {
  content: string;
  category: 'preference' | 'fact' | 'instruction' | 'contact' | 'general';
  tags: string[];
  importance: number; // 1 to 5
  sourceChatId?: string;
  sourceMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MemorySchema = new Schema<IMemory>(
  {
    content: { type: String, required: true },
    category: {
      type: String,
      enum: ['preference', 'fact', 'instruction', 'contact', 'general'],
      default: 'general',
      index: true,
    },
    tags: { type: [String], default: [], index: true },
    importance: { type: Number, default: 3, min: 1, max: 5 },
    sourceChatId: { type: String },
    sourceMessageId: { type: String },
  },
  { timestamps: true }
);

MemorySchema.index({ content: 'text', tags: 'text' });

export const MemoryModel = model<IMemory>('Memory', MemorySchema);
