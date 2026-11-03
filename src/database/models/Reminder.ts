import { Schema, model, Document } from 'mongoose';

export interface IReminder extends Document {
  reminderId: string;
  /** Chat the reminder should be delivered to (owner chat by default). */
  chatId: string;
  text: string;
  /** When the reminder should fire. */
  fireAt: Date;
  status: 'scheduled' | 'sent' | 'cancelled' | 'failed';
  /** Interval in minutes for repeating reminders; one-shot when absent. */
  repeatMinutes?: number;
  createdBy: number;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ReminderSchema = new Schema<IReminder>(
  {
    reminderId: { type: String, required: true, unique: true, index: true },
    chatId: { type: String, required: true, index: true },
    text: { type: String, required: true },
    fireAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['scheduled', 'sent', 'cancelled', 'failed'],
      default: 'scheduled',
      index: true,
    },
    repeatMinutes: { type: Number, min: 1 },
    createdBy: { type: Number, required: true },
    sentAt: { type: Date },
  },
  { timestamps: true }
);

// Drives the poller: "give me everything still scheduled and already due".
ReminderSchema.index({ status: 1, fireAt: 1 });

export const ReminderModel = model<IReminder>('Reminder', ReminderSchema);
