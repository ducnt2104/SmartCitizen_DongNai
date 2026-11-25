import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface VirtualListProps<T> {
  items: readonly T[];
  estimateRowHeight: number;
  maxHeightPx?: number;
  overscan?: number;
  virtualizeAbove?: number;
  className?: string;
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string;
}

/**
 * Danh sách ảo hóa (Windowed Virtualization) tối ưu render 60FPS cho danh sách sự cố dài:
 * Chỉ mount các phần tử đang nằm trong vùng nhìn thấy + overscan; dưới ngưỡng `virtualizeAbove` render bình thường.
 */
export function VirtualList<T>({
  items,
  estimateRowHeight,
  maxHeightPx = 680,
  overscan = 4,
  virtualizeAbove = 24,
  className = 'space-y-3',
  renderItem,
  getKey,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  if (items.length <= virtualizeAbove) {
    return (
      <div className={className}>
        {items.map((item, idx) => (
          <div key={getKey(item, idx)}>{renderItem(item, idx)}</div>
        ))}
      </div>
    );
  }

  const totalHeight = items.length * estimateRowHeight;
  const startIdx = Math.max(0, Math.floor(scrollTop / estimateRowHeight) - overscan);
  const visibleCount = Math.ceil(maxHeightPx / estimateRowHeight) + overscan * 2;
  const endIdx = Math.min(items.length, startIdx + visibleCount);
  const visible = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ maxHeight: maxHeightPx }}
      className="overflow-y-auto pr-1"
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          style={{ transform: `translateY(${startIdx * estimateRowHeight}px)` }}
          className={className}
        >
          {visible.map((item, offset) => {
            const idx = startIdx + offset;
            return <div key={getKey(item, idx)}>{renderItem(item, idx)}</div>;
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Hook ảo hóa cho bảng (`<table>`) có nhiều dòng trong IOC Queue & Audit Log:
 * Trả về các dòng đang hiển thị cùng chiều cao spacer trên/dưới để cuộn mượt 60FPS.
 */
export function useTableVirtualWindow<T>(
  rows: readonly T[],
  opts: { rowHeightPx: number; overscan?: number; virtualizeAbove?: number } = { rowHeightPx: 44 },
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(520);

  const rowH = opts.rowHeightPx;
  const overscan = opts.overscan ?? 8;
  const threshold = opts.virtualizeAbove ?? 40;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight || 520);
  }, [rows.length]);

  const active = rows.length > threshold;
  const startIndex = active ? Math.max(0, Math.floor(scrollTop / rowH) - overscan) : 0;
  const visibleCount = active ? Math.ceil(viewportH / rowH) + overscan * 2 : rows.length;
  const endIndex = active ? Math.min(rows.length, startIndex + visibleCount) : rows.length;

  const visibleRows = useMemo(
    () => rows.slice(startIndex, endIndex),
    [rows, startIndex, endIndex],
  );

  return {
    scrollRef,
    onScroll: (top: number) => setScrollTop(top),
    visibleRows,
    startIndex,
    topSpacerPx: active ? startIndex * rowH : 0,
    bottomSpacerPx: active ? Math.max(0, (rows.length - endIndex) * rowH) : 0,
  };
}
