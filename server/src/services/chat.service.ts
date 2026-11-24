import { DONG_NAI_WARDS, WARD_BY_CODE } from '../../../shared/dongNaiWards';
import { computeStats, toClientReport } from '../../../shared/report';
import type { Report } from '../../../shared/types';
import type { Repositories, UserRecord } from '../repositories/types';
import { canSee } from './access';
import { sanitizeUserText } from './gemini.service';

const CODE_RE = /DN-[A-Z]{2,4}-\d{4}-\d{3}/gi;

const STATUS_VI: Record<Report['status'], string> = {
  received: 'Đã tiếp nhận', verifying: 'Đang xác minh', processing: 'Đang xử lý', resolved: 'Đã hoàn thành',
  quarantined: 'Đang kiểm chứng', rejected: 'Không được chấp nhận',
};
const STATUS_EN: Record<Report['status'], string> = {
  received: 'Received', verifying: 'Verifying', processing: 'In progress', resolved: 'Resolved',
  quarantined: 'Under review', rejected: 'Rejected',
};
const CAT_VI = { rac_thai: 'Rác thải', den_duong: 'Đèn đường', ngap_nuoc: 'Ngập nước', mat_duong: 'Mặt đường' } as const;

export interface ChatContext {
  text: string;
  found: Report[];
  scopeLabel: string;
  stats: ReturnType<typeof computeStats>;
}

/** Dựng khối <DATABASE_CONTEXT> từ dữ liệu thật để Gemini không bịa số liệu. */
export class ChatService {
  constructor(private readonly repos: Repositories) {}

  async buildContext(user: UserRecord | null, wardCode: string | undefined, lastUserText: string): Promise<ChatContext> {
    const scope = wardCode && WARD_BY_CODE[wardCode] ? `ward:${wardCode}` : 'city';
    const all = await this.repos.reports.list();
    const visible = all.filter((r) => canSee(user, r));
    // Số liệu tổng hợp dùng toàn bộ hồ sơ trong phạm vi (khớp /api/stats); chi tiết từng hồ sơ vẫn tuân thủ quyền xem.
    const inScope = scope === 'city' ? all : all.filter((r) => r.wardCode === wardCode);
    const stats = computeStats(inScope.map(toClientReport), scope);
    const scopeLabel = scope === 'city' ? 'Toàn TP. Đồng Nai (95 xã, phường)' : WARD_BY_CODE[wardCode!].name;

    const codes = [...new Set((sanitizeUserText(lastUserText).match(CODE_RE) ?? []).map((c) => c.toUpperCase()))].slice(0, 3);
    const found = codes.map((c) => visible.find((r) => r.code.toUpperCase() === c)).filter((r): r is Report => !!r);
    const mine = user ? visible.filter((r) => r.reporterId === user.id).slice(0, 5) : [];

    const lines: string[] = [
      `Địa bàn đang xem: ${scopeLabel}`,
      `Tổng phản ánh: ${stats.total}; đã hoàn thành: ${stats.resolved} (${stats.resolvedPct}%); chưa hoàn thành: ${stats.open}; thời gian xử lý trung bình: ${stats.avgDays} ngày; khẩn cấp đang mở: ${stats.emergency}.`,
      `Theo nhóm: rác thải ${stats.byCategory.rac_thai}, đèn đường ${stats.byCategory.den_duong}, ngập nước ${stats.byCategory.ngap_nuoc}, mặt đường ${stats.byCategory.mat_duong}.`,
      `Danh sách ${DONG_NAI_WARDS.length} xã, phường: ${DONG_NAI_WARDS.map((w) => w.name.replace(/^(Phường|Xã) /, '')).join(', ')}.`,
    ];
    const describe = (r: Report): string => {
      const last = r.timeline[r.timeline.length - 1];
      return `- ${r.code}: "${r.title}" (${CAT_VI[r.category]}, ${WARD_BY_CODE[r.wardCode]?.name}) — trạng thái: ${STATUS_VI[r.status]}; ưu tiên: ${r.priority}; ${r.clusterCount} người cùng phản ánh; hạn xử lý: ${r.slaDueAt ?? 'chưa đặt'}; cập nhật gần nhất: ${last?.note ?? 'không có'}.`;
    };
    if (found.length) lines.push('Hồ sơ người dùng hỏi tới:', ...found.map(describe));
    else if (codes.length) lines.push(`Không tìm thấy hồ sơ nào với mã: ${codes.join(', ')}.`);
    if (mine.length) lines.push('Hồ sơ của chính người dùng đang đăng nhập:', ...mine.map(describe));
    return { text: lines.join('\n'), found, scopeLabel, stats };
  }

  /** Trả lời cục bộ (Chế độ AI Dự phòng) hoàn toàn dựa trên dữ liệu thật. */
  localAnswer(ctx: ChatContext, userText: string, locale: 'vi' | 'en'): string {
    const t = userText.toLowerCase();
    const en = locale === 'en';
    if (ctx.found.length) {
      return ctx.found.map((r) => {
        const st = (en ? STATUS_EN : STATUS_VI)[r.status];
        return en
          ? `Report ${r.code} ("${r.title}") is: ${st}. ${r.clusterCount} residents reported it. Last update: ${r.timeline[r.timeline.length - 1]?.note ?? 'none'}.`
          : `Hồ sơ ${r.code} ("${r.title}") hiện ở trạng thái: ${st}. Có ${r.clusterCount} người dân cùng phản ánh. Cập nhật gần nhất: ${r.timeline[r.timeline.length - 1]?.note ?? 'chưa có'}.`;
      }).join('\n');
    }
    if (/DN-[a-z]{2,4}-\d{4}-\d{3}/i.test(userText)) {
      return en ? 'I could not find that report code. Please check the code (e.g. DN-TB-2611-001) or look it up in "My reports".'
        : 'Mình không tìm thấy hồ sơ với mã đó. Bạn kiểm tra lại mã (ví dụ DN-TB-2611-001) hoặc vào mục "Phản ánh của tôi & Tra cứu" nhé.';
    }
    if (/(bao nhiêu|thống kê|tổng|kpi|how many|statistic|total)/.test(t)) {
      const s = ctx.stats;
      return en
        ? `${ctx.scopeLabel}: ${s.total} reports, ${s.resolved} resolved (${s.resolvedPct}%), average handling time ${s.avgDays} days.`
        : `${ctx.scopeLabel}: ${s.total} phản ánh, ${s.resolved} đã xử lý (${s.resolvedPct}%), thời gian xử lý trung bình ${s.avgDays} ngày.`;
    }
    if (/(khẩn cấp|cháy|tai nạn|giật điện|dây điện|emergency|fire|accident)/.test(t)) {
      return en ? 'If life is in danger, call 113 / 114 / 115 first. Then send a report with a photo so the ward can dispatch help.'
        : 'Nếu có nguy hiểm đến tính mạng, hãy gọi ngay 113 / 114 / 115 trước. Sau đó gửi phản ánh kèm ảnh để phường kịp điều phối hỗ trợ.';
    }
    return en
      ? 'I can help you report an issue in 3 steps: 1) take a photo, 2) confirm the location, 3) send. You can also give me a report code (e.g. DN-TB-2611-001) to check its progress.'
      : 'Mình hướng dẫn bạn gửi phản ánh trong 3 bước: 1) Chụp ảnh, 2) Xác nhận vị trí, 3) Gửi. Bạn cũng có thể nhập mã hồ sơ (ví dụ DN-TB-2611-001) để mình tra tiến độ.';
  }
}
