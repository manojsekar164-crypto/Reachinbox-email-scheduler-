import React, { useState, useEffect, useCallback } from 'react';
import {
  RotateCcw,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Search,
  RefreshCw,
  History,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  Info,
  Check,
} from 'lucide-react';
import type { EmailDelivery, DeliveryAttempt } from '../types';
import { deliveryApi } from '../services/api';
import { useToast } from '../context/ToastContext';

export const RecoveryCenterView: React.FC = () => {
  const { success, error } = useToast();

  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'all' | 'failed' | 'unknown'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  // Manual Retry State
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Attempt History Modal
  const [historyDelivery, setHistoryDelivery] = useState<EmailDelivery | null>(null);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);

  // Operator Resolution Modal for Unknown Deliveries
  const [resolvingDelivery, setResolvingDelivery] = useState<EmailDelivery | null>(null);
  const [resolutionType, setResolutionType] = useState<'confirmed_delivered' | 'confirmed_failed'>('confirmed_delivered');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [resolutionSubmitting, setResolutionSubmitting] = useState(false);

  const loadDeliveries = useCallback(async () => {
    try {
      setLoading(true);
      const params: any = {
        page,
        limit: 15,
      };

      if (activeFilter === 'failed') {
        params.status = 'failed';
      } else if (activeFilter === 'unknown') {
        params.status = 'unknown';
      } else {
        params.status = 'failed,unknown';
      }

      const res = await deliveryApi.list(params);
      setDeliveries(res.deliveries || []);
      setTotalItems(res.pagination?.total || 0);
      setTotalPages(Math.max(1, Math.ceil((res.pagination?.total || 0) / (res.pagination?.limit || 15))));
    } catch (err: any) {
      error(err.message || 'Failed to fetch delivery issues');
    } finally {
      setLoading(false);
    }
  }, [page, activeFilter, error]);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  // Handle Safe Manual Retry
  const handleManualRetry = async (deliveryId: string) => {
    try {
      setRetryingId(deliveryId);
      const res = await deliveryApi.retry(deliveryId);
      success(res.message || 'Manual retry queued successfully!', 'Dispatch Scheduled');
      await loadDeliveries();
    } catch (err: any) {
      error(err.message || 'Manual retry rejected');
    } finally {
      setRetryingId(null);
    }
  };

  // Open Attempt History Modal
  const handleOpenHistory = async (delivery: EmailDelivery) => {
    setHistoryDelivery(delivery);
    try {
      setAttemptsLoading(true);
      const res = await deliveryApi.getAttempts(delivery.id);
      setAttempts(res.attempts || []);
    } catch (err: any) {
      error(err.message || 'Failed to load attempt history');
    } finally {
      setAttemptsLoading(false);
    }
  };

  // Submit Operator Resolution for Unknown Outcome
  const handleSubmitResolution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolvingDelivery) return;

    try {
      setResolutionSubmitting(true);
      await deliveryApi.resolve(resolvingDelivery.id, resolutionType, resolutionNotes);
      success(
        `Delivery resolved as ${resolutionType === 'confirmed_delivered' ? 'Confirmed Delivered' : 'Confirmed Failed'}.`,
        'Operator Resolution Applied'
      );
      setResolvingDelivery(null);
      setResolutionNotes('');
      await loadDeliveries();
    } catch (err: any) {
      error(err.message || 'Failed to apply resolution');
    } finally {
      setResolutionSubmitting(false);
    }
  };

  const filteredDeliveries = deliveries.filter((d) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (
      (d.recipient_email && d.recipient_email.toLowerCase().includes(term)) ||
      (d.campaign_subject && d.campaign_subject.toLowerCase().includes(term)) ||
      (d.last_error && d.last_error.toLowerCase().includes(term)) ||
      (d.sender_name && d.sender_name.toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-rose-50 text-rose-600 border border-rose-100">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 tracking-tight">Delivery Recovery Center</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Audit failure classifications, examine SMTP attempt records, safely retry, and resolve ambiguous outcomes
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => loadDeliveries()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-600' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200/80 shadow-xs">
        {/* Status Filters */}
        <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl">
          <button
            onClick={() => {
              setActiveFilter('all');
              setPage(1);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeFilter === 'all'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All Issues ({totalItems})
          </button>
          <button
            onClick={() => {
              setActiveFilter('failed');
              setPage(1);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeFilter === 'failed'
                ? 'bg-white text-rose-700 shadow-xs'
                : 'text-slate-600 hover:text-rose-700'
            }`}
          >
            <XCircle className="w-3.5 h-3.5 text-rose-500" />
            <span>Failed Deliveries</span>
          </button>
          <button
            onClick={() => {
              setActiveFilter('unknown');
              setPage(1);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeFilter === 'unknown'
                ? 'bg-white text-amber-700 shadow-xs'
                : 'text-slate-600 hover:text-amber-700'
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5 text-amber-500" />
            <span>Unknown / Review</span>
          </button>
        </div>

        {/* Search Input */}
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search email, error, or campaign..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50/80 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:bg-white transition-colors"
          />
        </div>
      </div>

      {/* Main Deliveries Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50/80 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3 px-4">Recipient</th>
                <th className="py-3 px-4">Campaign</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Last Error Classification</th>
                <th className="py-3 px-4">Attempts</th>
                <th className="py-3 px-4">Retry Eligibility</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading && deliveries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-indigo-500" />
                    <span>Loading delivery incident records...</span>
                  </td>
                </tr>
              ) : filteredDeliveries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center mx-auto mb-2">
                      <CheckCircle2 className="w-5 h-5" />
                    </div>
                    <p className="font-semibold text-slate-800 text-xs">No delivery failures or incidents detected</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      All email campaigns are dispatched smoothly without pending operator reviews.
                    </p>
                  </td>
                </tr>
              ) : (
                filteredDeliveries.map((delivery) => {
                  const isUnknown = delivery.status === 'unknown';
                  const isFailed = delivery.status === 'failed';
                  const isEligible = delivery.retry_eligibility?.is_eligible ?? false;

                  return (
                    <tr key={delivery.id} className="hover:bg-slate-50/80 transition-colors">
                      {/* Recipient */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <p className="font-bold text-slate-900">{delivery.recipient_email || 'Recipient'}</p>
                        {delivery.recipient_name && (
                          <p className="text-[11px] text-slate-500">{delivery.recipient_name}</p>
                        )}
                      </td>

                      {/* Campaign */}
                      <td className="py-3 px-4 max-w-xs">
                        <p className="font-medium text-slate-800 truncate">
                          {delivery.campaign_subject || delivery.campaign_id}
                        </p>
                      </td>

                      {/* Status Badge */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        {isUnknown ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                            <HelpCircle className="w-3 h-3" />
                            <span>Unknown (Review)</span>
                          </span>
                        ) : isFailed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                            <XCircle className="w-3 h-3" />
                            <span>Failed</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                            <span>{delivery.status}</span>
                          </span>
                        )}
                      </td>

                      {/* Last Error */}
                      <td className="py-3 px-4 max-w-xs truncate" title={delivery.last_error || delivery.latest_attempt?.error_message || 'No error details'}>
                        <span className="font-mono text-[11px] text-rose-700 bg-rose-50/50 px-1.5 py-0.5 rounded border border-rose-100">
                          {delivery.latest_attempt?.error_classification || delivery.last_error || '—'}
                        </span>
                      </td>

                      {/* Attempts */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleOpenHistory(delivery)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
                        >
                          <History className="w-3 h-3" />
                          <span>{delivery.attempt_count ?? 0} attempt(s)</span>
                        </button>
                      </td>

                      {/* Retry Eligibility */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        {isUnknown ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200"
                            title="Auto-retry blocked to prevent duplicate dispatches. Operator resolution required."
                          >
                            <Info className="w-3 h-3" />
                            <span>Resolution Required</span>
                          </span>
                        ) : isEligible ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
                            title={delivery.retry_eligibility?.reason || 'Eligible for safe manual retry'}
                          >
                            <Check className="w-3 h-3" />
                            <span>Retry Eligible</span>
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500 border border-slate-200"
                            title={delivery.retry_eligibility?.reason || 'Permanent failure (mailbox not found or policy rejection)'}
                          >
                            <span>Permanent Ineligible</span>
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          {isUnknown ? (
                            <button
                              type="button"
                              onClick={() => {
                                setResolvingDelivery(delivery);
                                setResolutionType('confirmed_delivered');
                                setResolutionNotes('');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-lg shadow-xs transition-colors"
                            >
                              <HelpCircle className="w-3 h-3" />
                              <span>Resolve</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={!isEligible || retryingId === delivery.id}
                              onClick={() => handleManualRetry(delivery.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:text-indigo-600 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 rounded-lg shadow-xs transition-colors disabled:opacity-40 disabled:pointer-events-none"
                              title={isEligible ? 'Trigger safe manual retry' : 'Cannot retry permanent rejection'}
                            >
                              <RotateCcw
                                className={`w-3 h-3 ${retryingId === delivery.id ? 'animate-spin text-indigo-600' : ''}`}
                              />
                              <span>{retryingId === delivery.id ? 'Retrying...' : 'Retry'}</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 bg-slate-50/70 border-t border-slate-200 text-xs text-slate-600">
            <span>
              Showing {filteredDeliveries.length} of {totalItems} total record(s)
            </span>
            <div className="flex items-center gap-1.5">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="px-2 font-medium">
                Page {page} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Attempt History Modal */}
      {historyDelivery && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 bg-slate-50/80">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-600" />
                <h3 className="font-bold text-sm text-slate-900">Attempt Audit Trail</h3>
              </div>
              <button
                onClick={() => setHistoryDelivery(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                &times;
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-3">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
                <p>
                  <span className="font-bold text-slate-700">Recipient:</span> {historyDelivery.recipient_email}
                </p>
                <p>
                  <span className="font-bold text-slate-700">Campaign:</span>{' '}
                  {historyDelivery.campaign_subject || historyDelivery.campaign_id}
                </p>
                <p>
                  <span className="font-bold text-slate-700">Current Status:</span>{' '}
                  <span className="uppercase font-semibold">{historyDelivery.status}</span>
                </p>
              </div>

              <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider mt-4">
                Attempt Records ({attempts.length})
              </h4>

              {attemptsLoading ? (
                <div className="text-center py-6 text-slate-400">
                  <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-1 text-indigo-500" />
                  <span className="text-xs">Loading attempt records...</span>
                </div>
              ) : attempts.length === 0 ? (
                <p className="text-xs text-slate-500 italic py-4 text-center">No individual attempts recorded.</p>
              ) : (
                <div className="space-y-2">
                  {attempts.map((att) => (
                    <div
                      key={att.id}
                      className="p-3 rounded-xl border border-slate-200 bg-white space-y-1 text-xs hover:border-slate-300 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900">Attempt #{att.attempt_number}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            att.status === 'sent'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-rose-50 text-rose-700 border border-rose-200'
                          }`}
                        >
                          {att.status.toUpperCase()}
                        </span>
                      </div>
                      {att.smtp_response_code && (
                        <p className="text-[11px] text-slate-600">
                          <span className="font-semibold">SMTP Code:</span> {att.smtp_response_code}
                        </p>
                      )}
                      {att.error_classification && (
                        <p className="text-[11px] text-slate-600">
                          <span className="font-semibold">Classification:</span> {att.error_classification}
                        </p>
                      )}
                      {att.error_message && (
                        <p className="text-[11px] text-rose-700 font-mono bg-rose-50/50 p-1 rounded">
                          {att.error_message}
                        </p>
                      )}
                      <p className="text-[10px] text-slate-400 pt-1">
                        Attempted at {new Date(att.attempted_at).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-3 border-t border-slate-100 bg-slate-50/80 text-right">
              <button
                type="button"
                onClick={() => setHistoryDelivery(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Operator Resolution Modal */}
      {resolvingDelivery && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <form
            onSubmit={handleSubmitResolution}
            className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150"
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 bg-slate-50/80">
              <div className="flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-amber-600" />
                <h3 className="font-bold text-sm text-slate-900">Resolve Unknown Outcome</h3>
              </div>
              <button
                type="button"
                onClick={() => setResolvingDelivery(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                &times;
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="p-3 rounded-xl bg-amber-50/70 border border-amber-200 text-amber-900 space-y-1">
                <p className="font-bold">Manual Operator Review Required</p>
                <p className="text-[11px] leading-relaxed">
                  This delivery reached an ambiguous SMTP timeout or dropped connection. To prevent duplicate email
                  sends to <span className="font-bold">{resolvingDelivery.recipient_email}</span>, specify the confirmed outcome.
                </p>
              </div>

              <div className="space-y-2">
                <label className="font-bold text-slate-800 block">Select Confirmed Outcome</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setResolutionType('confirmed_delivered')}
                    className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-all ${
                      resolutionType === 'confirmed_delivered'
                        ? 'border-emerald-500 bg-emerald-50/50 text-emerald-900 shadow-xs'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 mb-1" />
                    <span className="font-bold text-xs">Delivered</span>
                    <span className="text-[10px] text-slate-500">Confirmed reached inbox</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setResolutionType('confirmed_failed')}
                    className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-all ${
                      resolutionType === 'confirmed_failed'
                        ? 'border-rose-500 bg-rose-50/50 text-rose-900 shadow-xs'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <XCircle className="w-4 h-4 text-rose-600 mb-1" />
                    <span className="font-bold text-xs">Failed</span>
                    <span className="text-[10px] text-slate-500">Confirmed not delivered</span>
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-bold text-slate-800 block">Audit Notes (Optional)</label>
                <textarea
                  rows={3}
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  placeholder="e.g. Verified via mail server logs or recipient confirmed receipt."
                  className="w-full p-2.5 rounded-xl border border-slate-200 text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50/80">
              <button
                type="button"
                onClick={() => setResolvingDelivery(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={resolutionSubmitting}
                className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white shadow-xs transition-colors disabled:opacity-50"
              >
                {resolutionSubmitting ? 'Submitting...' : 'Apply Resolution'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
