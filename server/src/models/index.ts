import mongoose, { Schema, type Model, type SchemaDefinition } from 'mongoose';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Model nới lỏng kiểu: kiểu hóa sâu của Mongoose làm tsc quá chậm; tính đúng đắn kiểu nằm ở tầng Repository. */
export type LooseModel = Model<any>;

function mk(def: SchemaDefinition): Schema<any> {
  return new Schema<any>(def as any, { strict: false, versionKey: false });
}

/** Hồ sơ phản ánh: GeoJSON `location` có chỉ mục 2dsphere + các chỉ mục nghiệp vụ. */
const reportSchema = mk({
  id: { type: String, required: true, unique: true },
  code: { type: String, required: true, unique: true },
  category: { type: String, required: true, index: true },
  status: { type: String, required: true },
  wardCode: { type: String, required: true },
  reporterId: { type: String, required: true, index: true },
  imageHash: { type: String, default: '' },
  createdAt: { type: String, required: true },
  location: {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
});
reportSchema.index({ location: '2dsphere' });
reportSchema.index({ imageHash: 1, createdAt: -1 });
reportSchema.index({ wardCode: 1, status: 1 });

const userSchema = mk({
  id: { type: String, required: true, unique: true },
  role: { type: String, required: true },
  phone: { type: String, default: null, index: true },
  staffCode: { type: String, default: null, index: true },
  trustScore: { type: Number, default: 70, min: 0, max: 100 },
});

const otpSchema = mk({
  phone: { type: String, required: true, unique: true },
  expiresAt: { type: Number, required: true },
});

const auditSchema = mk({
  id: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, unique: true },
  timestamp: { type: String, required: true },
});

/** Nhật ký bất biến: chặn mọi thao tác sửa/xóa ở tầng ODM. */
const IMMUTABLE_OPS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
] as const;
for (const op of IMMUTABLE_OPS) {
  (auditSchema as any).pre(op, function () {
    throw new Error('AuditLog là bất biến: không cho phép sửa hoặc xóa.');
  });
}
auditSchema.pre('save', function (this: any) {
  if (!this.isNew) throw new Error('AuditLog là bất biến: không cho phép sửa.');
});

function model(name: string, schema: Schema<any>): LooseModel {
  return (mongoose.models[name] as LooseModel | undefined) ?? (mongoose.model(name, schema) as unknown as LooseModel);
}

export const ReportModel = model('Report', reportSchema);
export const UserModel = model('User', userSchema);
export const OtpModel = model('Otp', otpSchema);
export const AuditLogModel = model('AuditLog', auditSchema);
