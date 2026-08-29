import React from 'react';
import { Mail, Calendar, CheckCircle2, Search, Plus, MessageSquare, ExternalLink, Shield } from 'lucide-react';
import type { SlackStatus } from '../types';
import { UserMenu } from './UserMenu';

interface DashboardHeaderProps {
  activeTab: 'scheduled' | 'sent' | 'search';
  onTabChange: (tab: 'scheduled' | 'sent' | 'search') => void;
  onComposeClick: () => void;
  onOpenSenders: () => void;
  slackStatus: SlackStatus | null;
  onSlackConnect: () => void;
  onSlackDisconnect: () => void;
  slackLoading: boolean;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  activeTab,
  onTabChange,
  onComposeClick,
  onOpenSenders,
  slackStatus,
  onSlackConnect,
  onSlackDisconnect,
  slackLoading,
}) => {
  return (
    <header className="bg-white border-b border-slate-200/80 sticky top-0 z-30 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-3 sm:gap-6">
          {/* Logo & Product Badge */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-700 flex items-center justify-center text-white shadow-xs">
              <Mail className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-base text-slate-900 tracking-tight">ReachInbox</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100/80">
                Scheduler
              </span>
            </div>
          </div>

          {/* Center Tabs */}
          <nav className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/60">
            <button
              onClick={() => onTabChange('scheduled')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'scheduled'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/40'
              }`}
            >
              <Calendar className="w-3.5 h-3.5 text-indigo-600" />
              <span>Scheduled</span>
            </button>
            <button
              onClick={() => onTabChange('sent')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'sent'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/40'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Sent Logs</span>
            </button>
            <button
              onClick={() => onTabChange('search')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'search'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/40'
              }`}
            >
              <Search className="w-3.5 h-3.5 text-slate-600" />
              <span>Search</span>
            </button>
          </nav>

          {/* Right Area: Senders + Slack + Compose CTA + User Menu */}
          <div className="flex items-center gap-2 sm:gap-2.5">
            {/* Senders Button */}
            <button
              onClick={onOpenSenders}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors shadow-xs"
              title="Manage Sender Profiles"
            >
              <Shield className="w-3.5 h-3.5 text-indigo-600" />
              <span className="hidden md:inline">Senders</span>
            </button>

            {/* Slack Integration Control */}
            {slackStatus?.connected ? (
              <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50/70 border border-emerald-200/70 text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-emerald-900">{slackStatus.teamName || 'Slack Connected'}</span>
                {slackStatus.channelName && (
                  <span className="text-emerald-700 text-[11px] font-normal">{slackStatus.channelName}</span>
                )}
                <button
                  onClick={onSlackDisconnect}
                  disabled={slackLoading}
                  className="ml-1 text-[11px] font-medium text-rose-600 hover:text-rose-800 underline transition-colors disabled:opacity-50"
                  title="Disconnect Slack"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={onSlackConnect}
                disabled={slackLoading}
                className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors shadow-xs"
                title="Connect Slack Workspace"
              >
                <MessageSquare className="w-3.5 h-3.5 text-purple-600" />
                <span>Connect Slack</span>
                <ExternalLink className="w-3 h-3 text-slate-400" />
              </button>
            )}

            {/* Primary Compose CTA */}
            <button
              onClick={onComposeClick}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-xs font-bold shadow-xs shadow-indigo-600/10 transition-all hover:scale-[1.01] active:scale-[0.99]"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Compose New Email</span>
            </button>

            {/* User Menu Dropdown */}
            <UserMenu />
          </div>
        </div>
      </div>
    </header>
  );
};
