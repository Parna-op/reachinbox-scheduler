'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle2,
  ShieldAlert,
  AlertCircle,
} from 'lucide-react';
import {
  ApiError,
  disconnectSlack,
  fetchEmailStats,
  fetchEmails,
  fetchMe,
  fetchSenders,
  logout,
  searchEmails,
} from '@/lib/api';
import type {
  EmailJobItem,
  EmailStatusCounts,
  SenderAccount,
  SlackStatus,
  UserProfile,
} from '@/lib/types';
import { ComposeModal } from '@/components/ComposeModal';
import { EmailTable } from '@/components/EmailTable';
import { useToast } from '@/components/ToastProvider';
import { TopHeader } from '@/components/TopHeader';

const PAGE_SIZE = 20;

const EMPTY_COUNTS: EmailStatusCounts = {
  scheduled: 0,
  processing: 0,
  rate_limited: 0,
  sent: 0,
  failed: 0,
};

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [slack, setSlack] = useState<SlackStatus>({
    connected: false,
    teamName: null,
    channelName: null,
    updatedAt: null,
  });
  const [senders, setSenders] = useState<SenderAccount[]>([]);

  const [activeTab, setActiveTab] = useState<'scheduled' | 'sent'>('scheduled');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<EmailJobItem[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<EmailStatusCounts>(EMPTY_COUNTS);
  const [tableLoading, setTableLoading] = useState(true);
  const [searchEngine, setSearchEngine] = useState<string | null>(null);

  const [composeOpen, setComposeOpen] = useState(false);

  // Handle Slack OAuth redirect query feedback
  useEffect(() => {
    const slackParam = searchParams.get('slack');
    if (slackParam === 'connected') {
      showToast({
        variant: 'success',
        title: 'Slack connected',
        description: 'Live rate-limit notifications are now active.',
      });
      router.replace('/dashboard');
    } else if (slackParam === 'error') {
      const reason = searchParams.get('reason') || 'Unknown error';
      showToast({
        variant: 'error',
        title: 'Slack connection failed',
        description: reason.replace(/_/g, ' '),
      });
      router.replace('/dashboard');
    }
  }, [searchParams, router, showToast]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Bootstrap session + senders
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const [meData, sendersData] = await Promise.all([fetchMe(), fetchSenders()]);
        if (cancelled) return;
        setUser(meData.user);
        setSlack(meData.slack);
        setSenders(sendersData.senders);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace('/login');
          return;
        }
        showToast({
          variant: 'error',
          title: 'Failed to load profile',
          description: err instanceof Error ? err.message : 'Unexpected error',
        });
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [router, showToast]);

  const loadEmails = useCallback(
    async (silent = false) => {
      if (!user) return;
      if (!silent) setTableLoading(true);

      try {
        if (debouncedQuery.length > 0) {
          const [searchRes, statsRes] = await Promise.all([
            searchEmails({
              q: debouncedQuery,
              tab: activeTab,
              page,
              limit: PAGE_SIZE,
            }),
            fetchEmailStats(),
          ]);
          setItems(searchRes.items);
          setTotal(searchRes.total);
          setCounts(statsRes.counts);
          setSearchEngine(searchRes.searchEngine);
        } else {
          const res = await fetchEmails({
            tab: activeTab,
            page,
            limit: PAGE_SIZE,
          });
          setItems(res.items);
          setTotal(res.total);
          setCounts(res.counts);
          setSearchEngine(null);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace('/login');
          return;
        }
        showToast({
          variant: 'error',
          title: 'Failed to load emails',
          description: err instanceof Error ? err.message : 'Unexpected error',
        });
      } finally {
        setTableLoading(false);
      }
    },
    [user, debouncedQuery, activeTab, page, router, showToast],
  );

  useEffect(() => {
    if (user) {
      void loadEmails();
    }
  }, [user, loadEmails]);

  // Light polling every 8 seconds so scheduled -> sent / rate_limited updates live
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      void loadEmails(true);
    }, 8000);
    return () => clearInterval(interval);
  }, [user, loadEmails]);

  const handleDisconnectSlack = async () => {
    try {
      const updated = await disconnectSlack();
      setSlack(updated);
      showToast({
        variant: 'info',
        title: 'Slack disconnected',
        description: 'Rate-limit Slack alerts are paused until you reconnect.',
      });
    } catch (err) {
      showToast({
        variant: 'error',
        title: 'Could not disconnect Slack',
        description: err instanceof Error ? err.message : 'Unexpected error',
      });
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      router.replace('/login');
    } catch {
      router.replace('/login');
    }
  };

  const handleTabChange = (nextTab: 'scheduled' | 'sent') => {
    setActiveTab(nextTab);
    setPage(1);
  };

  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
          <p className="text-sm font-medium text-slate-600">Loading your workspace...</p>
        </div>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const scheduledTabTotal = counts.scheduled + counts.processing + counts.rate_limited;
  const sentTabTotal = counts.sent + counts.failed;

  return (
    <div className="min-h-screen bg-slate-50">
      <TopHeader
        user={user}
        slack={slack}
        onDisconnectSlack={handleDisconnectSlack}
        onLogout={handleLogout}
      />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Top Action Row */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Outreach Queue</h2>
            <p className="text-sm text-slate-500">
              Monitor scheduled batches, rate-limit rescheduling, and Ethereal SMTP deliveries.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setComposeOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            Compose New Email
          </button>
        </div>

        {/* Summary Stats */}
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Scheduled</span>
              <Clock className="h-4 w-4 text-indigo-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-slate-900">
              {(counts.scheduled + counts.processing).toLocaleString()}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Rate Limited</span>
              <ShieldAlert className="h-4 w-4 text-amber-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-amber-700">
              {counts.rate_limited.toLocaleString()}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Sent</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-emerald-700">
              {counts.sent.toLocaleString()}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Failed</span>
              <AlertCircle className="h-4 w-4 text-rose-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-rose-700">
              {counts.failed.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Table Card */}
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
            {/* Tabs */}
            <div className="inline-flex rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => handleTabChange('scheduled')}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
                  activeTab === 'scheduled'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Scheduled Emails ({scheduledTabTotal.toLocaleString()})
              </button>
              <button
                type="button"
                onClick={() => handleTabChange('sent')}
                className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
                  activeTab === 'sent'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sent Emails ({sentTabTotal.toLocaleString()})
              </button>
            </div>

            {/* Search + Refresh */}
            <div className="flex flex-1 items-center justify-end gap-2.5 sm:max-w-md">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={`Search ${activeTab} emails by recipient, subject, or body...`}
                  className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <button
                type="button"
                onClick={() => void loadEmails()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>
          </div>

          {searchEngine && (
            <div className="border-b border-slate-100 bg-slate-50/60 px-6 py-1.5 text-[11px] text-slate-500">
              Search powered by{' '}
              <span className="font-semibold text-slate-700">
                {searchEngine === 'elasticsearch' ? 'Elasticsearch' : 'PostgreSQL fallback'}
              </span>{' '}
              • {total.toLocaleString()} result{total === 1 ? '' : 's'}
            </div>
          )}

          <EmailTable
            tab={activeTab}
            items={items}
            loading={tableLoading}
            searchQuery={debouncedQuery}
            onComposeClick={() => setComposeOpen(true)}
          />

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-slate-200 px-6 py-3 text-xs text-slate-600">
              <span>
                Page {page} of {totalPages} ({total.toLocaleString()} total)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Prev
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      <ComposeModal
        isOpen={composeOpen}
        senders={senders}
        onSenderCreated={(sender) =>
          setSenders((prev) => {
            const exists = prev.some((s) => s.id === sender.id);
            return exists ? prev : [sender, ...prev];
          })
        }
        onClose={() => setComposeOpen(false)}
        onScheduled={async () => {
          setActiveTab('scheduled');
          setPage(1);
          const [sendersData] = await Promise.all([fetchSenders(), loadEmails()]);
          setSenders(sendersData.senders);
        }}
      />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
