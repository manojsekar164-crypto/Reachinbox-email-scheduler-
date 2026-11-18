import React, { useState, useEffect } from 'react';
import { X, Shield, Plus, Trash2, Mail, Lock, Activity, CheckCircle, AlertTriangle, AlertCircle, RefreshCw, Edit2 } from 'lucide-react';
import type { Sender, SenderHealthMetrics, AllSendersHealthSummary } from '../types';
import { senderApi } from '../services/api';
import { useToast } from '../context/ToastContext';

interface SenderManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  senders: Sender[];
  onSendersUpdated: () => Promise<void>;
}

export const SenderManagerModal: React.FC<SenderManagerModalProps> = ({
  isOpen,
  onClose,
  senders,
  onSendersUpdated,
}) => {
  const { success, error } = useToast();

  const [isAdding, setIsAdding] = useState(false);
  const [editingSender, setEditingSender] = useState<Sender | null>(null);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthMap, setHealthMap] = useState<Record<string, SenderHealthMetrics>>({});
  const [healthSummary, setHealthSummary] = useState<AllSendersHealthSummary | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [smtpHost, setSmtpHost] = useState('smtp.ethereal.email');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');

  const loadHealth = async () => {
    try {
      setHealthLoading(true);
      const summary = await senderApi.getHealth();
      setHealthSummary(summary);
      const map: Record<string, SenderHealthMetrics> = {};
      for (const m of summary.senders) {
        map[m.sender_id] = m;
      }
      setHealthMap(map);
    } catch (err) {
      console.warn('Failed to load sender health metrics:', err);
    } finally {
      setHealthLoading(false);
    }
  };

  // Fetch health metrics for all senders with unmount cleanup guard
  useEffect(() => {
    let isMounted = true;
    if (isOpen) {
      setHealthLoading(true);
      senderApi
        .getHealth()
        .then((summary) => {
          if (isMounted) {
            setHealthSummary(summary);
            const map: Record<string, SenderHealthMetrics> = {};
            for (const m of summary.senders) {
              map[m.sender_id] = m;
            }
            setHealthMap(map);
          }
        })
        .catch((err) => {
          console.warn('Failed to load sender health metrics:', err);
        })
        .finally(() => {
          if (isMounted) {
            setHealthLoading(false);
          }
        });
    }
    return () => {
      isMounted = false;
    };
  }, [isOpen, senders]);

  if (!isOpen) return null;

  const resetForm = () => {
    setName('');
    setEmail('');
    setSmtpHost('smtp.ethereal.email');
    setSmtpPort(587);
    setSmtpSecure(false);
    setSmtpUser('');
    setSmtpPass('');
    setIsAdding(false);
    setEditingSender(null);
  };

  const handleStartEdit = (s: Sender) => {
    setEditingSender(s);
    setName(s.name);
    setEmail(s.email);
    setSmtpHost(s.smtp_host);
    setSmtpPort(s.smtp_port);
    setSmtpSecure(s.smtp_secure);
    setSmtpUser(s.smtp_user);
    setSmtpPass('');
    setIsAdding(false);
  };

  const handleSaveSender = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      error('Sender name is required');
      return;
    }
    if (!email.trim()) {
      error('Sender email is required');
      return;
    }
    if (!smtpHost.trim()) {
      error('SMTP host is required');
      return;
    }
    if (!smtpUser.trim()) {
      error('SMTP username is required');
      return;
    }
    if (!editingSender && !smtpPass) {
      error('SMTP password is required');
      return;
    }

    try {
      setLoading(true);
      if (editingSender) {
        const updates: {
          name: string;
          email: string;
          smtp_host: string;
          smtp_port: number;
          smtp_secure: boolean;
          smtp_user: string;
          smtp_pass?: string;
        } = {
          name: name.trim(),
          email: email.trim().toLowerCase(),
          smtp_host: smtpHost.trim(),
          smtp_port: Number(smtpPort) || 587,
          smtp_secure: !!smtpSecure,
          smtp_user: smtpUser.trim(),
        };
        if (smtpPass) {
          updates.smtp_pass = smtpPass;
        }
        await senderApi.update(editingSender.id, updates);
        success(`Sender profile "${name.trim()}" updated successfully!`, 'Sender Updated');
      } else {
        await senderApi.create({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          smtp_host: smtpHost.trim(),
          smtp_port: Number(smtpPort) || 587,
          smtp_secure: !!smtpSecure,
          smtp_user: smtpUser.trim(),
          smtp_pass: smtpPass,
        });
        success('Sender profile created successfully!', 'Sender Added');
      }

      resetForm();
      await onSendersUpdated();
      await loadHealth();
    } catch (err: any) {
      error(err.message || 'Failed to save sender profile');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSender = async (id: string, senderName: string) => {
    if (!window.confirm(`Are you sure you want to delete sender profile "${senderName}"?`)) {
      return;
    }

    try {
      setDeletingId(id);
      await senderApi.delete(id);
      success(`Sender "${senderName}" deleted successfully.`);
      await onSendersUpdated();
    } catch (err: any) {
      error(err.message || 'Failed to delete sender');
    } finally {
      setDeletingId(null);
    }
  };

  const handleProbeSender = async (id: string, senderName: string) => {
    try {
      setProbingId(id);
      const res = await senderApi.probe(id);
      if (res.reachable && res.authenticated) {
        success(`SMTP connection verified successfully (${res.latency_ms}ms)`, `${senderName} Healthy`);
      } else {
        error(res.error_message || 'SMTP probe failed to authenticate', `${senderName} Warning`);
      }
      await loadHealth();
    } catch (err: any) {
      error(err.message || 'SMTP probe request failed');
    } finally {
      setProbingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-2xl max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm sm:text-base text-slate-900">Sender Profiles</h3>
              <p className="text-xs text-slate-500">Configure verified SMTP senders for your email campaigns</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {!isAdding && !editingSender ? (
            /* Senders List View */
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">
                  Active Sender Accounts ({senders.length})
                </span>
                <button
                  onClick={() => setIsAdding(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-xs transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Sender</span>
                </button>
              </div>

              {/* Aggregate Fleet Health Banner */}
              {healthSummary && senders.length > 0 && (
                <div className="p-3.5 bg-slate-50/80 rounded-xl border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5 text-indigo-600" />
                      <span>Fleet Health Overview</span>
                    </span>
                    <span className="text-xs font-extrabold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">
                      Fleet Reputation: {healthSummary.overall_reputation_score}%
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center text-xs">
                    <div className="bg-white p-2 rounded-lg border border-slate-200">
                      <span className="text-[10px] text-slate-500 block font-medium">Total</span>
                      <span className="font-bold text-slate-900">{healthSummary.total_senders}</span>
                    </div>
                    <div className="bg-white p-2 rounded-lg border border-emerald-200">
                      <span className="text-[10px] text-emerald-600 block font-medium">Healthy</span>
                      <span className="font-bold text-emerald-700">{healthSummary.healthy_count}</span>
                    </div>
                    <div className="bg-white p-2 rounded-lg border border-amber-200">
                      <span className="text-[10px] text-amber-600 block font-medium">Degraded</span>
                      <span className="font-bold text-amber-700">{healthSummary.degraded_count}</span>
                    </div>
                    <div className="bg-white p-2 rounded-lg border border-rose-200">
                      <span className="text-[10px] text-rose-600 block font-medium">Quarantined</span>
                      <span className="font-bold text-rose-700">{healthSummary.quarantined_count}</span>
                    </div>
                  </div>
                </div>
              )}

              {senders.length === 0 ? (
                <div className="text-center py-10 px-4 bg-slate-50/70 rounded-xl border border-dashed border-slate-200">
                  <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 mx-auto mb-2.5 shadow-xs">
                    <Mail className="w-5 h-5" />
                  </div>
                  <h4 className="text-xs font-bold text-slate-900">No sender profiles yet</h4>
                  <p className="text-[11px] text-slate-500 max-w-xs mx-auto mt-1 mb-3.5 leading-relaxed">
                    Add an Ethereal SMTP sender to start composing and scheduling email campaigns.
                  </p>
                  <button
                    onClick={() => setIsAdding(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-xs transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Ethereal Sender</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {senders.map((s) => {
                    const health = healthMap[s.id];
                    let badgeStyles = 'bg-slate-50 text-slate-600 border-slate-200';
                    let badgeLabel = healthLoading ? 'Checking...' : 'Pending';
                    let badgeIcon = healthLoading ? (
                      <RefreshCw className="w-2.5 h-2.5 animate-spin text-slate-500" />
                    ) : (
                      <AlertCircle className="w-2.5 h-2.5 text-slate-400" />
                    );

                    if (health) {
                      if (health.health_status === 'healthy') {
                        badgeStyles = 'bg-emerald-50 text-emerald-700 border-emerald-200';
                        badgeLabel = 'Healthy';
                        badgeIcon = <CheckCircle className="w-2.5 h-2.5" />;
                      } else if (health.health_status === 'degraded') {
                        badgeStyles = 'bg-amber-50 text-amber-700 border-amber-200';
                        badgeLabel = 'Degraded';
                        badgeIcon = <AlertTriangle className="w-2.5 h-2.5" />;
                      } else if (health.health_status === 'quarantined') {
                        badgeStyles = 'bg-rose-50 text-rose-700 border-rose-200';
                        badgeLabel = 'Quarantined';
                        badgeIcon = <AlertCircle className="w-2.5 h-2.5" />;
                      }
                    } else if (!healthLoading) {
                      badgeLabel = 'Unavailable';
                      badgeIcon = <AlertCircle className="w-2.5 h-2.5 text-slate-400" />;
                    }

                    return (
                      <div
                        key={s.id}
                        className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs hover:border-slate-300 transition-colors flex items-center justify-between gap-3"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-xs text-slate-900 truncate">{s.name}</span>
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
                              {s.smtp_host}:{s.smtp_port}
                            </span>
                            <span
                              className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border flex items-center gap-1 ${badgeStyles}`}
                              title={health?.health_reasons?.join(' ') || (healthLoading ? 'Assessing health...' : 'Health status unavailable')}
                            >
                              {badgeIcon}
                              <span>{badgeLabel}</span>
                              {health && (
                                <span className="opacity-75">({health.reputation_score}%)</span>
                              )}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-slate-500">
                            <span className="truncate">{s.email}</span>
                            {health && health.unique_deliveries > 0 && (
                              <span className="text-slate-400">
                                • {health.acceptance_rate}% accept ({health.sent_deliveries}/{health.unique_deliveries})
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleProbeSender(s.id, s.name)}
                            disabled={probingId === s.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:text-indigo-600 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 rounded-lg transition-colors disabled:opacity-50"
                            title="Perform live SMTP connectivity and authentication probe"
                          >
                            {probingId === s.id ? (
                              <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                            ) : (
                              <Activity className="w-3.5 h-3.5 text-indigo-500" />
                            )}
                            <span>{probingId === s.id ? 'Testing...' : 'Test'}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleStartEdit(s)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:text-indigo-600 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 rounded-lg transition-colors"
                            title="Edit sender credentials and settings"
                          >
                            <Edit2 className="w-3.5 h-3.5 text-slate-500" />
                            <span>Edit</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDeleteSender(s.id, s.name)}
                            disabled={deletingId === s.id}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                            title="Delete sender"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Add / Edit Sender Form View */
            <form onSubmit={handleSaveSender} className="space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  {editingSender ? `Edit Sender Profile: ${editingSender.name}` : 'New Sender Profile'}
                </span>
                <button
                  type="button"
                  onClick={resetForm}
                  className="text-xs font-medium text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </div>

              {/* Name & Email */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Display Name <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Sales Team"
                    className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Sender Email <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="e.g. sales@mycompany.com"
                    className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                    required
                  />
                </div>
              </div>

              {/* SMTP Host & Port */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SMTP Host <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="e.g. smtp.ethereal.email"
                    className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Port <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                    required
                  />
                </div>
              </div>

              {/* Secure Checkbox */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="smtp_secure_cb"
                  checked={smtpSecure}
                  onChange={(e) => setSmtpSecure(e.target.checked)}
                  className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300"
                />
                <label htmlFor="smtp_secure_cb" className="text-xs text-slate-700 cursor-pointer select-none">
                  Use SSL/TLS (usually true for port 465, false for 587)
                </label>
              </div>

              {/* SMTP Credentials */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SMTP Username <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder="Ethereal username"
                    className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SMTP Password {editingSender ? <span className="text-slate-400 font-normal">(leave blank to keep current)</span> : <span className="text-rose-500">*</span>}
                  </label>
                  <input
                    type="password"
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    placeholder={editingSender ? '•••••••••••• (leave blank to keep current)' : '••••••••••••'}
                    className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                    required={!editingSender}
                  />
                </div>
              </div>

              <div className="p-3 bg-amber-50/70 border border-amber-200/70 rounded-xl text-[11px] text-amber-800 flex items-start gap-2">
                <Lock className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                <span>SMTP passwords are securely handled by the backend and never exposed in client responses.</span>
              </div>

              {/* Submit Buttons */}
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  Back to List
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg shadow-xs transition-colors disabled:opacity-50"
                >
                  {loading
                    ? (editingSender ? 'Updating Profile...' : 'Saving Profile...')
                    : (editingSender ? 'Update Sender Profile' : 'Save Sender Profile')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
