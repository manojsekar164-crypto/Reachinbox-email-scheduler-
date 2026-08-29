import React, { useState } from 'react';
import Papa from 'papaparse';
import { X, Upload, Users, Calendar, Shield, Clock, Send } from 'lucide-react';
import type { Sender, CreateCampaignPayload } from '../types';
import { campaignApi } from '../services/api';
import { useToast } from '../context/ToastContext';

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  senders: Sender[];
  onSuccess: () => void;
}

export const ComposeModal: React.FC<ComposeModalProps> = ({
  isOpen,
  onClose,
  senders,
  onSuccess,
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
          // Detect email column regardless of casing
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-brand-50 text-brand-600 border border-brand-100">
              <Send className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-slate-900">Compose New Campaign</h3>
              <p className="text-xs text-slate-500">Configure scheduling parameters, recipients & sender</p>
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
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Sender Selection */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
              <span>From Sender</span>
              <span className="text-[11px] text-slate-500 font-normal">Active SMTP configuration</span>
            </label>
            <select
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              required
            >
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.email}) — {s.smtp_host}
                </option>
              ))}
            </select>
          </div>

          {/* Subject */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Subject Line <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Scaling outreach with ReachInbox Scheduler {{name}}"
              className="w-full px-3.5 py-2.5 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              required
            />
          </div>

          {/* Body */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Email Content / Body <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi {{name}}, we're excited to reach out..."
              className="w-full px-3.5 py-2.5 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              required
            />
          </div>

          {/* Recipient Management (CSV Upload + Manual Add) */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                <Users className="w-4 h-4 text-brand-600" />
                <span>Recipients ({recipients.length})</span>
              </label>
              <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-200 bg-brand-50 hover:bg-brand-100 text-brand-700 text-xs font-semibold transition-colors">
                <Upload className="w-3.5 h-3.5" />
                <span>{fileName ? 'Change CSV' : 'Upload CSV / Text'}</span>
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>

            {/* Manual Recipient Quick Add */}
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
                placeholder="Or enter recipient@company.com"
                className="flex-1 px-3 py-2 bg-white rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              />
              <button
                type="button"
                onClick={handleAddManualRecipient}
                className="px-3 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold text-xs rounded-lg transition-colors"
              >
                Add
              </button>
            </div>

            {/* Recipient Tag List Preview */}
            {recipients.length > 0 && (
              <div className="max-h-28 overflow-y-auto flex flex-wrap gap-1.5 pt-1">
                {recipients.slice(0, 50).map((r) => (
                  <span
                    key={r.email}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-slate-200 text-[11px] text-slate-700 shadow-xs"
                  >
                    <span>{r.name ? `${r.name} (${r.email})` : r.email}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveRecipient(r.email)}
                      className="text-slate-400 hover:text-rose-500"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {recipients.length > 50 && (
                  <span className="inline-flex items-center px-2 py-1 text-[11px] text-slate-500 font-medium">
                    +{recipients.length - 50} more recipients
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Scheduling & Rate Limiting Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-brand-600" />
                <span>Scheduled Start Time</span>
              </label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              />
              <p className="text-[10px] text-slate-500 mt-1">Leave empty to enqueue immediately</p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1">
                <Shield className="w-3.5 h-3.5 text-emerald-600" />
                <span>Hourly Rate Limit</span>
              </label>
              <input
                type="number"
                min="1"
                max="1000"
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
              />
              <p className="text-[10px] text-slate-500 mt-1">Max emails dispatched per hour window</p>
            </div>
          </div>

          {/* Information Notice */}
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-sky-50 border border-sky-100 text-xs text-sky-800">
            <Clock className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Global send delay is actively coordinated via Redis atomic locking, spacing consecutive sends to prevent provider throttling.
            </p>
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
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs shadow-md shadow-brand-500/20 transition-all disabled:opacity-50"
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
