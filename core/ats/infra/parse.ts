import type { ResumeFile } from '../domain/types';

export async function resumeToText(file: ResumeFile): Promise<string> {
  const name = file.filename.toLowerCase();
  const ct = (file.contentType ?? '').toLowerCase();
  const head = Buffer.from(file.data.slice(0, 5)).toString('latin1');

  if (head.startsWith('%PDF') || name.endsWith('.pdf') || ct.includes('pdf')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: file.data });
    try {
      return (await parser.getText()).text.trim();
    } finally {
      await parser.destroy();
    }
  }
  if (head.startsWith('PK') || name.endsWith('.docx') || ct.includes('wordprocessingml')) {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer: Buffer.from(file.data) })).value.trim();
  }
  const text = Buffer.from(file.data).toString('utf8');
  // HTML resume page -> strip tags
  return /<html|<body|<div/i.test(text)
    ? text
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : text.trim();
}
