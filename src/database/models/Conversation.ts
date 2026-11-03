import { Schema, model, Document } from 'mongoose';

export interface IMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
  timestamp: Date;
}

export interface IConversation extends Document {
  sessionId: string; // e.g. "telegram-bot:<userId>" or "userbot:<chatId>"
  userId: number;
  chatId?: string;
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ['system', 'user', 'assistant', 'tool'], required: true },
    content: { type: String, default: '' },
    name: { type: String },
    tool_call_id: { type: String },
    tool_calls: { type: Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: Number, required: true, index: true },
    chatId: { type: String },
    messages: { type: [MessageSchema], default: [] },
  },
  { timestamps: true }
);

export const ConversationModel = model<IConversation>('Conversation', ConversationSchema);
