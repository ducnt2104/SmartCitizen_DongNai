import { DONG_NAI_WARDS, WARD_BY_CODE } from '../shared/dongNaiWards';
import { computeStats, toClientReport } from '../shared/report';
import type { Category, CivicAlertItem, OfficialBulletinItem, Report, WeatherSnapshotItem } from '../shared/types';
import type { Repositories, UserRecord } from '../repositories/types';
import { canSee } from './access';
import type { AlertsAndWardsService } from './alertsAndWards.service';
import { sanitizeUserText } from './gemini.service';
import type { DirectLocalIntentHit, LocalRagService } from './localRag.service';

const CODE_RE = /DN-[A-Z]{2,4}-\d{4}-\d{3}/gi;

const STATUS_VI: Record<Report['status'], string> = {
  received: 'Đã tiếp nhận',
  verifying: 'Đang xác minh',
  processing: 'Đang xử lý',
  resolved: 'Đã hoàn thành',
  quarantined: 'Đang kiểm chứng',
  rejected: 'Không được chấp nhận',
};
const STATUS_EN: Record<Report['status'], string> = {
  received: 'Received',
  verifying: 'Verifying',
  processing: 'In progress',
  resolved: 'Resolved',
  quarantined: 'Under review',
  rejected: 'Rejected',
};
const CAT_VI: Record<Category, string> = {
  rac_thai: 'Rác thải',
  den_duong: 'Đèn đường',
  ngap_nuoc: 'Ngập nước',
  mat_duong: 'Mặt đường',
  khac: 'Khác',
};

export interface ChatContext {
  text: string;
  found: Report[];
  mine: Report[];
  scopeLabel: string;
  stats: ReturnType<typeof computeStats>;
  ragHits: Array<{ title: string; content: string }>;
  directIntent: DirectLocalIntentHit | null;
}

function withFastFallback<T>(promise: Promise<T>, timeoutMs: number, fallbackValue: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallbackValue);
      }
    }, timeoutMs);
    timer.unref?.();
    promise
      .then((val) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(val);
        }
      })
      .catch(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(fallbackValue);
        }
      });
  });
}

/**
 * Dựng ngữ cảnh Chatbot & Bộ trả lời tức thì (< 5–15ms) hoàn toàn không phụ thuộc cứng vào MongoDB.
 */
export class ChatService {
  constructor(
    private readonly repos: Repositories,
    private readonly rag?: LocalRagService,
    private readonly alerts?: AlertsAndWardsService,
  ) {}

  async buildContext(user: UserRecord | null, wardCode: string | undefined, lastUserText: string): Promise<ChatContext> {
    const scope = wardCode && WARD_BY_CODE[wardCode] ? `ward:${wardCode}` : 'city';
    const scopeLabel = scope === 'city' ? 'Toàn TP. Đồng Nai (95 xã, phường)' : WARD_BY_CODE[wardCode!].name;
    const directIntent = this.rag ? this.rag.matchDirectIntent(lastUserText, wardCode) : null;

    const ragHits = (this.rag ? this.rag.retrieve(lastUserText, 3, wardCode) : []).map((h) => ({
      title: h.doc.title,
      content: h.doc.content,
    }));

    // Đọc song song hồ sơ, thời tiết Open-Meteo, cảnh báo ngập/thi công và bản tin RSS chính thống
    const [all, weatherSnapshots, activeAlerts, recentBulletins] = await Promise.all([
      withFastFallback(this.repos.reports.list({ limit: 200 }), 120, [] as Report[]),
      this.alerts
        ? withFastFallback(this.alerts.getLatestWeatherSnapshots(), 150, [] as WeatherSnapshotItem[])
        : Promise.resolve([] as WeatherSnapshotItem[]),
      this.alerts
        ? withFastFallback(this.alerts.listAlerts({ wardId: wardCode, status: 'active', limit: 8 }), 150, [] as CivicAlertItem[])
        : Promise.resolve([] as CivicAlertItem[]),
      this.alerts
        ? withFastFallback(this.alerts.listBulletins({ wardId: wardCode, limit: 6 }), 150, [] as OfficialBulletinItem[])
        : Promise.resolve([] as OfficialBulletinItem[]),
    ]);
    const visible = all.filter((r) => canSee(user, r));
    const inScope = scope === 'city' ? all : all.filter((r) => r.wardCode === wardCode);
    const stats = computeStats(inScope.map(toClientReport), scope);

    const codes = [...new Set((sanitizeUserText(lastUserText).match(CODE_RE) ?? []).map((c) => c.toUpperCase()))].slice(0, 3);
    const found = codes.map((c) => visible.find((r) => r.code.toUpperCase() === c)).filter((r): r is Report => !!r);
    const mine = user ? visible.filter((r) => r.reporterId === user.id).slice(0, 5) : [];

    const lines: string[] = [
      `Địa bàn đang chọn: ${scopeLabel}`,
      `Số điện thoại khẩn cấp tại Đồng Nai: Công an 113 | PCCC & Cứu nạn 114 | Cấp cứu y tế 115.`,
      `Tổng phản ánh: ${stats.total}; đã hoàn thành: ${stats.resolved} (${stats.resolvedPct}%); chưa hoàn thành: ${stats.open}; thời gian xử lý trung bình: ${stats.avgDays} ngày; khẩn cấp đang mở: ${stats.emergency}.`,
      `Theo nhóm: rác thải ${stats.byCategory.rac_thai}, đèn đường ${stats.byCategory.den_duong}, ngập nước ${stats.byCategory.ngap_nuoc}, mặt đường ${stats.byCategory.mat_duong}, khác ${stats.byCategory.khac}.`,
      `Tổng số ĐVHC TP. Đồng Nai: ${DONG_NAI_WARDS.length} (33 Phường, 62 Xã).`,
    ];

    const matchedWeather =
      (wardCode ? weatherSnapshots.find((w) => w.wardCode === wardCode) : undefined) ?? weatherSnapshots[0];
    if (matchedWeather) {
      lines.push(
        `Thời tiết trực tiếp Open-Meteo (${matchedWeather.regionName}): ${matchedWeather.weatherLabel}, nhiệt độ ${matchedWeather.temperatureC}°C, độ ẩm ${matchedWeather.humidityPct}%, xác suất mưa ${matchedWeather.precipitationProbabilityPct}%, lượng mưa hiện tại ${matchedWeather.precipitationMm}mm (24h: ${matchedWeather.precipitation24hMm}mm), gió giật ${matchedWeather.windGustsKmh} km/h, mức nguy cơ: ${matchedWeather.riskLevel}${matchedWeather.isHazard ? ' (CẢNH BÁO NGUY HIỂM)' : ''}.`,
      );
    }
    if (activeAlerts.length > 0) {
      lines.push(
        'Cảnh báo thiên tai / ngập lụt / giao thông đang kích hoạt:',
        ...activeAlerts.map(
          (a) =>
            `- [${a.severity.toUpperCase()} · ${a.category}] ${a.title}${a.affectedRoads.length ? ` (Tuyến đường: ${a.affectedRoads.join(', ')})` : ''}${a.detourNote ? ` — Lộ trình tránh: ${a.detourNote}` : ''}: ${a.description.slice(0, 180)}`,
        ),
      );
    } else {
      lines.push('Cảnh báo hiện trường đang kích hoạt: Hiện chưa ghi nhận cảnh báo ngập lụt/cấm đường khẩn cấp nào.');
    }
    if (recentBulletins.length > 0) {
      lines.push(
        'Bản tin báo chí & chính quyền mới nhất:',
        ...recentBulletins.map(
          (b) =>
            `- [${b.sourceName}] ${b.title}${b.affectedRoads.length ? ` (${b.affectedRoads.join(', ')})` : ''}: ${b.cleanSummary.slice(0, 140)}`,
        ),
      );
    }
    const describe = (r: Report): string => {
      const last = r.timeline[r.timeline.length - 1];
      return `- ${r.code}: "${r.title}" (${CAT_VI[r.category]}, ${WARD_BY_CODE[r.wardCode]?.name}) — trạng thái: ${STATUS_VI[r.status]}; ưu tiên: ${r.priority}; ${r.clusterCount} người cùng phản ánh; hạn xử lý: ${r.slaDueAt ?? 'chưa đặt'}; cập nhật gần nhất: ${last?.note ?? 'không có'}.`;
    };
    if (found.length) lines.push('Hồ sơ người dùng hỏi tới:', ...found.map(describe));
    else if (codes.length) lines.push(`Không tìm thấy hồ sơ nào với mã: ${codes.join(', ')}.`);
    if (mine.length) lines.push('Hồ sơ của chính người dùng đang đăng nhập:', ...mine.map(describe));
    return { text: lines.join('\n'), found, mine, scopeLabel, stats, ragHits, directIntent };
  }

  /**
   * Kiểm tra xem câu hỏi có thể trả lời tức thì (< 5–15ms) từ Local Knowledge & Intent Engine
   * hoặc dữ liệu hồ sơ/thống kê chính xác hay không (không cần gọi LLM từ xa).
   */
  resolveInstantAnswer(ctx: ChatContext, userText: string, locale: 'vi' | 'en'): string | null {
    const en = locale === 'en';
    const t = userText.toLowerCase();

    if (ctx.directIntent) {
      return en ? ctx.directIntent.answerEn : ctx.directIntent.answerVi;
    }

    if (ctx.found.length) {
      return ctx.found
        .map((r) => {
          const st = (en ? STATUS_EN : STATUS_VI)[r.status];
          const wardName = WARD_BY_CODE[r.wardCode]?.name ?? r.wardCode;
          return en
            ? `Report ${r.code} ("${r.title}", ${wardName}) is currently: ${st}. ${r.clusterCount} resident(s) reported it. Latest update: ${r.timeline[r.timeline.length - 1]?.note ?? 'none'}.`
            : `Hồ sơ ${r.code} ("${r.title}" tại ${wardName}) hiện ở trạng thái: ${st}. Có ${r.clusterCount} người dân cùng phản ánh. Cập nhật gần nhất: ${r.timeline[r.timeline.length - 1]?.note ?? 'chưa có'}.`;
        })
        .join('\n');
    }

    if (/DN-[a-z]{2,4}-\d{4}-\d{3}/i.test(userText)) {
      return en
        ? 'I could not find that report code. Please double-check the code (e.g. DN-TB-2611-001) or look it up in "My Reports".'
        : 'Mình chưa tìm thấy hồ sơ với mã này. Bạn vui lòng kiểm tra lại mã (ví dụ DN-TB-2611-001) hoặc mở mục "Của tôi" để tra cứu nhé.';
    }

    if (/(đơn của tôi|hồ sơ của tôi|my reports?)/i.test(t)) {
      if (ctx.mine.length > 0) {
        const listText = ctx.mine
          .map((r) => `• ${r.code}: "${r.title}" — ${en ? STATUS_EN[r.status] : STATUS_VI[r.status]}`)
          .join('\n');
        return en ? `Your recent reports:\n${listText}` : `Các phản ánh gần đây của bạn:\n${listText}`;
      }
      return en
        ? 'Sign in and visit "My Reports" to view all reports submitted from your account.'
        : 'Bạn hãy đăng nhập và mở mục "Của tôi" để theo dõi toàn bộ phản ánh đã gửi nhé.';
    }

    if (/(bao nhiêu|thống kê|tổng số|kpi|how many|statistic|total)/i.test(t)) {
      const s = ctx.stats;
      return en
        ? `${ctx.scopeLabel}: ${s.total} reports total, ${s.resolved} resolved (${s.resolvedPct}%), ${s.open} in progress, average resolution time ${s.avgDays} days.`
        : `${ctx.scopeLabel}: hiện ghi nhận ${s.total} phản ánh, ${s.resolved} đã xử lý (${s.resolvedPct}%), đang xử lý ${s.open} hồ sơ, thời gian khắc phục trung bình ${s.avgDays} ngày.`;
    }

    return null;
  }

  /** Phản hồi dự phòng luôn có nghĩa dựa trên Local BM25 RAG + Thống kê địa bàn (0% crash). */
  localAnswer(ctx: ChatContext, userText: string, locale: 'vi' | 'en'): string {
    const instant = this.resolveInstantAnswer(ctx, userText, locale);
    if (instant) return instant;

    const en = locale === 'en';
    if (!en && ctx.ragHits.length > 0 && ctx.ragHits[0].content.trim().length >= 8) {
      return ctx.ragHits[0].content;
    }
    return en
      ? 'I can help you report an issue in 3 steps: 1) take a photo, 2) confirm the location, 3) submit. You can also enter a report code (e.g. DN-TB-2611-001) to check its progress.'
      : 'Mình có thể hướng dẫn bạn gửi phản ánh trong 3 bước: 1) Chụp ảnh hiện trường, 2) Xác nhận vị trí trên bản đồ, 3) Gửi đơn. Bạn cũng có thể nhập mã hồ sơ (ví dụ DN-TB-2611-001) để tra cứu tiến độ ngay.';
  }
}
