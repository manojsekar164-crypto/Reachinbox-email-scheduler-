import React from 'react';
import { CheckCircle2, Clock, RefreshCw, Mail } from 'lucide-react';
import type { SearchResultItem } from '../types';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingSkeleton } from '../components/ui/LoadingSkeleton';

interface SentListViewProps {
  logs: SearchResultItem[];
  loading: boolean;
  onRefresh: () => void;
}

export const SentListView: React.FC<SentListViewProps> = ({ logs, loading, onRefresh }) => {
  const formatTime = (isoString?: string) => {
    if (!isoString) return 'Just now';
    const date = new Date(isoString);
    return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs">
        <div>
          <h2 className="text-base font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Sent Emails & Delivery Logs</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Audit trail of successfully dispatched and attempted emails
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Loading Skeleton */}
      {loading && logs.length === 0 && <LoadingSkeleton rows={5} type="table" />}

      {/* Empty State */}
      {!loading && logs.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title="No sent emails yet"
          description="As your scheduled campaigns are processed by the worker, sent logs will appear here in real time."
          iconColor="text-emerald-600 bg-emerald-50 border-emerald-100"
        />
      )}

      {/* Sent Logs Table */}
      {logs.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/70 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-3 px-4">Recipient</th>
                  <th className="py-3 px-4">Subject</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Sent Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3.5 px-4 font-medium text-slate-900 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 shrink-0">
                          <Mail className="w-3 h-3" />
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{log.recipientEmail}</p>
                          {log.recipientName && (
                            <p className="text-[10px] text-slate-400 font-normal">{log.recipientName}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 max-w-sm truncate">
                      <span className="font-medium text-slate-800">{log.subject}</span>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <StatusBadge status={log.status} />
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        <span>{formatTime(log.sentAt || log.updatedAt)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
