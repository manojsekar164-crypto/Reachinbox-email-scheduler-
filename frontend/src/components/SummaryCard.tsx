import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface SummaryCardProps {
  title: string;
  value: number | string;
  icon: LucideIcon;
  color: 'indigo' | 'emerald' | 'rose' | 'amber' | 'slate';
  description?: string;
}

export const SummaryCard: React.FC<SummaryCardProps> = ({
  title,
  value,
  icon: Icon,
  color,
  description,
}) => {
  const colorMap = {
    indigo: {
      bg: 'bg-indigo-50/70 text-indigo-600 border-indigo-100',
      text: 'text-indigo-600',
    },
    emerald: {
      bg: 'bg-emerald-50/70 text-emerald-600 border-emerald-100',
      text: 'text-emerald-600',
    },
    rose: {
      bg: 'bg-rose-50/70 text-rose-600 border-rose-100',
      text: 'text-rose-600',
    },
    amber: {
      bg: 'bg-amber-50/70 text-amber-600 border-amber-100',
      text: 'text-amber-600',
    },
    slate: {
      bg: 'bg-slate-50 text-slate-600 border-slate-200',
      text: 'text-slate-600',
    },
  };

  const style = colorMap[color];

  return (
    <div className="bg-white rounded-xl border border-slate-200/80 p-4 shadow-xs hover:border-slate-300 transition-colors flex items-center justify-between gap-4">
      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{title}</p>
        <p className="text-2xl font-bold text-slate-900 tracking-tight">{value}</p>
        {description && <p className="text-[10px] text-slate-400 font-medium">{description}</p>}
      </div>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center border shrink-0 ${style.bg}`}>
        <Icon className="w-5 h-5" />
      </div>
    </div>
  );
};
