'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { X, Upload, Sparkles, Send, FileText, AlertTriangle } from 'lucide-react';
import { provisionEtherealSender, scheduleEmails } from '@/lib/api';
import { parseLeadsFromText } from '@/lib/leadParser';
import type { SenderAccount } from '@/lib/types';
import { useToast } from './ToastProvider';

interface ComposeModalProps {
  isOpen: boolean;
  senders: SenderAccount[];
  onSenderCreated: (sender: SenderAccount) => void;
  onClose: () => void;
  onScheduled: () => Promise<void>;
}

function toLocalDateTimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ComposeModal({
  isOpen,
  senders,
  onSenderCreated,
  onClose,
  onScheduled,
}: ComposeModalProps) {
  const { showToast } = useToast();

  const [senderId, setSenderId] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [startTimeLocal, setStartTimeLocal] = useState(() =>
    toLocalDateTimeInputValue(new Date(Date.now() + 60_000)),
  );
  const [delayBetweenMs, setDelayBetweenMs] = useState('2000');
  const [hourlyLimit, setHourlyLimit] = useState('100');
  const [rawLeadsText, setRawLeadsText] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [campaignKey, setCampaignKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (isOpen) {
      setCampaignKey(crypto.randomUUID());
      setStartTimeLocal(toLocalDateTimeInputValue(new Date(Date.now() + 60_000)));
    }
  }, [isOpen]);

  useEffect(() => {
    if (!senderId && senders.length > 0) {
      const def = senders.find((s) => s.isDefault) ?? senders[0];
      setSenderId(def.id);
    }
  }, [senders, senderId]);

  const parsedLeads = useMemo(() => parseLeadsFromText(rawLeadsText), [rawLeadsText]);

  if (!isOpen) return null;

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setUploadedFileName(file.name);
      setRawLeadsText(text);
    } catch {
      showToast({
        variant: 'error',
        title: 'Failed to read file',
        description: 'Please upload a valid UTF-8 CSV or text file.',
      });
    }
  };

  const handleProvisionEthereal = async () => {
    setProvisioning(true);
    try {
      const { sender } = await provisionEtherealSender();
      onSenderCreated(sender);
      setSenderId(sender.id);
      showToast({
        variant: 'success',
        title: 'Ethereal sender ready',
        description: `Configured ${sender.email}`,
      });
    } catch (err) {
      showToast({
        variant: 'error',
        title: 'Could not provision Ethereal sender',
        description: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setProvisioning(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (parsedLeads.emails.length === 0) {
      showToast({
        variant: 'error',
        title: 'No valid recipients detected',
        description: 'Upload a CSV/text file or paste at least one valid email address.',
      });
      return;
    }

    setSubmitting(true);
    try {
      const startTimeIso = startTimeLocal ? new Date(startTimeLocal).toISOString() : undefined;

      const result = await scheduleEmails({
        senderId: senderId || undefined,
        subject: subject.trim(),
        body: body.trim(),
        recipients: parsedLeads.emails,
        startTime: startTimeIso,
        delayBetweenMs: Number(delayBetweenMs) || 2000,
        hourlyLimit: Number(hourlyLimit) || 100,
        idempotencyKey: campaignKey,
      });

      showToast({
        variant: 'success',
        title: `Scheduled ${result.scheduledCount} email${result.scheduledCount === 1 ? '' : 's'}`,
        description: `Sender: ${result.sender.email} • Delay: ${result.delayBetweenMs}ms • Limit: ${result.hourlyLimit}/hr`,
      });

      setSubject('');
      setBody('');
      setRawLeadsText('');
      setUploadedFileName(null);
      await onScheduled();
      onClose();
    } catch (err) {
      showToast({
        variant: 'error',
        title: 'Scheduling failed',
        description: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Compose New Email Campaign</h2>
            <p className="text-xs text-slate-500">
              Schedule single or bulk (1,000+) emails with Redis rate limiting & staggered delays
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          {/* Sender selector */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Sender Account (Ethereal SMTP)
              </label>
              <button
                type="button"
                onClick={handleProvisionEthereal}
                disabled={provisioning}
                className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {provisioning ? 'Provisioning...' : 'Provision New Ethereal Account'}
              </button>
            </div>
            <select
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              {senders.length === 0 ? (
                <option value="">Auto-provision Ethereal sender on submit</option>
              ) : (
                senders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} &lt;{s.email}&gt; {s.isDefault ? '(Default)' : ''}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Subject */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Subject
            </label>
            <input
              type="text"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Quick question about your Q4 outbound workflow"
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          {/* Body */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Email Body
            </label>
            <textarea
              required
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi there,&#10;&#10;Wanted to share how teams automate outreach..."
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          {/* Timing & Rate Limiting */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                Start Time
              </label>
              <input
                type="datetime-local"
                value={startTimeLocal}
                onChange={(e) => setStartTimeLocal(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                Delay Between (ms)
              </label>
              <input
                type="number"
                min={0}
                step={100}
                value={delayBetweenMs}
                onChange={(e) => setDelayBetweenMs(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                Hourly Limit
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
            </div>
          </div>

          {/* CSV / Text Lead Upload */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Recipients (CSV / Text Upload or Paste)
              </label>
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
                {parsedLeads.emails.length.toLocaleString()} detected lead
                {parsedLeads.emails.length === 1 ? '' : 's'}
              </span>
            </div>

            <label className="mb-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-center transition hover:border-indigo-400 hover:bg-indigo-50/40">
              <Upload className="mb-1.5 h-5 w-5 text-indigo-600" />
              <span className="text-xs font-semibold text-slate-700">
                {uploadedFileName ? (
                  <span className="inline-flex items-center gap-1 text-indigo-700">
                    <FileText className="h-3.5 w-3.5" />
                    {uploadedFileName}
                  </span>
                ) : (
                  'Click to upload CSV or .txt file of lead emails'
                )}
              </span>
              <span className="mt-0.5 text-[11px] text-slate-500">
                Supports comma, semicolon, tab, or newline-separated leads (1,000+ supported)
              </span>
              <input
                type="file"
                accept=".csv,.txt,.tsv,text/csv,text/plain"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>

            <textarea
              rows={3}
              value={rawLeadsText}
              onChange={(e) => setRawLeadsText(e.target.value)}
              placeholder="alice@acme.com&#10;bob@startup.io, carol@enterprise.org"
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2 font-mono text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />

            {(parsedLeads.duplicateCount > 0 || parsedLeads.invalidCount > 0) && (
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {parsedLeads.duplicateCount > 0 && (
                  <span>{parsedLeads.duplicateCount} duplicate(s) removed</span>
                )}
                {parsedLeads.invalidCount > 0 && (
                  <span>{parsedLeads.invalidCount} malformed address(es) ignored</span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || parsedLeads.emails.length === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {submitting
                ? 'Scheduling...'
                : `Schedule ${parsedLeads.emails.length.toLocaleString()} Email${parsedLeads.emails.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
