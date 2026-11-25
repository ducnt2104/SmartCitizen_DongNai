import { Droplets, Layers, Lightbulb, Route, Trash2, type LucideIcon } from 'lucide-react';
import type { Category, Department, ReportStatus } from '@shared/types';
import type { I18nKey } from '../i18n';

export interface CategoryMeta {
  icon: LucideIcon;
  /** màu pin & chip (hex) */
  color: string;
  labelKey: I18nKey;
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  rac_thai: { icon: Trash2, color: '#92400E', labelKey: 'cat.rac_thai' },
  den_duong: { icon: Lightbulb, color: '#B45309', labelKey: 'cat.den_duong' },
  ngap_nuoc: { icon: Droplets, color: '#0369A1', labelKey: 'cat.ngap_nuoc' },
  mat_duong: { icon: Route, color: '#44403C', labelKey: 'cat.mat_duong' },
  khac: { icon: Layers, color: '#6D28D9', labelKey: 'cat.khac' },
};

export const STATUS_KEY: Record<ReportStatus, I18nKey> = {
  received: 'status.received',
  verifying: 'status.verifying',
  processing: 'status.processing',
  resolved: 'status.resolved',
  quarantined: 'status.quarantined',
  rejected: 'status.rejected',
};

export const DEPT_KEY: Record<Department, I18nKey> = {
  dien_chieu_sang: 'dept.dien_chieu_sang',
  moi_truong: 'dept.moi_truong',
  giao_thong: 'dept.giao_thong',
  ubnd_khu_pho: 'dept.ubnd_khu_pho',
  dien_luc: 'dept.dien_luc',
  csgt: 'dept.csgt',
};

export const PIN_COLOR = {
  resolved: '#10B981',
  emergency: '#E11D48',
  high: '#F59E0B',
  open: '#0B57D0',
};
