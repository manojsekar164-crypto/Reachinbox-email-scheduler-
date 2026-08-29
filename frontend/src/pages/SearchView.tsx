import React, { useState } from 'react';
import { Search, Mail, Clock } from 'lucide-react';
import type { SearchResultItem } from '../types';
import { emailApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingSkeleton } from '../components/ui/LoadingSkeleton';

export const SearchView: React.FC = () => {
  const { error } = useToast();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      setLoading(true);
      setSearched(true);
      const res = await emailApi.search({
        q: query.trim() || undefined,
        status: statusFilter || undefined,
      });
      setResults(res.results || []);
    } catch (err: any) {
      error(err.message || 'Elasticsearch query failed');
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (isoString?: string) => {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs">
        <h2 className="text-base font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Search className="w-4 h-4 text-indigo-600" />
          <span>Elasticsearch Email Explorer</span>
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Full-text query index across email subjects, recipients, body snippets, and status
        </p>
      </div>

      {/* Search Input Controls */}
      <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2.5">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emails, recipients, campaigns..."
            className="w-full pl-10 pr-4 py-2.5 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
          />
        </div>

        {/* Status Filter */}
        <div className="sm:w-44 shrink-0">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full px-3 py-2.5 bg-white rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-xs"
          >
            <option value="">All Statuses</option>
            <option value="sent">Sent</option>
            <option value="scheduled">Scheduled</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs rounded-xl shadow-xs shadow-indigo-600/10 transition-all disabled:opacity-50 flex items-center justify-center gap-2 shrink-0"
        >
          {loading ? (
            <span>Searching...</span>
          ) : (
            <>
              <Search className="w-3.5 h-3.5" />
              <span>Search Query</span>
            </>
          )}
        </button>
      </form>

      {/* Results Count Header */}
      {searched && !loading && (
        <div className="flex items-center justify-between text-xs text-slate-500 px-1 font-medium">
          <span>Found {results.length} matching result(s) in Elasticsearch index</span>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && <LoadingSkeleton rows={4} type="card" />}

      {/* Empty State */}
      {searched && !loading && results.length === 0 && (
        <EmptyState
          icon={Search}
          title="No matching emails found"
          description="Try adjusting your keywords, searching by domain name, or clearing the status filter."
          iconColor="text-slate-600 bg-slate-50 border-slate-200"
        />
      )}

      {/* Search Results Grid */}
      {!loading && results.length > 0 && (
        <div className="grid grid-cols-1 gap-3">
          {results.map((item) => (
            <div
              key={item.id}
              className="p-4 bg-white rounded-xl border border-slate-200/80 shadow-xs space-y-2 hover:border-slate-300 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={item.status} />
                    <h3 className="font-bold text-sm text-slate-900">{item.subject}</h3>
                  </div>
                  <p className="text-xs text-slate-600 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-slate-400" />
                    <span>To: {item.recipientName ? `${item.recipientName} (${item.recipientEmail})` : item.recipientEmail}</span>
                  </p>
                </div>

                <div className="flex items-center gap-1 text-[11px] text-slate-400 whitespace-nowrap">
                  <Clock className="w-3 h-3" />
                  <span>{formatTime(item.sentAt || item.scheduledAt || item.updatedAt)}</span>
                </div>
              </div>

              {item.body && (
                <div className="p-2.5 bg-slate-50/80 rounded-lg border border-slate-100 text-xs text-slate-700 font-mono line-clamp-2">
                  {item.body}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
