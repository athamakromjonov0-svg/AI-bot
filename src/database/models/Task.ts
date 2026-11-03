import { Schema, model, Document } from 'mongoose';

export interface ITask extends Document {
  taskId: string;
  title: string;
  details?: string;
  status: 'pending' | 'done';
  priority: 'low' | 'normal' | 'high';
  dueAt?: Date;
  createdBy: number;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<ITask>(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    details: { type: String },
    status: {
      type: String,
      enum: ['pending', 'done'],
      default: 'pending',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },
    dueAt: { type: Date, index: true },
    createdBy: { type: Number, required: true },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

export const TaskModel = model<ITask>('Task', TaskSchema);
