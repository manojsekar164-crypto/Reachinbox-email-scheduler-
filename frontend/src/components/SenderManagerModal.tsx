import React, { useState } from 'react';
import { X, Shield, Plus, Trash2, Mail, Lock } from 'lucide-react';
import type { Sender } from '../types';
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
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [smtpHost, setSmtpHost] = useState('smtp.ethereal.email');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');

  if (!isOpen) return null;

  const handleCreateSender = async (e: React.FormEvent) => {
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
    if (!smtpPass) {
      error('SMTP password is required');
      return;
    }

    try {
      setLoading(true);
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
      // Reset form
      setName('');
      setEmail('');
      setSmtpHost('smtp.ethereal.email');
      setSmtpPort(587);
      setSmtpSecure(false);
      setSmtpUser('');
      setSmtpPass('');
      setIsAdding(false);

      await onSendersUpdated();
    } catch (err: any) {
      error(err.message || 'Failed to create sender profile');
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
          {!isAdding ? (
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
                  {senders.map((s) => (
                    <div
                      key={s.id}
                      className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs hover:border-slate-300 transition-colors flex items-center justify-between gap-3"
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-xs text-slate-900 truncate">{s.name}</span>
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
                            {s.smtp_host}:{s.smtp_port}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 truncate">{s.email}</p>
                      </div>

                      <button
                        onClick={() => handleDeleteSender(s.id, s.name)}
                        disabled={deletingId === s.id}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                        title="Delete sender"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* Add Sender Form View */
            <form onSubmit={handleCreateSender} className="space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  New Sender Profile
                </span>
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
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
                    SMTP Password <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="password"
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                    required
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
                  onClick={() => setIsAdding(false)}
                  className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  Back to List
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg shadow-xs transition-colors disabled:opacity-50"
                >
                  {loading ? 'Saving Profile...' : 'Save Sender Profile'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
