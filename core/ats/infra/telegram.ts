import { FormData } from 'undici';
import { httpFetch } from '../../shared/http';
import type { Application, ResumeFile, ScoreResult } from '../domain/types';
import { escapeHtml, sleep } from '../../shared/util';

export interface Notifier {
  sendAccepted(app: Application, r: ScoreResult, file: ResumeFile | null): Promise<void>;
  sendText(text: string): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  constructor(
    private token: string,
    private chatId: string,
    private proxy?: string,
  ) {}

  private async call(method: string, body: FormData | Record<string, unknown>) {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    for (let attempt = 0; ; attempt++) {
      const isForm = body instanceof FormData;
      const res = await httpFetch(
        url,
        {
          method: 'POST',
          body: isForm ? body : JSON.stringify(body),
          headers: isForm ? undefined : { 'content-type': 'application/json' },
        },
        this.proxy,
      );
      const json: any = await res.json().catch(() => ({}));
      if (json.ok) return json.result;
      if (res.status === 429 && attempt < 3) {
        await sleep(((json.parameters?.retry_after as number) ?? 3) * 1000);
        continue;
      }
      throw new Error(`Telegram ${method} failed: ${res.status} ${json.description ?? ''}`);
    }
  }

  async sendText(text: string) {
    // Telegram limit 4096 chars
    for (let i = 0; i < text.length; i += 4000)
      await this.call('sendMessage', {
        chat_id: this.chatId,
        text: text.slice(i, i + 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
  }

  async sendAccepted(app: Application, r: ScoreResult, file: ResumeFile | null) {
    const caption = formatAccepted(app, r);
    if (file) {
      const fd = new FormData();
      fd.set('chat_id', this.chatId);
      fd.set('caption', caption.slice(0, 1024));
      fd.set('parse_mode', 'HTML');
      fd.set(
        'document',
        new Blob([new Uint8Array(file.data)], {
          type: file.contentType ?? 'application/octet-stream',
        }),
        file.filename,
      );
      await this.call('sendDocument', fd);
      if (caption.length > 1024) await this.sendText(caption);
    } else {
      await this.sendText(caption);
    }
  }
}

export function formatAccepted(app: Application, r: ScoreResult): string {
  const e = escapeHtml;
  const lines = [
    `✅ <b>${e(app.name)}</b> — <b>${r.score}/100</b>`,
    `💼 ${e(app.jobTitle ?? '-')}  ·  ${e(app.source)}${r.yearsExperience != null ? `  ·  ${r.yearsExperience}y exp` : ''}`,
    r.summary ? `\n${e(r.summary)}` : '',
    r.matched.length ? `\n👍 ${e(r.matched.join(', '))}` : '',
    r.missing.length ? `👎 ${e(r.missing.join(', '))}` : '',
    r.redFlags.length ? `⚠️ ${e(r.redFlags.join('; '))}` : '',
    app.profileUrl ? `\n🔗 <a href="${e(app.profileUrl)}">Open application</a>` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Prints instead of sending (dry run / no Telegram configured). */
export class ConsoleNotifier implements Notifier {
  async sendAccepted(app: Application, r: ScoreResult, file: ResumeFile | null) {
    console.log(
      '\n--- [would send to Telegram] ---\n' +
        formatAccepted(app, r).replace(/<[^>]+>/g, '') +
        (file ? `\n📎 ${file.filename}` : ''),
    );
  }
  async sendText(text: string) {
    console.log(
      '\n--- [would send to Telegram] ---\n' +
        text
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&'),
    );
  }
}
