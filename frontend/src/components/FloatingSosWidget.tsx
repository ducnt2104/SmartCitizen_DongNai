import { Check, Copy, LocateFixed, PhoneCall, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { nearestWard } from '@shared/geo';

interface SosPosition {
  lat: number;
  lng: number;
  accuracy: number;
  wardName: string;
}

const EMERGENCY_HOTLINES = [
  { number: '113', label: 'Công an · An ninh trật tự', tone: 'bg-rose-600 text-white' },
  { number: '114', label: 'Cứu hỏa · Cứu nạn cứu hộ', tone: 'bg-orange-600 text-white' },
  { number: '115', label: 'Cấp cứu Y tế khẩn cấp', tone: 'bg-emerald-600 text-white' },
  { number: '19001006', label: 'Sự cố Điện lực miền Nam', tone: 'bg-amber-600 text-white' },
] as const;

/**
 * Widget SOS Khẩn cấp 1 Chạm (100% Client-Side, không gọi AI/Server để đảm bảo 0ms phản hồi khi mạng yếu):
 * - Lấy GPS trực tiếp từ trình duyệt + tra tên Xã/Phường Đồng Nai tức thì.
 * - Sao chép tọa độ 1 chạm để gửi qua Zalo/SMS cho lực lượng ứng cứu.
 * - Gọi thẳng tổng đài 113 / 114 / 115 / 19001006 qua `tel:`.
 */
export function FloatingSosWidget() {
  const [open, setOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [pos, setPos] = useState<SosPosition | null>(null);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchGps = (): void => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsErr('Thiết bị không hỗ trợ định vị GPS trình duyệt.');
      return;
    }
    setLocating(true);
    setGpsErr(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const w = nearestWard(p.coords.latitude, p.coords.longitude);
        setPos({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: Math.round(p.coords.accuracy),
          wardName: w.name,
        });
        setLocating(false);
      },
      () => {
        setGpsErr('Không thể đọc GPS. Vui lòng bật Quyền Vị trí trên thiết bị.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 15_000 },
    );
  };

  const handleOpen = (): void => {
    setOpen(true);
    if (!pos) fetchGps();
  };

  const copyCoords = async (): Promise<void> => {
    if (!pos) return;
    const text = `[SOS KHẨN CẤP - ĐỒNG NAI] Khu vực: ${pos.wardName} | Tọa độ GPS: ${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)} | Maps: https://maps.google.com/?q=${pos.lat.toFixed(6)},${pos.lng.toFixed(6)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setGpsErr('Không sao chép tự động được, hãy chép dãy số tọa độ bên dưới.');
    }
  };

  return (
    <>
      <section
        aria-label="Thanh gọi khẩn cấp SOS 113/114/115"
        className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-rose-500/35 bg-rose-50/95 px-3 py-2.5 shadow-sm dark:bg-rose-950/35"
      >
        <button
          type="button"
          onClick={handleOpen}
          aria-label="Mở bảng gọi khẩn cấp SOS 1 chạm"
          className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-extrabold text-white shadow-sm transition-colors hover:bg-rose-700 active:scale-[0.99] sm:flex-initial sm:text-base"
        >
          <PhoneCall className="h-5 w-5 shrink-0" aria-hidden />
          <span>SOS Khẩn cấp 113 / 114 / 115</span>
        </button>

        <div className="flex w-full items-center justify-between gap-1.5 sm:w-auto sm:justify-end">
          {(['113', '114', '115'] as const).map((num) => (
            <a
              key={num}
              href={`tel:${num}`}
              className="mono inline-flex min-h-12 flex-1 items-center justify-center gap-1 rounded-xl border border-rose-500/30 bg-surface px-3 text-sm font-extrabold text-rose-700 transition-colors hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-900/50 sm:flex-initial"
              aria-label={`Gọi khẩn cấp ${num}`}
            >
              <PhoneCall className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{num}</span>
            </a>
          ))}
        </div>
      </section>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sos-dialog-title"
          className="fixed inset-0 z-[1200] flex items-end justify-center bg-slate-950/55 p-3 backdrop-blur-xs sm:items-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-rose-500/30 bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-rose-600 text-white">
                  <ShieldAlert className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <h2 id="sos-dialog-title" className="text-lg font-extrabold text-ink">
                    Cứu hộ Khẩn cấp 1 Chạm
                  </h2>
                  <p className="text-xs text-muted">Hoạt động trực tiếp trên thiết bị · Không phụ thuộc AI</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Đóng bảng SOS"
                className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-line bg-surface-2 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-muted">Vị trí GPS hiện tại</span>
                <button
                  type="button"
                  onClick={fetchGps}
                  disabled={locating}
                  className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                >
                  <LocateFixed className="h-3.5 w-3.5" aria-hidden />
                  {locating ? 'Đang dò...' : 'Làm mới GPS'}
                </button>
              </div>
              {pos ? (
                <div className="mt-2 space-y-2">
                  <p className="text-sm font-bold text-ink">{pos.wardName}, Tỉnh Đồng Nai</p>
                  <p className="mono rounded-xl bg-surface px-3 py-2 text-xs font-semibold text-ink">
                    {pos.lat.toFixed(6)}, {pos.lng.toFixed(6)} (±{pos.accuracy}m)
                  </p>
                  <button
                    type="button"
                    onClick={() => void copyCoords()}
                    className="btn btn-soft !min-h-10 w-full !text-xs"
                  >
                    {copied ? <Check className="h-4 w-4 text-ok" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                    {copied ? 'Đã sao chép tọa độ gửi cứu hộ!' : 'Sao chép tọa độ & link bản đồ'}
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  {locating ? 'Đang xác định tọa độ GPS chính xác...' : gpsErr || 'Bấm "Làm mới GPS" để đọc tọa độ.'}
                </p>
              )}
            </div>

            <div className="mt-4 grid gap-2">
              {EMERGENCY_HOTLINES.map((item) => (
                <a
                  key={item.number}
                  href={`tel:${item.number}`}
                  className={`flex min-h-12 items-center justify-between rounded-2xl px-4 py-2.5 shadow-sm transition-opacity hover:opacity-95 ${item.tone}`}
                >
                  <span className="text-sm font-bold">{item.label}</span>
                  <span className="mono rounded-xl bg-black/20 px-2.5 py-1 text-sm font-extrabold">
                    {item.number}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
