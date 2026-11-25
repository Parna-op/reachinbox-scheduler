'use client';

import React, { useState } from 'react';
import { LogOut, MailCheck, Activity, Hash, Unplug } from 'lucide-react';
import { getBullBoardUrl, getSlackConnectUrl } from '@/lib/api';
import type { SlackStatus, UserProfile } from '@/lib/types';

interface TopHeaderProps {
  user: UserProfile;
  slack: SlackStatus;
  onDisconnectSlack: () => Promise<void>;
  onLogout: () => Promise<void>;
}

export function TopHeader({ user, slack, onDisconnectSlack, onLogout }: TopHeaderProps) {
  const [slackBusy, setSlackBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [imgError, setImgError] = useState(false);

  const initials = user.name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const handleSlackClick = async () => {
    if (slack.connected) {
      setSlackBusy(true);
      try {
        await onDisconnectSlack();
      } finally {
        setSlackBusy(false);
      }
    } else {
      window.location.href = getSlackConnectUrl();
    }
  };

  const handleLogoutClick = async () => {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
            <MailCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-slate-900">
              ReachInbox Scheduler
            </h1>
            <p className="text-xs text-slate-500">BullMQ + Redis Rate-Limited Email Engine</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <a
            href={getBullBoardUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
          >
            <Activity className="h-3.5 w-3.5 text-indigo-600" />
            Queue Monitor
          </a>

          <button
            type="button"
            onClick={handleSlackClick}
            disabled={slackBusy}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-60 ${
              slack.connected
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {slack.connected ? (
              <>
                <Unplug className="h-3.5 w-3.5 text-emerald-600" />
                {slackBusy
                  ? 'Disconnecting...'
                  : `Disconnect Slack${slack.teamName ? ` (${slack.teamName})` : ''}`}
              </>
            ) : (
              <>
                <Hash className="h-3.5 w-3.5 text-indigo-600" />
                Connect Slack
              </>
            )}
          </button>

          <div className="flex items-center gap-2.5 rounded-full border border-slate-200 bg-slate-50 py-1 pl-1.5 pr-3">
            {user.avatarUrl && !imgError ? (
              <img
                src={user.avatarUrl}
                alt={user.name}
                onError={() => setImgError(true)}
                className="h-7 w-7 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                {initials}
              </div>
            )}
            <div className="hidden text-left sm:block">
              <p className="text-xs font-semibold leading-tight text-slate-900">{user.name}</p>
              <p className="text-[11px] leading-tight text-slate-500">{user.email}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogoutClick}
            disabled={loggingOut}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 disabled:opacity-60"
          >
            <LogOut className="h-3.5 w-3.5" />
            {loggingOut ? 'Logging out...' : 'Logout'}
          </button>
        </div>
      </div>
    </header>
  );
}
