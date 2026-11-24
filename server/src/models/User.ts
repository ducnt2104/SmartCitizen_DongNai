import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import {
  applyHybridSyncIndex,
  createHybridSyncDefinition,
  VN_PHONE_REGEX,
  type HybridSyncFields,
} from './common';

export const USER_ROLES = ['citizen', 'ward_officer', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AssignedArea {
  district: string;
  ward: string;
}

export interface OtpVerificationState {
  isVerified: boolean;
  lastVerifiedAt: Date | null;
  dailyReportCount: number;
  lastReportDate: Date | null;
}

export interface IUser extends HybridSyncFields {
  phoneNumber: string;
  fullName: string;
  role: UserRole;
  assignedArea?: AssignedArea;
  trustScore: number;
  otpVerification: OtpVerificationState;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const assignedAreaSchema = new Schema<AssignedArea>(
  {
    district: { type: String, trim: true, maxlength: 100, default: '' },
    ward: { type: String, trim: true, maxlength: 100, default: '' },
  },
  { _id: false },
);

const otpVerificationSchema = new Schema<OtpVerificationState>(
  {
    isVerified: { type: Boolean, default: false, required: true },
    lastVerifiedAt: { type: Date, default: null },
    dailyReportCount: { type: Number, default: 0, min: 0, required: true },
    lastReportDate: { type: Date, default: null },
  },
  { _id: false },
);

function normalizeVnPhone(raw: string): string {
  let cleaned = raw.replace(/[\s.\-()]/g, '');
  if (cleaned.startsWith('+84')) cleaned = `0${cleaned.slice(3)}`;
  else if (cleaned.startsWith('84') && cleaned.length === 11) cleaned = `0${cleaned.slice(2)}`;
  return cleaned;
}

const userSchema = new Schema<IUser>(
  {
    phoneNumber: {
      type: String,
      required: [true, 'Số điện thoại là bắt buộc.'],
      unique: true,
      trim: true,
      set: (v: unknown) => (typeof v === 'string' ? normalizeVnPhone(v) : v),
      validate: {
        validator: (v: string) => VN_PHONE_REGEX.test(v),
        message: 'Số điện thoại phải gồm đúng 10 chữ số và bắt đầu bằng số 0.',
      },
    },
    fullName: {
      type: String,
      required: [true, 'Họ và tên là bắt buộc.'],
      trim: true,
      minlength: [2, 'Họ và tên phải có tối thiểu 2 ký tự.'],
      maxlength: [120, 'Họ và tên tối đa 120 ký tự.'],
    },
    role: {
      type: String,
      enum: {
        values: USER_ROLES,
        message: 'Vai trò người dùng không hợp lệ ({VALUE}).',
      },
      default: 'citizen',
      required: true,
    },
    assignedArea: {
      type: assignedAreaSchema,
      default: undefined,
      required: [
        function requiresAssignedArea(this: IUser) {
          return this.role === 'ward_officer';
        },
        'Cán bộ xã/phường (ward_officer) bắt buộc phải có đầy đủ district và ward trong assignedArea.',
      ],
      validate: {
        validator(this: IUser, area: AssignedArea | undefined) {
          if (this.role !== 'ward_officer') return true;
          return Boolean(area && area.district.trim().length > 0 && area.ward.trim().length > 0);
        },
        message: 'Cán bộ xã/phường (ward_officer) bắt buộc phải có đầy đủ district và ward trong assignedArea.',
      },
    },
    trustScore: {
      type: Number,
      default: 100,
      min: [0, 'Điểm tín nhiệm không thể nhỏ hơn 0.'],
      max: [100, 'Điểm tín nhiệm không thể vượt quá 100.'],
      required: true,
    },
    otpVerification: {
      type: otpVerificationSchema,
      default: () => ({
        isVerified: false,
        lastVerifiedAt: null,
        dailyReportCount: 0,
        lastReportDate: null,
      }),
      required: true,
    },
    ...createHybridSyncDefinition(),
  },
  {
    collection: 'users',
    timestamps: true,
    versionKey: false,
  },
);

// Chuẩn hóa số điện thoại dạng +84 / 84 về 0xxxxxxxxx trước khi validate
userSchema.pre('validate', function normalizeVietnamesePhone() {
  if (typeof this.phoneNumber === 'string') {
    let cleaned = this.phoneNumber.replace(/[\s.\-()]/g, '');
    if (cleaned.startsWith('+84')) cleaned = `0${cleaned.slice(3)}`;
    else if (cleaned.startsWith('84') && cleaned.length === 11) cleaned = `0${cleaned.slice(2)}`;
    this.phoneNumber = cleaned;
  }
});

// Indexes: phoneNumber đã có unique index từ field schema; bổ sung index phân quyền địa bàn và Hybrid Sync
applyHybridSyncIndex(userSchema);
userSchema.index({ role: 1, 'assignedArea.district': 1, 'assignedArea.ward': 1 });

export const User: Model<IUser> =
  (mongoose.models.User as Model<IUser> | undefined) ?? mongoose.model<IUser>('User', userSchema);

export { userSchema };
