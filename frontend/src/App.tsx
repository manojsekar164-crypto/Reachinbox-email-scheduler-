import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, CheckCircle2, AlertCircle, Users } from 'lucide-react';
import { useAuth } from './context/AuthContext';
import { useToast } from './context/ToastContext';
import { DashboardHeader } from './components/DashboardHeader';
import { SummaryCard } from './components/SummaryCard';
import { ComposeEmailModal } from './components/ComposeEmailModal';
import { SenderManagerModal } from './components/SenderManagerModal';
import { LoginView } from './pages/LoginView';
import { ScheduledListView } from './pages/ScheduledListView';
import { SentListView } from './pages/SentListView';
import { SearchView } from './pages/SearchView';
import type { Campaign, Sender, SearchResultItem, SlackStatus } from './types';
import { campaignApi, senderApi, emailApi, slackApi } from './services/api';

export const App: React.FC = () => {
  const { authenticated, loading: authLoading } = useAuth();
  const { success, error, info } = useToast();

  const [activeTab, setActiveTab] = useState<'scheduled' | 'sent' | 'search'>('scheduled');
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [isSendersOpen, setIsSendersOpen] = useState(false);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [sentLogs, setSentLogs] = useState<SearchResultItem[]>([]);
  const [failedLogs, setFailedLogs] = useState<SearchResultItem[]>([]);
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);

  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingSent, setLoadingSent] = useState(false);
  const [slackLoading, setSlackLoading] = useState(false);

  // Check URL params for Slack OAuth return
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('slack') === 'connected') {
      success('Slack workspace integrated successfully!', 'Slack Connected');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [success]);

  // Load Senders
  const loadSenders = useCallback(async () => {
    try {
      const res = await senderApi.list();
      setSenders(Array.isArray(res) ? res : []);
    } catch (err: any) {
      console.error('Failed to load senders:', err);
    }
  }, []);

  // Load Campaigns (Scheduled)
  const loadCampaigns = useCallback(async () => {
    try {
      setLoadingCampaigns(true);
      const res = await campaignApi.list();
      setCampaigns(Array.isArray(res) ? res : (res as any)?.campaigns || []);
    } catch (err: any) {
      error(err.message || 'Failed to fetch campaigns');
    } finally {
      setLoadingCampaigns(false);
    }
  }, [error]);

  // Load Sent Logs (via Elasticsearch Search API with status=sent and status=failed)
  const loadSentLogs = useCallback(async () => {
    try {
      setLoadingSent(true);
      const [sentRes, failedRes] = await Promise.all([
        emailApi.search({ status: 'sent', limit: 100 }).catch(() => ({ results: [] })),
        emailApi.search({ status: 'failed', limit: 100 }).catch(() => ({ results: [] })),
      ]);
      setSentLogs(sentRes.results || []);
      setFailedLogs(failedRes.results || []);
    } catch (err: any) {
      console.error('Failed to fetch sent logs:', err);
    } finally {
      setLoadingSent(false);
    }
  }, []);

  // Load Slack Status
  const loadSlackStatus = useCallback(async () => {
    try {
      const res = await slackApi.getStatus();
      setSlackStatus(res);
    } catch {
      setSlackStatus({ connected: false });
    }
  }, []);

  // Initial Load on Auth
  useEffect(() => {
    if (authenticated) {
      loadSenders();
      loadCampaigns();
      loadSentLogs();
      loadSlackStatus();
    }
  }, [authenticated, loadSenders, loadCampaigns, loadSentLogs, loadSlackStatus]);

  const handleSlackConnect = () => {
    window.location.href = slackApi.getConnectUrl();
  };

  const handleSlackDisconnect = async () => {
    try {
      setSlackLoading(true);
      await slackApi.disconnect();
      info('Slack workspace disconnected.');
      await loadSlackStatus();
    } catch (err: any) {
      error(err.message || 'Failed to disconnect Slack');
    } finally {
      setSlackLoading(false);
    }
  };

  // Auth Loading View
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-slate-400 font-medium tracking-wide">Authenticating ReachInbox session...</p>
        </div>
      </div>
    );
  }

  // Unauthenticated Login View
  if (!authenticated) {
    return <LoginView />;
  }

  // Computed summary metrics
  const scheduledCount = campaigns.filter(
    (c) => c.status === 'scheduled' || (c.scheduled_at && new Date(c.scheduled_at).getTime() > Date.now())
  ).length;
  const sentCount = sentLogs.length;
  const failedCount = failedLogs.length;
  const totalRecipientsCount = sentCount + failedCount + campaigns.reduce((acc, c) => acc + (c.recipients?.length || 1), 0);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans selection:bg-indigo-600 selection:text-white">
      {/* Top Header */}
      <DashboardHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onComposeClick={() => setIsComposeOpen(true)}
        onOpenSenders={() => setIsSendersOpen(true)}
        slackStatus={slackStatus}
        onSlackConnect={handleSlackConnect}
        onSlackDisconnect={handleSlackDisconnect}
        slackLoading={slackLoading}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Compact Summary Metrics Bar */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <SummaryCard
            title="Scheduled"
            value={scheduledCount}
            icon={Calendar}
            color="indigo"
            description="Active & future queues"
          />
          <SummaryCard
            title="Sent"
            value={sentCount}
            icon={CheckCircle2}
            color="emerald"
            description="Delivered via Nodemailer"
          />
          <SummaryCard
            title="Failed"
            value={failedCount}
            icon={AlertCircle}
            color="rose"
            description="Attempted deliveries"
          />
          <SummaryCard
            title="Total Recipients"
            value={totalRecipientsCount}
            icon={Users}
            color="slate"
            description="Audience reached"
          />
        </section>

        {/* Tab Views */}
        {activeTab === 'scheduled' && (
          <ScheduledListView
            campaigns={campaigns}
            senders={senders}
            loading={loadingCampaigns}
            onRefresh={loadCampaigns}
            onComposeClick={() => setIsComposeOpen(true)}
          />
        )}

        {activeTab === 'sent' && (
          <SentListView
            logs={sentLogs}
            loading={loadingSent}
            onRefresh={loadSentLogs}
          />
        )}

        {activeTab === 'search' && <SearchView />}
      </main>

      {/* Compose Campaign Modal */}
      <ComposeEmailModal
        isOpen={isComposeOpen}
        onClose={() => setIsComposeOpen(false)}
        senders={senders}
        onSuccess={() => {
          loadCampaigns();
          loadSentLogs();
        }}
        onOpenSenders={() => setIsSendersOpen(true)}
      />

      {/* Senders Management Modal */}
      <SenderManagerModal
        isOpen={isSendersOpen}
        onClose={() => setIsSendersOpen(false)}
        senders={senders}
        onSendersUpdated={loadSenders}
      />
    </div>
  );
};
export default App;
