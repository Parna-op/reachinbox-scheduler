'use client';

import React from 'react';
import { ExternalLink, AlertCircle, Clock, CheckCircle2, Loader2, ShieldAlert, Inbox } from 'lucide-react';
import type { EmailJobItem, EmailStatus } from '@/lib/types';

interface EmailTableProps {
  tab: 'scheduled' | 'sent';
  items: EmailJobItem[];
  loading: boolean;
  searchQuery: string;
  onComposeClick: () => void;
}

function StatusBadge({ status }: { status: EmailStatus }) {
  switch (status) {
    case 'scheduled':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-600/20">
          <Clock className="h-3 w-3" />
          Scheduled
        </span>
      );
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700 ring-1 ring-sky-600/20">
          <Loader2 className="h-3 w-3 animate-spin" />
          Processing
        </span>
      );
    case 'rate_limited':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-600/20">
          <ShieldAlert className="h-3 w-3" />
          Rate Limited
        </span>
      );
    case 'sent':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-600/20">
          <CheckCircle2 className="h-3 w-3" />
          Sent
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 ring-1 ring-rose-600/20">
          <AlertCircle className="h-3 w-3" />
          Failed
        </span>
      );
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function EmailTable({ tab, items, loading, searchQuery, onComposeClick }: EmailTableProps) {
  if (loading) {
    return (
      <div className="divide-y divide-slate-100">
        {Array.from({ length: 6 }).map((_, idx) => (
          <div key={idx} className="grid grid-cols-12 items-center gap-4 px-6 py-4 animate-pulse">
            <div className="col-span-4 h-4 rounded bg-slate-200" />
            <div className="col-span-4 h-4 rounded bg-slate-200" />
            <div className="col-span-2 h-4 rounded bg-slate-200" />
            <div className="col-span-2 h-6 rounded-full bg-slate-200" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
          <Inbox className="h-6 w-6" />
        </div>
        <h3 className="text-sm font-semibold text-slate-900">
          {searchQuery
            ? `No ${tab} emails match "${searchQuery}"`
            : tab === 'scheduled'
              ? 'No scheduled emails in queue'
              : 'No sent emails yet'}
        </h3>
        <p className="mt-1 max-w-sm text-xs text-slate-500">
          {searchQuery
            ? 'Try clearing or broadening your search query.'
            : tab === 'scheduled'
              ? 'Compose a new email or upload a CSV lead list to start scheduling.'
              : 'Emails will appear here as soon as the BullMQ worker delivers them.'}
        </p>
        {!searchQuery && tab === 'scheduled' && (
          <button
            type="button"
            onClick={onComposeClick}
            className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            Compose New Email
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-left">
        <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-6 py-3.5">Email</th>
            <th className="px-6 py-3.5">Subject</th>
            <th className="px-6 py-3.5">{tab === 'scheduled' ? 'Scheduled Time' : 'Sent Time'}</th>
            <th className="px-6 py-3.5">Status</th>
            {tab === 'sent' && <th className="px-6 py-3.5 text-right">Details</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white text-sm">
          {items.map((item) => (
            <tr key={item.id} className="transition hover:bg-slate-50/70">
              <td className="whitespace-nowrap px-6 py-4">
                <div className="font-medium text-slate-900">{item.recipient}</div>
                {item.sender && (
                  <div className="text-xs text-slate-400">via {item.sender.email}</div>
                )}
              </td>
              <td className="max-w-xs truncate px-6 py-4 text-slate-700" title={item.subject}>
                {item.subject}
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-xs text-slate-600">
                {tab === 'scheduled' ? formatDateTime(item.scheduledAt) : formatDateTime(item.sentAt)}
              </td>
              <td className="whitespace-nowrap px-6 py-4">
                <StatusBadge status={item.status} />
                {item.status === 'rate_limited' && item.error && (
                  <p className="mt-1 max-w-[220px] truncate text-[11px] text-amber-700" title={item.error}>
                    {item.error}
                  </p>
                )}
              </td>
              {tab === 'sent' && (
                <td className="whitespace-nowrap px-6 py-4 text-right text-xs">
                  {item.previewUrl ? (
                    <a
                      href={item.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-800"
                    >
                      Ethereal Preview
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : item.error ? (
                    <span className="inline-block max-w-[200px] truncate text-rose-600" title={item.error}>
                      {item.error}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
