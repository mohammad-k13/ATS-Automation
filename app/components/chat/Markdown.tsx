'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Markdown for AI answers: GFM tables/lists, no raw HTML, links open in a new tab. */
export default function Markdown({ text }: { text: string }) {
    return (
        <div className="md" dir="auto">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer">
                            {children}
                        </a>
                    ),
                    table: ({ children }) => (
                        <div className="md-table">
                            <table>{children}</table>
                        </div>
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
