/**
 * Âm báo tác chiến nhẹ nhàng bằng Web Audio API (không phụ thuộc file âm thanh ngoài, 0% lỗi tải mạng).
 */

let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) {
    sharedCtx = new Ctor();
  }
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume().catch(() => undefined);
  }
  return sharedCtx;
}

function playNotes(notes: ReadonlyArray<{ freq: number; delaySec: number; durSec: number; gain: number }>): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const base = ctx.currentTime;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, base + n.delaySec);
      gain.gain.setValueAtTime(0.0001, base + n.delaySec);
      gain.gain.exponentialRampToValueAtTime(n.gain, base + n.delaySec + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, base + n.delaySec + n.durSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(base + n.delaySec);
      osc.stop(base + n.delaySec + n.durSec + 0.02);
    }
  } catch {
    // Bỏ qua yên lặng nếu trình duyệt chưa nhận tương tác đầu tiên của người dùng
  }
}

/** Chuông báo nhẹ 2 nhịp khi có đơn sự cố / SOS mới gửi tới đội trực chiến. */
export function playIncomingMissionChime(isUrgent = false): void {
  if (isUrgent) {
    playNotes([
      { freq: 784, delaySec: 0, durSec: 0.14, gain: 0.14 },
      { freq: 1046.5, delaySec: 0.16, durSec: 0.18, gain: 0.16 },
      { freq: 1318.5, delaySec: 0.36, durSec: 0.24, gain: 0.14 },
    ]);
  } else {
    playNotes([
      { freq: 659.25, delaySec: 0, durSec: 0.14, gain: 0.11 },
      { freq: 880, delaySec: 0.16, durSec: 0.22, gain: 0.12 },
    ]);
  }
}

/** Âm xác nhận ngắn khi nhận đơn hoặc hoàn thành nhiệm vụ. */
export function playMissionSuccessChime(): void {
  playNotes([
    { freq: 587.33, delaySec: 0, durSec: 0.11, gain: 0.1 },
    { freq: 880, delaySec: 0.12, durSec: 0.2, gain: 0.12 },
  ]);
}
