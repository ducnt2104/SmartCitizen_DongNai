import type { ModerationDecision } from '../../shared/types';
import { TRUST_AUTO_APPROVE_BONUS, TRUST_SPAM_PENALTY } from '../../shared/constants';
import type { AiEvaluationRepository } from '../../repositories/types';
import { newId } from '../../utils/crypto';
import type { CacheService } from '../cache.service';
import type { TrustService } from '../trust.service';

export interface Stage2TaskInput {
  userId?: string;
  reportId?: string;
  decision?: ModerationDecision;
  authenticityScore: number;
  fraudFlags: string[];
  engineMode: string;
  latencyMs: number;
  summary: string;
}

/**
 * Stage 2: Async Non-Blocking Post-Processing & Citizen Trust Score.
 * Chạy hậu cảnh sau khi phản hồi HTTP để giữ độ trễ API ở mức tối thiểu.
 */
export class Stage2PostProcessorService {
  constructor(
    private readonly trust: TrustService,
    private readonly evaluations: AiEvaluationRepository,
    private readonly cache?: CacheService,
  ) {}

  schedulePostProcess(task: Stage2TaskInput): void {
    setImmediate(() => {
      void this.execute(task).catch((err) => {
        console.warn('[stage2] Hậu kiểm bất đồng bộ gặp lỗi nhẹ:', err instanceof Error ? err.message : err);
      });
    });
  }

  async execute(task: Stage2TaskInput): Promise<void> {
    this.cache?.invalidateReports();

    const ops: Array<Promise<unknown>> = [];

    if (task.userId && task.decision) {
      if (task.decision === 'AUTO_APPROVE') {
        ops.push(this.adjustTrust(task.userId, TRUST_AUTO_APPROVE_BONUS));
      } else if (task.decision === 'AUTO_REJECT') {
        ops.push(this.adjustTrust(task.userId, -TRUST_SPAM_PENALTY));
      }
    }

    if (task.reportId) {
      ops.push(
        this.evaluations.append({
          id: newId('ev'),
          reportId: task.reportId,
          kind: 'authenticity',
          authenticityScore: task.authenticityScore,
          sceneMatchScore: null,
          resolutionScore: null,
          isAuthentic: task.decision !== 'AUTO_REJECT',
          isDuplicate: null,
          resolutionVerified: null,
          inlierCount: 0,
          flags: task.fraudFlags,
          engineMode: task.engineMode,
          latencyMs: task.latencyMs,
          summary: task.summary,
          createdAt: new Date().toISOString(),
        }),
      );
    }

    await Promise.allSettled(ops);
  }

  private async adjustTrust(userId: string, delta: number): Promise<void> {
    if (delta >= 0) {
      await this.trust.rewardAutoApproved(userId, delta);
    } else {
      await this.trust.penalizeSpam(userId, Math.abs(delta));
    }
  }
}
