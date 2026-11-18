import React, { useState } from 'react';
import Papa from 'papaparse';
import { X, Upload, Users, Calendar, Shield, Send, Gauge, FileCheck } from 'lucide-react';
import { PreflightModal } from './PreflightModal';
import type { PreflightResponse, ImportDiagnostics } from '../types';
import { preflightApi } from '../services/api';
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
  const [hourlyLimit, setHourlyLimit] = useState<number | string>(100);
  const [scheduledAt, setScheduledAt] = useState('');
  const [recipients, setRecipients] = useState<{ email: string; name?: string }[]>([]);
  const [manualEmail, setManualEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rawCsvContent, setRawCsvContent] = useState<string | null>(null);
  const [importDiagnostics, setImportDiagnostics] = useState<ImportDiagnostics | null>(null);
  const [isPreflightOpen, setIsPreflightOpen] = useState(false);
  const [preflightData, setPreflightData] = useState<PreflightResponse | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  const handleRunPreflight = async () => {
    if (!senderId) {
      error('Please select an active sender profile before running preflight');
      return;
    }
    if (recipients.length === 0) {
      error('Please add at least one recipient before running preflight check');
      return;
    }

    try {
      setPreflightLoading(true);
      setIsPreflightOpen(true);
      const res = await preflightApi.run({
        sender_id: senderId,
        hourly_limit: Math.max(1, Math.min(1000, Number(hourlyLimit) || 100)),
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        recipients,
        csv_content: rawCsvContent || undefined,
        import_diagnostics: importDiagnostics || undefined,
      });
      setPreflightData(res);
    } catch (err: any) {
      error(err.message || 'Preflight check failed');
      setIsPreflightOpen(false);
    } finally {
      setPreflightLoading(false);
    }
  };

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

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = (event.target?.result as string) || '';
      setRawCsvContent(text);

      if (text.includes('\0')) {
        error('Malformed or unreadable content (binary or null byte detected)');
        return;
      }

      Papa.parse(text, {
        header: true,
        skipEmptyLines: 'greedy',
        complete: (results) => {
          const fields = results.meta.fields || [];
          const emailCol = fields.find((f: string) => {
            const clean = f.toLowerCase().replace(/[^a-z0-9]/g, '');
            return ['email', 'emailaddress', 'recipient', 'recipientemail', 'mail', 'to'].includes(clean);
          });
          const nameCol = fields.find((f: string) => {
            const clean = f.toLowerCase().replace(/[^a-z0-9]/g, '');
            return ['name', 'fullname', 'recipientname', 'firstname'].includes(clean);
          });

          if (!results.data || results.data.length === 0) {
            warning('File is empty.');
            return;
          }

          if (!emailCol && fields.length > 0) {
            const looksLikeSchema = fields.some((f) =>
              /^(name|first|last|id|phone|address|company|age|title|city|state|zip)$/i.test(f.trim())
            );
            if (looksLikeSchema) {
              error("Missing required email column in CSV header. Expected a column named 'email'.");
              return;
            }
          }

          const parsedRecipients: { email: string; name?: string }[] = [];
          const seen = new Set<string>();
          const invalidRows: { row: number; email: string; reason: string }[] = [];
          const duplicateRows: { row: number; email: string; reason: string }[] = [];

          let rowNumber = 1;

          results.data.forEach((row: any) => {
            rowNumber++;
            const emailKey = emailCol || Object.keys(row).find((k) => k.toLowerCase().includes('email'));
            const nameKey = nameCol || Object.keys(row).find((k) => k.toLowerCase().includes('name'));

            const rawEmailVal = emailKey ? String(row[emailKey] ?? '').trim() : '';
            const normalizedEmail = rawEmailVal.toLowerCase();
            const rawNameVal = nameKey ? String(row[nameKey] ?? '').trim() : undefined;

            if (!rawEmailVal) {
              invalidRows.push({
                row: rowNumber,
                email: '',
                reason: 'Empty or missing email address',
              });
              return;
            }

            if (!EMAIL_RE.test(normalizedEmail)) {
              invalidRows.push({
                row: rowNumber,
                email: rawEmailVal,
                reason: 'Invalid email address format',
              });
              return;
            }

            if (seen.has(normalizedEmail)) {
              duplicateRows.push({
                row: rowNumber,
                email: normalizedEmail,
                reason: 'Duplicate email address within uploaded file',
              });
              return;
            }

            seen.add(normalizedEmail);
            parsedRecipients.push({ email: normalizedEmail, name: rawNameVal || undefined });
          });

          const totalDataRows = results.data.length;
          const diagnostics: ImportDiagnostics = {
            total_rows: totalDataRows,
            valid_count: parsedRecipients.length,
            invalid_count: invalidRows.length,
            duplicate_count: duplicateRows.length,
            invalid: invalidRows,
            duplicates: duplicateRows,
          };

          setImportDiagnostics(diagnostics);

          if (parsedRecipients.length > 0) {
            setRecipients(parsedRecipients);
            const msg = `Imported ${parsedRecipients.length} valid recipient(s)` +
              (duplicateRows.length > 0 ? ` (${duplicateRows.length} duplicate(s) removed)` : '') +
              (invalidRows.length > 0 ? ` (${invalidRows.length} invalid rejected)` : '');
            success(msg);
          } else {
            setRecipients([]);
            warning('No valid email addresses found in file.');
          }
        },
        error: (err: any) => {
          error(`Failed to parse file: ${err.message}`);
        },
      });
    };
    reader.readAsText(file);
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
      hourly_limit: Math.max(1, Math.min(1000, Number(hourlyLimit) || 100)),
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
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Sender Selection */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-slate-700">
                Sender Profile <span className="text-rose-500">*</span>
              </label>
              <button
                type="button"
                onClick={onOpenSenders}
                className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 hover:underline cursor-pointer"
              >
                + Add / Manage Senders
              </button>
            </div>

            {senders.length === 0 ? (
              <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 flex items-center justify-between gap-2">
                <span className="text-xs text-amber-800">No verified sender found. Please configure one.</span>
                <button
                  type="button"
                  onClick={onOpenSenders}
                  className="px-2.5 py-1 text-xs font-semibold bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors"
                >
                  Create Sender
                </button>
              </div>
            ) : (
              <select
                value={senderId}
                onChange={(e) => setSenderId(e.target.value)}
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
              >
                {senders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.email}) — {s.smtp_host}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Subject Line */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Email Subject <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Important Q3 Project Update for {{name}}"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs placeholder:text-slate-400"
            />
            <p className="text-[10px] text-slate-400 mt-1">Tip: You can use `&#123;&#123;name&#125;&#125;` to personalize the subject line.</p>
          </div>

          {/* Email Body with Template Variables */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-slate-700">
                Email Body Content <span className="text-rose-500">*</span>
              </label>
              <span className="text-[10px] text-slate-400 font-mono">Supports &#123;&#123;name&#125;&#125;</span>
            </div>
            <textarea
              required
              rows={4}
              placeholder="Hi {{name}},&#10;&#10;We wanted to update you on our latest scheduler performance improvements."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs placeholder:text-slate-400 font-sans"
            />
          </div>

          {/* Recipients Section: CSV Upload & Manual Entry */}
          <div className="space-y-3 p-4 bg-slate-50/80 rounded-xl border border-slate-200">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-bold text-slate-900 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-indigo-600" />
                <span>Audience & Recipients ({recipients.length})</span>
              </label>
              {recipients.length > 0 && (
                <button
                  type="button"
                  onClick={() => setRecipients([])}
                  className="text-[10px] text-rose-600 hover:underline font-semibold cursor-pointer"
                >
                  Clear All
                </button>
              )}
            </div>

            {/* CSV File Drop Area */}
            <div className="border-2 border-dashed border-slate-300 hover:border-indigo-400 bg-white rounded-xl p-4 text-center transition-colors">
              <input
                type="file"
                accept=".csv"
                id="csv-upload"
                onChange={handleFileUpload}
                className="hidden"
              />
              <label htmlFor="csv-upload" className="cursor-pointer block space-y-1">
                <Upload className="w-6 h-6 text-indigo-600 mx-auto" />
                <p className="text-xs font-semibold text-slate-700">
                  {fileName ? (
                    <span className="text-indigo-600 font-bold">{fileName}</span>
                  ) : (
                    'Click to upload recipient CSV file'
                  )}
                </p>
                <p className="text-[10px] text-slate-400">Must include `email` and optional `name` columns</p>
              </label>
            </div>

            {/* CSV Import Diagnostics Summary */}
            {importDiagnostics && (
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <FileCheck className="w-3.5 h-3.5 text-indigo-600" />
                    <span>CSV Import Summary ({fileName})</span>
                  </span>
                  <span className="text-[10px] font-semibold text-slate-500">
                    {importDiagnostics.total_rows} total rows
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-100">
                    <span className="text-[10px] font-bold uppercase text-emerald-700 block">Accepted</span>
                    <span className="text-base font-extrabold text-emerald-800">{importDiagnostics.valid_count}</span>
                  </div>
                  <div className="p-2 rounded-lg bg-rose-50 border border-rose-100">
                    <span className="text-[10px] font-bold uppercase text-rose-700 block">Invalid</span>
                    <span className="text-base font-extrabold text-rose-800">{importDiagnostics.invalid_count}</span>
                  </div>
                  <div className="p-2 rounded-lg bg-amber-50 border border-amber-100">
                    <span className="text-[10px] font-bold uppercase text-amber-700 block">Duplicates</span>
                    <span className="text-base font-extrabold text-amber-800">{importDiagnostics.duplicate_count}</span>
                  </div>
                </div>
                {(importDiagnostics.invalid_count > 0 || importDiagnostics.duplicate_count > 0) && (
                  <div className="pt-1.5 border-t border-slate-200">
                    <details className="text-xs text-slate-600 group">
                      <summary className="font-semibold text-[11px] text-slate-700 cursor-pointer hover:text-indigo-600 flex items-center justify-between">
                        <span>View Rejected Rows ({importDiagnostics.invalid_count + importDiagnostics.duplicate_count})</span>
                        <span className="text-[10px] text-indigo-600 group-open:rotate-180 transition-transform">▼</span>
                      </summary>
                      <div className="mt-2 max-h-28 overflow-y-auto space-y-1 text-[11px]">
                        {importDiagnostics.invalid.map((item, idx) => (
                          <div key={`inv-${idx}`} className="flex items-center justify-between p-1.5 bg-rose-50/70 rounded border border-rose-100 text-rose-800">
                            <span>Row {item.row}: <code className="font-mono">{item.email || '(empty)'}</code></span>
                            <span className="text-[10px] opacity-80">{item.reason}</span>
                          </div>
                        ))}
                        {importDiagnostics.duplicates.map((item, idx) => (
                          <div key={`dup-${idx}`} className="flex items-center justify-between p-1.5 bg-amber-50/70 rounded border border-amber-100 text-amber-800">
                            <span>Row {item.row}: <code className="font-mono">{item.email}</code></span>
                            <span className="text-[10px] opacity-80">{item.reason}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>
            )}

            {/* Manual Email Input */}
            <div className="flex gap-2">
              <input
                type="email"
                placeholder="Or add single email manually (e.g. user@example.com)"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddManualRecipient();
                  }
                }}
                className="flex-1 px-3 py-1.5 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
              />
              <button
                type="button"
                onClick={handleAddManualRecipient}
                className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-200 text-slate-700 hover:bg-slate-300 transition-colors cursor-pointer"
              >
                Add
              </button>
            </div>

            {/* Recipients Pill Preview */}
            {recipients.length > 0 && (
              <div className="max-h-24 overflow-y-auto flex flex-wrap gap-1.5 pt-1">
                {recipients.slice(0, 50).map((r) => (
                  <span
                    key={r.email}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-slate-200 text-[11px] text-slate-700 shadow-2xs"
                  >
                    <span>{r.email}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveRecipient(r.email)}
                      className="text-slate-400 hover:text-rose-500 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {recipients.length > 50 && (
                  <span className="text-[10px] text-slate-500 font-semibold self-center">
                    +{recipients.length - 50} more
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Delivery Configuration: Schedule & Rate Limit */}
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
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold text-slate-700 flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Hourly Rate Limit</span>
                </label>
                <span className="text-[10px] text-slate-500 font-semibold">{hourlyLimit}/hr</span>
              </div>
              <input
                type="number"
                min="1"
                max="1000"
                placeholder="e.g. 500"
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(e.target.value === '' ? '' : parseInt(e.target.value, 10) || '')}
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs font-semibold"
              />
              {/* Quick Presets */}
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span className="text-[10px] text-slate-400">Presets:</span>
                {[10, 50, 100, 500, 1000].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setHourlyLimit(preset)}
                    className={`text-[10px] px-2 py-0.5 rounded-md font-semibold transition-colors cursor-pointer ${
                      Number(hourlyLimit) === preset
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Submit Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              disabled={recipients.length === 0 || !senderId || preflightLoading}
              onClick={handleRunPreflight}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-indigo-200 bg-indigo-50/80 hover:bg-indigo-100/80 text-indigo-700 text-xs font-bold transition-all disabled:opacity-50 cursor-pointer shadow-xs"
            >
              <Gauge className={`w-3.5 h-3.5 ${preflightLoading ? 'animate-spin' : ''}`} />
              <span>{preflightLoading ? 'Checking...' : 'Preflight Forecast'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || recipients.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs shadow-xs shadow-indigo-600/10 transition-all disabled:opacity-50 cursor-pointer"
            >
              {loading ? (
                <span>Scheduling Campaign...</span>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Schedule & Launch Campaign</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Preflight Forecast Modal */}
      <PreflightModal
        isOpen={isPreflightOpen}
        onClose={() => setIsPreflightOpen(false)}
        preflightData={preflightData}
        loading={preflightLoading}
        onProceed={() => {
          setIsPreflightOpen(false);
          // Trigger actual submission
          const form = document.querySelector('form');
          if (form) form.requestSubmit();
        }}
      />
    </div>
  );
};
export default ComposeEmailModal;
