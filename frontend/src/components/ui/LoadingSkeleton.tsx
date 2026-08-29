import React from 'react';

interface LoadingSkeletonProps {
  rows?: number;
  type?: 'table' | 'card';
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({ rows = 4, type = 'table' }) => {
  if (type === 'card') {
    return (
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="p-4 bg-white rounded-xl border border-slate-200/80 animate-pulse space-y-2.5 shadow-xs">
            <div className="flex items-center justify-between">
              <div className="h-4 bg-slate-200 rounded w-1/3" />
              <div className="h-4 bg-slate-100 rounded w-16" />
            </div>
            <div className="h-3 bg-slate-100 rounded w-2/3" />
            <div className="h-3 bg-slate-100 rounded w-1/4 pt-1" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200/80 overflow-hidden shadow-xs">
      <div className="p-4 border-b border-slate-100 bg-slate-50/50">
        <div className="h-4 bg-slate-200 rounded w-1/4 animate-pulse" />
      </div>
      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="p-4 flex items-center justify-between animate-pulse">
            <div className="space-y-2 flex-1 max-w-md">
              <div className="h-3.5 bg-slate-200 rounded w-2/5" />
              <div className="h-3 bg-slate-100 rounded w-3/5" />
            </div>
            <div className="h-4 bg-slate-100 rounded w-24" />
            <div className="h-4 bg-slate-100 rounded w-16 hidden sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
};
