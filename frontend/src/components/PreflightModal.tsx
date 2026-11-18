import React from 'react';
import {
  X,
  Gauge,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Clock,
  Zap,
  FileCheck,
} from 'lucide-react';
import type { PreflightResponse } from '../types';

interface PreflightModalProps {
  isOpen: boolean;
  onClose: () => void;
  preflightData: PreflightResponse | null;
  loading: boolean;
  onProceed: () => void;
}

export const PreflightModal: React.FC<PreflightModalProps> = ({
  isOpen,
  onClose,
  preflightData,
  loading,
  onProceed,
}) => {
  if (!isOpen) return null;

  const validation = preflightData?.validation;
  const capacity = preflightData?.capacity;
  const forecast = preflightData?.forecast;

  const validCount = validation?.counts.valid_count ?? 0;
  const invalidCount = validation?.counts.invalid_count ?? 0;
  const duplicateCount = validation?.counts.duplicate_count ?? 0;

  const hasBlockers = validCount === 0 || (forecast?.warnings && forecast.warnings.some((w) => w.includes('blocked')));

  const formatSeconds = (sec: number) => {
    if (sec < 60) return `${sec} seconds`;
    if (sec < 3600) return `${Math.round(sec / 60)} minutes`;
    const hours = (sec / 3600).toFixed(1);
    return `${hours} hour(s)`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/80">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100">
              <Gauge className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-slate-900">Campaign Preflight & Delivery Forecast</h3>
              <p className="text-xs text-slate-500">Live capacity analysis and delivery projection before enqueuing</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5">
          {loading ? (
            <div className="py-16 text-center space-y-3">
              <div className="w-8 h-8 border-3 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs text-slate-600 font-semibold">Running telemetry preflight check & capacity simulation...</p>
            </div>
          ) : !preflightData ? (
            <div className="py-12 text-center text-slate-500 text-xs">No preflight check data available.</div>
          ) : (
            <>
              {/* Readiness Banner */}
              <div
                className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${
                  hasBlockers
                    ? 'bg-rose-50/80 border-rose-200 text-rose-900'
                    : 'bg-emerald-50/80 border-emerald-200 text-emerald-900'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {hasBlockers ? (
                    <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
                  ) : (
                    <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
                  )}
                  <div>
                    <h4 className="font-bold text-xs sm:text-sm">
                      {hasBlockers ? 'Campaign Dispatch Blocked' : 'Campaign Ready for Dispatch'}
                    </h4>
                    <p className="text-[11px] opacity-80">
                      {hasBlockers
                        ? 'Resolve blocking validation errors before scheduling this campaign.'
                        : 'All delivery capacity thresholds and sender health checks passed successfully.'}
                    </p>
                  </div>
                </div>
                <span
                  className={`text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-md border ${
                    hasBlockers
                      ? 'bg-rose-100 text-rose-800 border-rose-200'
                      : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                  }`}
                >
                  {hasBlockers ? 'BLOCKED' : 'READY'}
                </span>
              </div>

              {/* Grid 1: Recipient Validation */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <FileCheck className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Audience Validation Breakdown</span>
                  </h4>
                  {validation?.counts?.total_rows !== undefined && (
                    <span className="text-[11px] font-semibold text-slate-500">
                      Total Data Rows: {validation.counts.total_rows}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center">
                    <p className="text-[10px] uppercase font-bold text-slate-500">Valid Emails</p>
                    <p className="text-lg font-extrabold text-emerald-600 mt-0.5">{validCount}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center">
                    <p className="text-[10px] uppercase font-bold text-slate-500">Invalid Syntax</p>
                    <p className="text-lg font-extrabold text-rose-600 mt-0.5">{invalidCount}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-center">
                    <p className="text-[10px] uppercase font-bold text-slate-500">Duplicates Removed</p>
                    <p className="text-lg font-extrabold text-amber-600 mt-0.5">{duplicateCount}</p>
                  </div>
                </div>

                {/* Details list for invalid/duplicate rows */}
                {((validation?.invalid && validation.invalid.length > 0) ||
                  (validation?.duplicates && validation.duplicates.length > 0)) && (
                  <div className="pt-1">
                    <details className="text-xs text-slate-600 group bg-slate-50/80 p-2.5 rounded-xl border border-slate-200">
                      <summary className="font-semibold text-[11px] text-slate-700 cursor-pointer hover:text-indigo-600 flex items-center justify-between">
                        <span>View Filtered Rows Details ({(validation.invalid?.length || 0) + (validation.duplicates?.length || 0)})</span>
                        <span className="text-[10px] text-indigo-600 group-open:rotate-180 transition-transform">▼</span>
                      </summary>
                      <div className="mt-2 max-h-28 overflow-y-auto space-y-1 text-[11px]">
                        {validation.invalid?.map((item, idx) => (
                          <div key={`inv-pf-${idx}`} className="flex items-center justify-between p-1.5 bg-rose-50/70 rounded border border-rose-100 text-rose-800">
                            <span>Row {item.row}: <code className="font-mono">{item.email || '(empty)'}</code></span>
                            <span className="text-[10px] opacity-80">{item.reason}</span>
                          </div>
                        ))}
                        {validation.duplicates?.map((item, idx) => (
                          <div key={`dup-pf-${idx}`} className="flex items-center justify-between p-1.5 bg-amber-50/70 rounded border border-amber-100 text-amber-800">
                            <span>Row {item.row}: <code className="font-mono">{item.email}</code></span>
                            <span className="text-[10px] opacity-80">{item.reason}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>

              {/* Grid 2: Capacity & Bottleneck */}
              {capacity && (
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Sending Capacity & Bottleneck</span>
                  </h4>
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div>
                        <span className="text-[10px] uppercase font-bold text-slate-500 block">
                          Effective Dispatch Rate
                        </span>
                        <span className="text-sm font-bold text-slate-900">
                          {capacity.effective_hourly_rate} emails/hr
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase font-bold text-slate-500 block">
                          Current Window Left
                        </span>
                        <span className="text-sm font-bold text-slate-900">
                          {capacity.current_hour_remaining} sends remaining
                        </span>
                      </div>
                      <div className="col-span-2 sm:col-span-1">
                        <span className="text-[10px] uppercase font-bold text-slate-500 block">
                          Primary Bottleneck
                        </span>
                        <span className="inline-block mt-0.5 text-[11px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                          {capacity.primary_bottleneck.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Grid 3: Delivery Forecast */}
              {forecast && (
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Estimated Completion Forecast</span>
                  </h4>
                  <div className="p-4 rounded-xl bg-indigo-50/50 border border-indigo-100 space-y-2.5">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-[10px] font-semibold text-slate-500 block">Estimated Start</span>
                        <span className="text-xs font-bold text-slate-900">
                          {new Date(forecast.estimated_start_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold text-slate-500 block">Estimated Finish</span>
                        <span className="text-xs font-bold text-indigo-700">
                          {new Date(forecast.estimated_completion_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="pt-2 border-t border-indigo-100 flex items-center justify-between text-xs">
                      <span className="text-slate-600">Total Projected Duration:</span>
                      <span className="font-extrabold text-slate-900">
                        {formatSeconds(forecast.estimated_duration_seconds)}
                      </span>
                    </div>
                    {forecast.explanation && (
                      <div className="mt-2 p-2 rounded-lg bg-indigo-100/70 border border-indigo-200/70 text-[11px] text-indigo-950 leading-relaxed">
                        <span className="font-bold block mb-0.5 text-indigo-900">Pacing & Constraint Breakdown:</span>
                        {forecast.explanation}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Warnings List */}
              {forecast?.warnings && forecast.warnings.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-bold text-amber-800 uppercase tracking-wide flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>Operational Warnings</span>
                  </span>
                  <ul className="space-y-1">
                    {forecast.warnings.map((w, i) => (
                      <li
                        key={i}
                        className="text-[11px] text-amber-800 bg-amber-50/70 p-2 rounded-lg border border-amber-200/80"
                      >
                        • {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-100 bg-slate-50/80">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            Back to Editor
          </button>
          <button
            type="button"
            onClick={onProceed}
            disabled={hasBlockers || loading}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white shadow-xs transition-colors disabled:opacity-40"
          >
            Confirm & Schedule Campaign
          </button>
        </div>
      </div>
    </div>
  );
};
