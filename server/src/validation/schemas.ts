import { z } from 'zod';
import { DEPARTMENTS } from '../../../shared/constants';
import { isValidHash } from '../../../shared/dhash';
import { CATEGORIES } from '../../../shared/types';

const hash = z.string().refine(isValidHash, 'dHash phải là 16 ký tự hex');
const photo = z.object({ dataUrl: z.string().max(1_900_000), dHash: hash });
const phone = z.string().min(9).max(16);
const category = z.enum([...CATEGORIES] as [string, ...string[]]);
const department = z.enum([...DEPARTMENTS] as [string, ...string[]]);
const wardCode = z.string().regex(/^DN-[A-Z]{2,4}$/);

export const edgeStatsSchema = z.object({
  blurScore: z.number().min(0).max(1e6),
  brightness: z.number().min(0).max(255),
  flatRatio: z.number().min(0).max(1),
  aspect: z.number().min(0.05).max(20),
});

export const schemas = {
  otpRequest: z.object({ phone }),
  otpVerify: z.object({ phone, code: z.string().regex(/^\d{6}$/, 'Mã OTP gồm 6 chữ số') }),
  staffLogin: z.object({
    staffCode: z.string().min(2).max(32).regex(/^[A-Za-z0-9-]+$/),
    password: z.string().min(1).max(128),
    unit: z.union([z.literal('city'), wardCode]),
  }),
  googleMock: z.object({ name: z.string().min(1).max(80), email: z.string().email().max(120) }),
  demoLogin: z.object({ kind: z.enum(['citizen', 'volunteer', 'ward_officer', 'city_admin']) }),
  volunteerRegister: z.object({ wardCode, unitCode: z.string().max(16) }),

  analyzeImage: z.object({
    image: photo,
    category: category.optional(),
    hintText: z.string().max(500).optional(),
    edge: edgeStatsSchema.optional(),
  }),
  verifyResolution: z.object({
    reportId: z.string().min(3).max(64),
    afterPhoto: photo,
  }),
  chat: z.object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'model']), text: z.string().min(1).max(2000) }))
      .min(1)
      .max(20),
    wardCode: wardCode.optional(),
    locale: z.enum(['vi', 'en']).default('vi'),
  }),

  createReport: z.object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    category,
    title: z.string().min(3).max(140),
    description: z.string().max(800).default(''),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    wardCode: wardCode.optional(),
    address: z.string().max(200).optional(),
    photo,
    deviceLat: z.number().min(-90).max(90).optional(),
    deviceLng: z.number().min(-180).max(180).optional(),
    leftScene: z.boolean().default(false),
    isProxyReport: z.boolean().default(false),
    seniorSubmitted: z.boolean().default(false),
    edge: edgeStatsSchema.optional(),
  }),
  attachPhoto: z.object({ photo }),
  rate: z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(400).default('') }),

  assign: z.object({ department, slaHours: z.number().int().min(1).max(720) }),
  status: z.object({ status: z.enum(['verifying', 'processing']) }),
  dispatch: z.object({
    wardCodes: z.array(wardCode).max(10).optional(),
    units: z.array(department).max(6).optional(),
    note: z.string().max(300).default(''),
  }),
  resolve: z.object({
    afterPhoto: photo,
    note: z.string().max(300).default(''),
    override: z.boolean().default(false),
  }),
  markSpam: z.object({ reason: z.string().max(300).default('') }),

  volunteerVerify: z.object({
    verdict: z.enum(['true', 'duplicate', 'fake']),
    note: z.string().max(400).default(''),
    photo: photo.optional(),
  }),
} as const;

export type CreateReportInput = z.infer<typeof schemas.createReport>;
