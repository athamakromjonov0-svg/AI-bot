import { Schema, model, Document } from 'mongoose';

export interface IUserbotSession extends Document {
  key: string; // e.g. "active_userbot_session"
  encryptedSession: string;
  phoneNumber?: string;
  userId?: string;
  updatedAt: Date;
}

const UserbotSessionSchema = new Schema<IUserbotSession>(
  {
    key: { type: String, required: true, unique: true },
    encryptedSession: { type: String, required: true },
    phoneNumber: { type: String },
    userId: { type: String },
  },
  { timestamps: true }
);

export const UserbotSessionModel = model<IUserbotSession>('UserbotSession', UserbotSessionSchema);
