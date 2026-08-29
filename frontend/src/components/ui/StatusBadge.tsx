import React from 'react';

export type StatusType = 'scheduled' | 'sent' | 'failed' | 'delayed' | 'pending' | 'draft' | 'completed' | 'active';

interface StatusBadgeProps {
  status: StatusType | string;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '' }) => {
  const normalized = status.toLowerCase();

  const getStyle = () => {
    switch (normalized) {
      case 'sent':
      case 'completed':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200/80';
      case 'scheduled':
      case 'delayed':
      case 'pending':
        return 'bg-amber-50 text-amber-700 border-amber-200/80';
      case 'failed':
        return 'bg-rose-50 text-rose-700 border-rose-200/80';
      case 'active':
        return 'bg-indigo-50 text-indigo-700 border-indigo-200/80';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200/80';
    }
  };

  const getDot = () => {
    switch (normalized) {
      case 'sent':
      case 'completed':
        return 'bg-emerald-500';
      case 'scheduled':
      case 'delayed':
      case 'pending':
        return 'bg-amber-500';
      case 'failed':
        return 'bg-rose-500';
      case 'active':
        return 'bg-indigo-500';
      default:
        return 'bg-slate-400';
    }
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border capitalize tracking-wide ${getStyle()} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${getDot()}`} />
      <span>{normalized}</span>
    </span>
  );
};
