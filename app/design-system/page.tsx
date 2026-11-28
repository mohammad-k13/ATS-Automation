import { Button } from '@/components/ui/button';

export default function DesignSystemPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8" dir="rtl" lang="fa">
      <h1 className="text-2xl font-bold">نمونه اجزای سامانه</h1>
      <p className="text-muted-foreground">
        راه‌اندازی Tailwind CSS و اجزای shadcn/ui با پشتیبانی راست‌چین.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button>دکمه اصلی</Button>
        <Button variant="outline">دکمه حاشیه‌دار</Button>
      </div>
    </main>
  );
}
