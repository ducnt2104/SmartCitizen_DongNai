import { ShieldCheck, Sparkles, MapPin, Cpu, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { onIntentPrefetch } from '../lib/prefetch';

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-4xl space-y-6">
      <header className="card space-y-3 p-5 sm:p-7">
        <p className="inline-flex w-fit items-center gap-2 rounded-full bg-brand-soft px-3 py-1 text-xs font-bold text-brand">
          SmartCitizen Đồng Nai · Team Victer
        </p>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
          SmartCitizen Đồng Nai — Nền tảng Phản ánh Hiện trường &amp; Đô thị Thông minh Đồng Nai
        </h1>
        <p className="text-sm leading-relaxed text-muted sm:text-base">
          Được nghiên cứu và phát triển bởi <strong className="text-ink">Team Victer</strong>,{' '}
          <strong className="text-ink">SmartCitizen Đồng Nai</strong> kết nối trực tiếp người dân tại{' '}
          <strong className="text-ink">95 phường/xã Tỉnh Đồng Nai</strong> với hệ thống điều hành đô thị thông minh
          (IOC) và đội cứu hộ hiện trường trong 3 bước đơn giản.
        </p>
        <div className="flex flex-wrap gap-2.5 pt-1">
          <Link
            to="/report"
            onMouseEnter={() => onIntentPrefetch('/report')}
            className="btn btn-primary"
          >
            Gửi phản ánh hiện trường <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            to="/map"
            onMouseEnter={() => onIntentPrefetch('/map')}
            className="btn btn-soft"
          >
            Xem bản đồ sự cố 95 Phường/Xã
          </Link>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="card space-y-2 p-4">
          <h2 className="flex items-center gap-2 font-bold text-ink">
            <Cpu className="h-5 w-5 text-brand" aria-hidden />
            Hybrid Local AI &amp; Web Worker 60FPS
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            Ảnh hiện trường được nén WebP song song trong Web Worker, trích xuất EXIF GPS, tính dHash/pHash/Histogram màu
            và phân loại sự cố bằng Local AI + ONNX trong &lt;50ms trước khi đồng bộ lên hệ thống điều phối.
          </p>
        </div>
        <div className="card space-y-2 p-4">
          <h2 className="flex items-center gap-2 font-bold text-ink">
            <MapPin className="h-5 w-5 text-ok" aria-hidden />
            Phủ 95 Phường/Xã Tỉnh Đồng Nai
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            Bản đồ số hóa toàn bộ 33 phường và 62 xã của Thành phố Đồng Nai, tự động định tuyến về đúng đơn vị phụ trách
            (Giao thông, Môi trường, Chiếu sáng, Điện lực, Cứu hộ khẩn cấp).
          </p>
        </div>
        <div className="card space-y-2 p-4">
          <h2 className="flex items-center gap-2 font-bold text-ink">
            <ShieldCheck className="h-5 w-5 text-brand" aria-hidden />
            Nghiệm thu Trước – Sau minh bạch
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            Hồ sơ xử lý được đối chiếu bằng thuật toán SSIM &amp; Structural Edge Diff giữa ảnh Trước và Sau, kèm lịch sử
            trạng thái chống chối bỏ (Hash-chain Audit Log).
          </p>
        </div>
        <div className="card space-y-2 p-4">
          <h2 className="flex items-center gap-2 font-bold text-ink">
            <Sparkles className="h-5 w-5 text-accent" aria-hidden />
            Xác thực SMS OTP +84 &amp; Cộng đồng số
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            Hỗ trợ xác thực số điện thoại Việt Nam (+84) bảo mật, tính năng &ldquo;Cùng xác nhận (+1)&rdquo; để nâng mức ưu
            tiên xử lý sự cố cấp bách và chế độ chữ lớn Aa+ thân thiện người cao tuổi.
          </p>
        </div>
      </section>
    </article>
  );
}
