'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { fetchMe } from '@/lib/api';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    fetchMe()
      .then(() => router.replace('/dashboard'))
      .catch(() => router.replace('/login'));
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        <p className="text-sm font-medium text-slate-600">Loading ReachInbox Scheduler...</p>
      </div>
    </div>
  );
}
