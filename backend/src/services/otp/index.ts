export {
  VN_MOBILE_E164_REGEX,
  VN_MOBILE_LOCAL_REGEX,
  normalizeVnPhone,
  vnPhoneToLocal,
  maskVnPhone,
  parseVnPhone,
  requireVnPhone,
  type ParsedVnPhone,
} from './phoneNormalizer';

export {
  OTP_COOLDOWN_MS,
  OTP_HOURLY_WINDOW_MS,
  OTP_MAX_SENDS_PER_HOUR,
  OTP_MAX_VERIFY_ATTEMPTS,
  OtpSendRateLimiter,
} from './otpRateLimiter';

export {
  SMS_PROVIDER_MODES,
  FirebaseSmsOtpProvider,
  AndroidGatewaySmsOtpProvider,
  EsmsSmsOtpProvider,
  SpeedSmsOtpProvider,
  TwilioSmsOtpProvider,
  DemoSmsOtpProvider,
  MultiSmsOtpDispatcher,
  type SmsProviderMode,
  type ConcreteSmsProviderName,
  type SmsOtpSendInput,
  type SmsOtpSendResult,
  type SmsOtpProvider,
  type FetchLike,
} from './smsProviders';

export {
  FirebasePhoneVerifier,
  type VerifiedFirebasePhoneClaims,
  type FirebaseTokenVerifierFn,
} from './firebaseVerifier';

export {
  PHONE_OTP_TTL_MS,
  generateSixDigitOtp,
  hashOtpCodeSha256,
  PhoneOtpService,
  type StoredPhoneOtpChallenge,
  type SendPhoneOtpResponse,
} from './phoneOtpService';
