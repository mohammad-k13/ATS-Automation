import type { Metadata } from 'next';
import './globals.css';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import { CacheProvider } from './lib/cache';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'سامانه جذب', description: 'غربالگری هوشمند رزومه‌ها' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="fa" dir="rtl" suppressHydrationWarning>
            <head>
                {/* apply the saved theme before first paint */}
                <script
                    dangerouslySetInnerHTML={{
                        __html: `try{var t=localStorage.getItem("ats-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`,
                    }}
                />
            </head>
            <body>
                <CacheProvider>
                    <div className="shell">
                        <Sidebar />
                        <div className="main-col">
                            <Header />
                            <main className="content">{children}</main>
                        </div>
                    </div>
                </CacheProvider>
            </body>
        </html>
    );
}
