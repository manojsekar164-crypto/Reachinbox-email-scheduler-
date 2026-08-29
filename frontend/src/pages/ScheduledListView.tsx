import React from 'react';
import { Calendar, RefreshCw, Plus, Shield, Clock } from 'lucide-react';
import type { Campaign, Sender } from '../types';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingSkeleton } from '../components/ui/LoadingSkeleton';

interface ScheduledListViewProps {
  campaigns: Campaign[];
  senders: Sender[];
  loading: boolean;
  onRefresh: () => void;
  onComposeClick: () => void;
}

export const ScheduledListView: React.FC<ScheduledListViewProps> = ({
  campaigns,
  senders,
  loading,
  onRefresh,
  onComposeClick,
}) => {
  const getSenderName = (senderId: string | null) => {
    if (!senderId) return 'Default Sender';
    const s = senders.find((s) => s.id === senderId);
    return s ? `${s.name} (${s.email})` : 'Active Sender';
  };

  const formatScheduleTime = (isoString: string | null) => {
    if (!isoString) return 'Immediate (Enqueued)';
    const date = new Date(isoString);
    return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs">
        <div>
          <h2 className="text-base font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Calendar className="w-4 h-4 text-indigo-600" />
            <span>Scheduled Campaigns</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Manage your upcoming email campaigns and automated delivery queues
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={onComposeClick}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-xs font-bold shadow-xs transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Compose New Email</span>
          </button>
        </div>
      </div>

      {/* Loading Skeleton */}
      {loading && campaigns.length === 0 && <LoadingSkeleton rows={4} type="table" />}

      {/* Empty State */}
      {!loading && campaigns.length === 0 && (
        <EmptyState
          icon={Calendar}
          title="No scheduled campaigns yet"
          description="Create your first campaign to start sending personalized emails to your audience."
          actionLabel="Compose New Email"
          onAction={onComposeClick}
        />
      )}

      {/* Professional Scheduled Table */}
      {campaigns.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/70 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-3 px-4">Campaign</th>
                  <th className="py-3 px-4">Sender</th>
                  <th className="py-3 px-4">Scheduled</th>
                  <th className="py-3 px-4">Rate Limit</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {campaigns.map((camp) => {
                  const isFuture = camp.scheduled_at ? new Date(camp.scheduled_at).getTime() > Date.now() : false;
                  const displayStatus = isFuture ? 'scheduled' : camp.status;

                  return (
                    <tr key={camp.id} className="hover:bg-slate-50/60 transition-colors">
                      <td className="py-3.5 px-4 max-w-xs">
                        <p className="font-bold text-slate-900 truncate">{camp.subject}</p>
                        <p className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">{camp.body}</p>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className="font-medium text-slate-800">{getSenderName(camp.sender_id)}</span>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-slate-600">
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          <span>{formatScheduleTime(camp.scheduled_at)}</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1 text-slate-600">
                          <Shield className="w-3.5 h-3.5 text-slate-400" />
                          <span>{camp.hourly_limit}/hr</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <StatusBadge status={displayStatus} />
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <button
                          onClick={onComposeClick}
                          className="px-2.5 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded-md transition-colors"
                        >
                          Duplicate
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
