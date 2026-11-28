'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { Status } from './lib/api';
import { useApi } from './lib/cache';

export default function Home() {
    const router = useRouter();
    const { data: s, error } = useApi<Status>('status');
    useEffect(() => {
        if (s?.platforms[0]) router.replace(`/p/${s.platforms[0].name}`);
    }, [s, router]);
    if (error) return <div className="notice bad">{error.message}</div>;
    if (s && !s.platforms.length)
        return (
            <div className="empty">
                {s.sourcesError ?? 'هیچ پلتفرمی فعال نیست. از «تنظیمات و اتصال‌ها» یک پلتفرم فعال کنید.'}
            </div>
        );
    return null;
}
