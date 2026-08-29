import React, { useState } from 'react';
import Papa from 'papaparse';
import { X, Upload, Users, Calendar, Shield, Clock, Send, FileText, CheckCircle2 } from 'lucide-react';
import type { Sender, CreateCampaignPayload } from '../types';
import { campaignApi } from '../services/api';
import { useToast } from '../context/ToastContext';

interface ComposeEmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  senders: Sender[];
  onSuccess: () => void;
  onOpenSenders: () => void;
}

export const ComposeEmailModal: React.FC<ComposeEmailModalProps> = ({
  isOpen,
  onClose,
  senders,
  onSuccess,
  onOpenSenders,
}) => {
  const { success, error, warning } = useToast();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [senderId, setSenderId] = useState(senders[0]?.id || '');
  const [hourlyLimit, setHourlyLimit] = useState(10);
  const [scheduledAt, setScheduledAt] = useState('');
  const [recipients, setRecipients] = useState<{ email: string; name?: string }[]>([]);
  const [manualEmail, setManualEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');

  // Synchronize senderId if senders list updates
  React.useEffect(() => {
    if (!senderId && senders.length > 0) {
      setSenderId(senders[0].id);
    }
  }, [senders, senderId]);

  if (!isOpen) return null;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsedRecipients: { email: string; name?: string }[] = [];
        const seen = new Set<string>();

        results.data.forEach((row: any) => {
          const emailKey = Object.keys(row).find((k) => k.toLowerCase().includes('email'));
          const nameKey = Object.keys(row).find((k) => k.toLowerCase().includes('name'));

          const emailVal = emailKey ? String(row[emailKey]).trim().toLowerCase() : '';
          const nameVal = nameKey ? String(row[nameKey]).trim() : undefined;

          if (emailVal && EMAIL_RE.test(emailVal) && !seen.has(emailVal)) {
            seen.add(emailVal);
            parsedRecipients.push({ email: emailVal, name: nameVal });
          }
        });

        if (parsedRecipients.length > 0) {
          setRecipients(parsedRecipients);
          success(`Imported ${parsedRecipients.length} valid recipient(s) from ${file.name}`);
        } else {
          warning('No valid email addresses found in file. Please ensure columns include "email".');
        }
      },
      error: (err) => {
        error(`Failed to parse file: ${err.message}`);
      },
    });
  };

  const handleAddManualRecipient = () => {
    const email = manualEmail.trim().toLowerCase();
    if (!email) return;

    if (!EMAIL_RE.test(email)) {
      warning('Please enter a valid email address.');
      return;
    }

    if (recipients.some((r) => r.email === email)) {
      warning('This email is already in the recipient list.');
      return;
    }

    setRecipients([...recipients, { email }]);
    setManualEmail('');
  };

  const handleRemoveRecipient = (emailToRemove: string) => {
    setRecipients(recipients.filter((r) => r.email !== emailToRemove));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!subject.trim()) {
      error('Subject is required');
      return;
    }
    if (!body.trim()) {
      error('Body content is required');
      return;
    }
    if (!senderId) {
      error('Please select an active sender profile');
      return;
    }
    if (recipients.length === 0) {
      error('Please provide at least one recipient');
      return;
    }

    let scheduledDateISO: string | null = null;
    if (scheduledAt) {
      const parsedDate = new Date(scheduledAt);
      if (isNaN(parsedDate.getTime())) {
        error('Invalid scheduled date/time format');
        return;
      }
      if (parsedDate.getTime() <= Date.now()) {
        error('Scheduled start time must be in the future');
        return;
      }
      scheduledDateISO = parsedDate.toISOString();
    }

    const payload: CreateCampaignPayload = {
      subject: subject.trim(),
      body: body.trim(),
      sender_id: senderId,
      hourly_limit: Number(hourlyLimit) || 10,
      scheduled_at: scheduledDateISO,
      recipients,
    };

    try {
      setLoading(true);
      await campaignApi.create(payload);
      success('Campaign scheduled and queued successfully!', 'Campaign Created');
      onSuccess();
      onClose();
    } catch (err: any) {
      error(err.message || 'Failed to create campaign');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
              <Send className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm sm:text-base text-slate-900">Compose New Campaign</h3>
              <p className="text-xs text-slate-500">Configure parameters, recipients & dispatch schedule</p>
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

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Section 1: Campaign Details */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider">
              <FileText className="w-3.5 h-3.5 text-indigo-600" />
              <span>1. Campaign Content</span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Subject Line <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Scaling outreach with ReachInbox Scheduler {{name}}"
                className="w-full px-3.5 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Email Content / Body <span className="text-rose-500">*</span>
              </label>
              <textarea
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Hi {{name}}, we're excited to reach out..."
                className="w-full px-3.5 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                required
              />
            </div>
          </div>

          {/* Section 2: Sender Selection */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider">
                <Shield className="w-3.5 h-3.5 text-indigo-600" />
                <span>2. Sender Configuration</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSenders();
                }}
                className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
              >
                + Manage / Add Senders
              </button>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                From Sender Profile <span className="text-rose-500">*</span>
              </label>
              {senders.length > 0 ? (
                <select
                  value={senderId}
                  onChange={(e) => setSenderId(e.target.value)}
                  className="w-full px-3.5 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                  required
                >
                  {senders.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.email}) — {s.smtp_host}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="p-3 bg-amber-50/80 rounded-xl border border-amber-200 flex items-center justify-between gap-3">
                  <span className="text-xs text-amber-800 font-medium">No sender profiles available.</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenSenders();
                    }}
                    className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-lg shadow-xs transition-colors"
                  >
                    + Add Sender Profile
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Section 3: Recipients & Leads */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider">
                <Users className="w-3.5 h-3.5 text-indigo-600" />
                <span>3. Recipients ({recipients.length})</span>
              </div>
              <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100/70 text-indigo-700 text-xs font-semibold transition-colors shadow-xs">
                <Upload className="w-3 h-3" />
                <span>{fileName ? 'Change CSV' : 'Upload CSV / Text'}</span>
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>

            {/* Quick add single recipient */}
            <div className="flex gap-2">
              <input
                type="email"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddManualRecipient();
                  }
                }}
                placeholder="Or type single lead: recipient@company.com"
                className="flex-1 px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
              />
              <button
                type="button"
                onClick={handleAddManualRecipient}
                className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs rounded-lg transition-colors border border-slate-200"
              >
                Add
              </button>
            </div>

            {/* Recipient tags preview */}
            {recipients.length > 0 && (
              <div className="p-3 bg-slate-50/80 rounded-xl border border-slate-200 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
                  <span className="flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Recipients detected: {recipients.length}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRecipients([]);
                      setFileName('');
                    }}
                    className="text-rose-600 hover:underline"
                  >
                    Clear all
                  </button>
                </div>
                <div className="max-h-28 overflow-y-auto flex flex-wrap gap-1.5 pt-1">
                  {recipients.slice(0, 40).map((r) => (
                    <span
                      key={r.email}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-slate-200 text-[11px] text-slate-700 shadow-xs"
                    >
                      <span className="truncate max-w-[180px]">{r.name ? `${r.name} (${r.email})` : r.email}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveRecipient(r.email)}
                        className="text-slate-400 hover:text-rose-500 ml-0.5"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  {recipients.length > 40 && (
                    <span className="inline-flex items-center px-2 py-0.5 text-[11px] text-slate-500 font-medium">
                      +{recipients.length - 40} more
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Section 4: Scheduling & Rate Limiting */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider">
              <Clock className="w-3.5 h-3.5 text-indigo-600" />
              <span>4. Schedule & Rate Limits</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Scheduled Start Time</span>
                </label>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                />
                <p className="text-[10px] text-slate-400 mt-1">Leave empty to enqueue immediately</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Hourly Rate Limit</span>
                </label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={hourlyLimit}
                  onChange={(e) => setHourlyLimit(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
                />
                <p className="text-[10px] text-slate-400 mt-1">Max emails dispatched per hour</p>
              </div>
            </div>
          </div>

          {/* Submit Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || recipients.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs shadow-xs shadow-indigo-600/10 transition-all disabled:opacity-50"
            >
              {loading ? (
                <span>Scheduling Campaign...</span>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Schedule Campaign</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
