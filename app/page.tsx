"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Status } from "./lib/api";

export default function Home() {
  const router = useRouter();
  const [msg, setMsg] = useState("در حال بارگذاری…");
  useEffect(() => {
    api<Status>("status")
      .then((s) => {
        if (s.platforms[0]) router.replace(`/p/${s.platforms[0].name}`);
        else setMsg(s.sourcesError ?? "هیچ پلتفرمی فعال نیست. از «منابع و توکن‌ها» یک پلتفرم فعال کنید.");
      })
      .catch((e) => setMsg(e.message));
  }, [router]);
  return <div className="empty">{msg}</div>;
}
