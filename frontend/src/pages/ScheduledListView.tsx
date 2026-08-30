import React, { useState } from 'react';
import { Calendar, RefreshCw, Plus, Shield, Clock, Users, Trash2, X, Mail } from 'lucide-react';
import type { Campaign, Sender, Recipient } from '../types';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingSkeleton } from '../components/ui/LoadingSkeleton';
import { campaignApi } from '../services/api';
import { useToast } from '../context/ToastContext';

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
  const { success, error } = useToast();
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const handleOpenRecipients = async (campaign: Campaign) => {
    setSelectedCampaign(campaign);
    try {
      setRecipientsLoading(true);
      const res = await campaignApi.getRecipients(campaign.id);
      setRecipients(Array.isArray(res) ? res : []);
    } catch (err: any) {
      error(err.message || 'Failed to load campaign recipients');
    } finally {
      setRecipientsLoading(false);
    }
  };

  const handleDeleteCampaign = async (campaignId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to cancel and delete this campaign?')) return;
    try {
      setDeletingId(campaignId);
      await campaignApi.delete(campaignId);
      success('Campaign cancelled and deleted successfully.');
      onRefresh();
      if (selectedCampaign?.id === campaignId) {
        setSelectedCampaign(null);
      }
    } catch (err: any) {
      error(err.message || 'Failed to delete campaign');
    } finally {
      setDeletingId(null);
    }
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={onComposeClick}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-xs font-bold shadow-xs transition-colors cursor-pointer"
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
                  <th className="py-3 px-4">Scheduled For</th>
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
                    <tr
                      key={camp.id}
                      onClick={() => handleOpenRecipients(camp)}
                      className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                    >
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
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenRecipients(camp);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded-md transition-colors"
                          >
                            <Users className="w-3 h-3" />
                            <span>Recipients</span>
                          </button>
                          <button
                            onClick={(e) => handleDeleteCampaign(camp.id, e)}
                            disabled={deletingId === camp.id}
                            className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors disabled:opacity-50"
                            title="Cancel & Delete Campaign"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recipient / Campaign Details Modal */}
      {selectedCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/60">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
                  <Mail className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-900 truncate max-w-xs">{selectedCampaign.subject}</h3>
                  <p className="text-xs text-slate-500">
                    {formatScheduleTime(selectedCampaign.scheduled_at)} • {selectedCampaign.hourly_limit}/hr limit
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedCampaign(null)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto space-y-4 text-xs">
              <div>
                <p className="font-semibold text-slate-500 uppercase tracking-wider text-[10px] mb-1">Email Body</p>
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-slate-700 whitespace-pre-wrap font-mono text-[11px]">
                  {selectedCampaign.body}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold text-slate-500 uppercase tracking-wider text-[10px]">
                    Recipients ({recipients.length})
                  </p>
                </div>

                {recipientsLoading ? (
                  <div className="py-6 text-center text-slate-400">Loading recipient list...</div>
                ) : recipients.length === 0 ? (
                  <div className="py-6 text-center text-slate-400">No recipients found for this campaign.</div>
                ) : (
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                    {recipients.map((r) => (
                      <div key={r.id} className="p-2.5 flex items-center justify-between bg-white hover:bg-slate-50">
                        <div>
                          <p className="font-semibold text-slate-900">{r.email}</p>
                          {r.name && <p className="text-[10px] text-slate-400">{r.name}</p>}
                        </div>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                          Queued
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end px-6 py-3 border-t border-slate-100 bg-slate-50/60">
              <button
                onClick={() => setSelectedCampaign(null)}
                className="px-4 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 font-semibold text-xs hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
