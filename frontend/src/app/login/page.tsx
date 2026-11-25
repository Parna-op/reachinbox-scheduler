'use client';

import React, { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MailCheck, ShieldCheck, Zap, Clock, AlertCircle } from 'lucide-react';
import { fetchMe, getGoogleLoginUrl } from '@/lib/api';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');

  useEffect(() => {
    fetchMe()
      .then(() => router.replace('/dashboard'))
      .catch(() => {
        // Stay on login screen when unauthenticated
      });
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-indigo-50/40 to-slate-100 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/60">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
            <MailCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">ReachInbox Scheduler</h1>
            <p className="text-xs text-slate-500">Distributed BullMQ Email Orchestrator</p>
          </div>
        </div>

        <p className="mb-6 text-sm text-slate-600">
          Sign in with your Google Workspace account to schedule campaigns, manage Ethereal SMTP
          senders, and receive real-time Slack rate-limit alerts.
        </p>

        {oauthError && (
          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div>
              <p className="font-semibold">Google Sign-In Error</p>
              <p className="mt-0.5 opacity-90">{oauthError.replace(/_/g, ' ')}</p>
            </div>
          </div>
        )}

        <a
          href={getGoogleLoginUrl()}
          className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-800 shadow-xs transition hover:bg-slate-50 hover:border-slate-400"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
            />
            <path
              fill="#FBBC05"
              d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
            />
          </svg>
          Continue with Google
        </a>

        <div className="mt-7 grid grid-cols-3 gap-3 border-t border-slate-100 pt-5 text-center">
          <div>
            <Clock className="mx-auto mb-1 h-4 w-4 text-indigo-600" />
            <p className="text-[11px] font-medium text-slate-600">BullMQ Delays</p>
          </div>
          <div>
            <ShieldCheck className="mx-auto mb-1 h-4 w-4 text-emerald-600" />
            <p className="text-[11px] font-medium text-slate-600">Hourly Limits</p>
          </div>
          <div>
            <Zap className="mx-auto mb-1 h-4 w-4 text-amber-600" />
            <p className="text-[11px] font-medium text-slate-600">1,000+ Leads</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
