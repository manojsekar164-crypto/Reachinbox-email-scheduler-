import React from 'react';
import { Mail, Calendar, CheckCircle2, Search, PlusCircle, MessageSquare, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { SlackStatus } from '../types';

interface HeaderProps {
  activeTab: 'scheduled' | 'sent' | 'search';
  onTabChange: (tab: 'scheduled' | 'sent' | 'search') => void;
  onComposeClick: () => void;
  slackStatus: SlackStatus | null;
  onSlackConnect: () => void;
  onSlackDisconnect: () => void;
  slackLoading: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onTabChange,
  onComposeClick,
  slackStatus,
  onSlackConnect,
  onSlackDisconnect,
  slackLoading,
}) => {
  const { user, logout } = useAuth();

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Logo / Title */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-brand-500/20">
              <Mail className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg text-slate-900 tracking-tight">ReachInbox</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">
                  Scheduler
                </span>
              </div>
              <p className="text-xs text-slate-500 hidden sm:block">Automated Email Campaign Engine</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              onClick={() => onTabChange('scheduled')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'scheduled'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              <Calendar className="w-4 h-4 text-brand-600" />
              <span>Scheduled</span>
            </button>
            <button
              onClick={() => onTabChange('sent')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'sent'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>Sent Logs</span>
            </button>
            <button
              onClick={() => onTabChange('search')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'search'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
              }`}
            >
              <Search className="w-4 h-4 text-indigo-600" />
              <span>Search</span>
            </button>
          </nav>

          {/* Right actions: Compose + Slack + User Info */}
          <div className="flex items-center gap-3">
            {/* Compose Button */}
            <button
              onClick={onComposeClick}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold shadow-md shadow-brand-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <PlusCircle className="w-4 h-4" />
              <span className="hidden sm:inline">Compose Email</span>
            </button>

            {/* Slack Connection Status Badge / Button */}
            {slackStatus?.connected ? (
              <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-emerald-800">{slackStatus.teamName || 'Slack'}</span>
                <span className="text-emerald-600 text-[11px]">{slackStatus.channelName || ''}</span>
                <button
                  onClick={onSlackDisconnect}
                  disabled={slackLoading}
                  className="ml-1 text-[11px] font-semibold text-rose-600 hover:text-rose-800 underline disabled:opacity-50"
                  title="Disconnect Slack"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={onSlackConnect}
                disabled={slackLoading}
                className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors"
                title="Connect Slack Workspace"
              >
                <MessageSquare className="w-4 h-4 text-purple-600" />
                <span>Connect Slack</span>
              </button>
            )}

            {/* User Profile + Logout */}
            <div className="flex items-center gap-2 pl-2 border-l border-slate-200">
              <div className="w-8 h-8 rounded-full bg-slate-200 border border-slate-300 flex items-center justify-center font-bold text-xs text-slate-700 uppercase">
                {user?.name ? user.name.substring(0, 2) : 'U'}
              </div>
              <div className="hidden xl:block text-left">
                <p className="text-xs font-semibold text-slate-900 leading-tight truncate max-w-[120px]">
                  {user?.name || 'User'}
                </p>
                <p className="text-[10px] text-slate-500 leading-tight truncate max-w-[120px]">
                  {user?.email}
                </p>
              </div>
              <button
                onClick={logout}
                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                title="Log out"
                aria-label="Log out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
